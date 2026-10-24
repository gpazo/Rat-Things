import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CodexRpcClient } from '../../src/adapters/codex-rpc.js';
import { AgentService } from '../../src/core/agent-service.js';
import { SessionService } from '../../src/core/session-service.js';
import type { SessionState } from '../../src/core/session-ports.js';
import { initialSessionRuntime, type SessionRuntimeState } from '../../src/core/session-runtime-planning.js';
import type { AgentSession, Turn } from '../../src/domain/agents-api.js';
import { LocalSessionExecution } from '../../src/runner/local-session-execution.js';
import { MemoryAgentsStore } from './fixtures.js';

const rpc = vi.hoisted(() => ({
  clients: 0, calls: [] as string[],
  initialize: undefined as (() => Promise<void>) | undefined,
  turn: undefined as (() => Promise<void>) | undefined,
}));
vi.mock('../../src/runner/local-codex.js', async original => ({
  ...await original<typeof import('../../src/runner/local-codex.js')>(),
  localCodexClient: (options: ConstructorParameters<typeof CodexRpcClient>[0]) => {
    const threadId = `thread_${++rpc.clients}`;
    return {
      initialize: async () => { await rpc.initialize?.(); },
      call: async (method: string) => {
        rpc.calls.push(method);
        if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: threadId } };
        if (method === 'turn/start') {
          await rpc.turn?.();
          const id = `native_${rpc.calls.length}`;
          options.onEvent?.({ method: 'turn/started', params: { threadId, turn: { id, status: 'inProgress' } } });
          return { turn: { id } };
        }
        return {};
      },
      close: async () => { options.onClose?.(); },
    };
  },
}));

const cleanups: Array<() => Promise<void>> = [];
const releases: Array<() => void> = [];
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  releases.push(release);
  return { promise, release };
}
beforeEach(() => { rpc.clients = 0; rpc.calls = []; rpc.initialize = undefined; rpc.turn = undefined; });
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  try { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); }
  finally { vi.restoreAllMocks(); }
});

async function fixture(maxSessions = 2) {
  const directory = await mkdtemp(join(tmpdir(), 'rat-session-recovery-'));
  const store = new MemoryAgentsStore();
  const executions: LocalSessionExecution[] = [];
  const replacement = () => {
    const execution = new LocalSessionExecution({ store, directory, maxSessions,
      hostCodex: () => ({ binary: '/fixture/unused-codex', environment: {} }) });
    executions.push(execution);
    return execution;
  };
  const execution = replacement();
  const sessions = new SessionService({ store, agents: new AgentService({ store }), execution });
  const create = async () => {
    const session = await sessions.create('owner', { agent: { model: 'fixture' }, environment: { type: 'none' }, input: 'Fixture input' });
    const binding = (await store.get<SessionState>('owner', 'sessions', session.id))!.value.turns[0]!;
    return { session, binding };
  };
  const runtime = (id: string) => store.get<SessionRuntimeState>('owner', 'local_runtime', id);
  const attempt = (id: string) => store.get<Turn>('owner', 'local_turn_attempts', id);
  const seedRuntime = async (session: AgentSession, turn: Turn) => {
    const active = { ...turn, status: 'in_progress' as const, started_at: 10, completed_at: null };
    const snapshot: SessionRuntimeState = {
      ...initialSessionRuntime(session.id, session.agent.id, 'old_thread'),
      turns: [
        { threadId: 'old_thread', nativeTurnId: 'old_native', turn: active, items: [{ id: 'message_old', turn_id: turn.id, type: 'message', role: 'assistant',
          content: [{ type: 'output_text', text: 'Partial output' }], phase: 'final_answer', status: 'in_progress' }],
          traceSteps: [{ id: 'trace_old', kind: 'tool', name: 'fixture', startedAt: 10 }] },
        { threadId: 'old_thread', nativeTurnId: 'done_native', turn: { ...active, id: 'turn_completed', status: 'completed', completed_at: 20 }, items: [] },
        { threadId: 'child_active', nativeTurnId: 'child_native', turn: { ...active, id: 'turn_child', agent_id: 'child_active', subagent_id: 'child_active' }, items: [] },
      ],
      subagents: [
        { id: 'child_active', object: 'agent.session.subagent', session_id: session.id, parent_agent_id: session.agent.id,
          name: null, instructions: null, opened_at: 10, closed_at: null, status: 'active' },
        { id: 'child_closed', object: 'agent.session.subagent', session_id: session.id, parent_agent_id: session.agent.id,
          name: null, instructions: null, opened_at: 10, closed_at: 20, status: 'closed' },
      ],
      requiredActions: [{ type: 'function_call', call_id: 'call_old', turn_id: turn.id, name: 'fixture', arguments: {} }],
    };
    await store.put({ ownerId: 'owner', collection: 'local_runtime', id: session.id, createdAt: session.created_at, revision: 1, value: snapshot }, 0);
    return snapshot;
  };
  const seedAttempt = (turn: Turn) => store.put({ ownerId: 'owner', collection: 'local_turn_attempts', id: turn.id,
    createdAt: turn.created_at, revision: 1, value: turn }, 0);
  cleanups.push(async () => {
    try { for (const current of executions) await current.shutdown(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  return { store, execution, sessions, create, replacement, runtime, attempt, seedRuntime, seedAttempt };
}
const starts = () => rpc.calls.filter(method => method === 'turn/start').length;

it('persists one recovered runtime before exposing it and retains timestamps across polling and a fresh executor', async () => {
  const f = await fixture();
  const { session, binding } = await f.create();
  await f.seedRuntime(session, binding.turn);
  const now = vi.spyOn(Date, 'now').mockReturnValue(100_000);
  const first = await f.sessions.turn('owner', session.id, binding.turn.id);
  const recovered = await f.runtime(session.id);
  expect(first).toMatchObject({ status: 'failed', completed_at: 100, error: { code: 'connection_failed' } });
  expect(recovered?.revision).toBe(2);
  expect(recovered?.value.turns[0]!.turn).toEqual(first);
  expect(recovered?.value.turns[0]!.items[0]).toMatchObject({ status: 'incomplete', content: [{ type: 'output_text', text: 'Partial output' }] });
  expect(recovered?.value.turns[1]!.turn.completed_at).toBe(20);
  expect(recovered?.value.turns[2]!.turn).toMatchObject({ status: 'failed', completed_at: 100 });
  expect(recovered?.value.subagents.map(agent => agent.closed_at)).toEqual([100, 20]);
  expect(recovered?.value.requiredActions).toEqual([]);
  now.mockReturnValue(200_000);
  for (let poll = 0; poll < 3; poll++) {
    expect(await f.sessions.turn('owner', session.id, binding.turn.id)).toEqual(first);
    expect((await f.sessions.turns('owner', session.id)).data.find(turn => turn.id === binding.turn.id)).toEqual(first);
    expect(await f.execution.items('owner', session, binding.turn.id)).toEqual(recovered!.value.turns[0]!.items);
    expect(await f.execution.traceSteps('owner', session, binding.turn.id)).toEqual(recovered!.value.turns[0]!.traceSteps);
    expect((await f.execution.subagents('owner', session))[0]!.subagent.closed_at).toBe(100);
  }
  const fresh = f.replacement();
  expect((await fresh.observe('owner', session, binding.turn)).turn).toEqual(first);
  expect(await f.runtime(session.id)).toEqual(recovered);
  expect(rpc.clients).toBe(0);
});

it('persists an orphan accepted attempt once and reuses it across polls and executor replacement', async () => {
  const f = await fixture();
  const { session, binding } = await f.create();
  await f.seedAttempt(binding.turn);
  const now = vi.spyOn(Date, 'now').mockReturnValue(100_000);
  const first = await f.execution.observe('owner', session, binding.turn);
  expect(first.turn).toMatchObject({ status: 'failed', completed_at: 100 });
  const recovered = await f.attempt(binding.turn.id);
  expect(recovered).toMatchObject({ revision: 2, value: first.turn });
  now.mockReturnValue(200_000);
  expect(await f.execution.observe('owner', session, binding.turn)).toEqual(first);
  expect(await f.replacement().observe('owner', session, binding.turn)).toEqual(first);
  expect(await f.attempt(binding.turn.id)).toEqual(recovered);
});

it.each(['completed', 'failed', 'cancelled'] as const)('does not rewrite an already %s fallback attempt', async status => {
  const f = await fixture();
  const { session, binding } = await f.create();
  const terminal = { ...binding.turn, status, completed_at: 25 };
  await f.seedAttempt(terminal);
  vi.spyOn(Date, 'now').mockReturnValue(200_000);
  expect((await f.execution.observe('owner', session, binding.turn)).turn).toEqual(terminal);
  expect(await f.attempt(binding.turn.id)).toMatchObject({ revision: 1, value: terminal });
});

it('leaves an unaccepted Turn queued when no snapshot or attempt exists', async () => {
  const f = await fixture();
  const { session, binding } = await f.create();
  expect(await f.execution.observe('owner', session, binding.turn)).toEqual({ turn: binding.turn, requiredActions: [] });
  expect(await f.attempt(binding.turn.id)).toBeUndefined();
  expect(await f.runtime(session.id)).toBeUndefined();
});

it.each([
  ['local_runtime', false], ['local_runtime', true],
  ['local_turn_attempts', false], ['local_turn_attempts', true],
] as const)('fails closed after recovery storage failure in %s (committed: %s)', async (collection, committed) => {
  const f = await fixture();
  const { session, binding } = await f.create();
  if (collection === 'local_runtime') await f.seedRuntime(session, binding.turn);
  else await f.seedAttempt(binding.turn);
  const now = vi.spyOn(Date, 'now').mockReturnValue(100_000);
  const put = f.store.put.bind(f.store);
  const write = vi.spyOn(f.store, 'put').mockImplementation(async (resource, expected) => {
    if (resource.collection === collection) {
      if (committed) await put(resource, expected);
      throw new Error('Recovery write failed');
    }
    await put(resource, expected);
  });
  await expect(f.execution.observe('owner', session, binding.turn)).rejects.toThrow('Recovery write failed');
  expect(rpc.clients).toBe(0);
  write.mockRestore();
  now.mockReturnValue(200_000);
  const second = await f.execution.observe('owner', session, binding.turn);
  expect(second.turn).toMatchObject({ status: 'failed', completed_at: committed ? 100 : 200 });
  const stored = collection === 'local_runtime' ? await f.runtime(session.id) : await f.attempt(binding.turn.id);
  expect(stored?.revision).toBe(2);
  now.mockReturnValue(300_000);
  expect(await f.execution.observe('owner', session, binding.turn)).toEqual(second);
  expect(await f.replacement().observe('owner', session, binding.turn)).toEqual(second);
  expect(collection === 'local_runtime' ? await f.runtime(session.id) : await f.attempt(binding.turn.id)).toEqual(stored);
});

it('does not launch or accept new work when prelaunch runtime recovery cannot be stored', async () => {
  const f = await fixture();
  const { session, binding } = await f.create();
  await f.seedRuntime(session, { ...binding.turn, id: 'turn_old' });
  const put = f.store.put.bind(f.store);
  vi.spyOn(f.store, 'put').mockImplementation(async (resource, expected) => {
    if (resource.collection === 'local_runtime') throw new Error('Recovery unavailable');
    await put(resource, expected);
  });
  await expect(f.sessions.dispatch('owner', session.id)).rejects.toThrow('Recovery unavailable');
  expect(rpc.clients).toBe(0);
  expect(await f.attempt(binding.turn.id)).toBeUndefined();
  expect((await f.store.get<SessionState>('owner', 'sessions', session.id))!.value.receipts.initial?.dispatched).toBe(false);
});

it('finishes recovery before concurrent startup and does not overwrite the new runtime', async () => {
  const f = await fixture();
  const { session, binding } = await f.create();
  const old = { ...binding.turn, id: 'turn_old' };
  await f.seedRuntime(session, old);
  const blocked = gate();
  const reached = gate();
  const put = f.store.put.bind(f.store);
  vi.spyOn(f.store, 'put').mockImplementation(async (resource, expected) => {
    if (resource.collection === 'local_runtime' && expected === 1) { reached.release(); await blocked.promise; }
    await put(resource, expected);
  });
  const now = vi.spyOn(Date, 'now').mockReturnValue(100_000);
  const reading = f.execution.observe('owner', session, old);
  await reached.promise;
  const starting = f.execution.start('owner', session, binding);
  expect(rpc.clients).toBe(0);
  expect(await f.attempt(binding.turn.id)).toBeUndefined();
  now.mockReturnValue(200_000);
  blocked.release();
  const observation = await reading;
  await starting;
  expect(observation.turn.completed_at).toBe(100);
  expect(starts()).toBe(1);
  expect((await f.execution.observe('owner', session, old)).turn).toEqual(observation.turn);
  expect((await f.execution.observe('owner', session, binding.turn)).turn.status).toBe('in_progress');
  const stored = await f.runtime(session.id);
  expect(stored?.value.turns.find(entry => entry.turn.id === old.id)?.turn.completed_at).toBe(100);
  expect(stored?.value.turns.find(entry => entry.turn.id === binding.turn.id)?.turn.status).toBe('in_progress');
});

it.each(['initialize', 'turn'] as const)('keeps reads nonblocking while native %s is pending without failing its accepted Turn', async stage => {
  const f = await fixture();
  const { session, binding } = await f.create();
  const old = { ...binding.turn, id: 'turn_old' };
  await f.seedRuntime(session, old);
  const blocked = gate();
  const reached = gate();
  rpc[stage] = async () => { reached.release(); await blocked.promise; };
  const starting = f.execution.start('owner', session, binding);
  await reached.promise;
  let observed = false;
  const reading = Promise.all([
    f.execution.observe('owner', session, binding.turn),
    f.execution.observe('owner', session, old),
    f.execution.items('owner', session, old.id),
    f.execution.subagents('owner', session),
  ]).then(result => { observed = true; return result; });
  await vi.waitFor(() => expect(observed).toBe(true), { timeout: 500 });
  const [current, previous] = await reading;
  expect(current.turn.status).toBe('queued');
  expect(previous.turn.status).toBe('failed');
  expect((await f.attempt(binding.turn.id))?.value.status).toBe(stage === 'turn' ? 'queued' : undefined);
  blocked.release(); await starting;
  expect(starts()).toBe(1);
  expect((await f.execution.observe('owner', session, binding.turn)).turn.status).toBe('in_progress');
});

it('rechecks capacity after concurrent recovery reads before installing new runtimes', async () => {
  const f = await fixture(1);
  const first = await f.create();
  const second = await f.create();
  const blocked = gate();
  const bothReading = gate();
  let reads = 0;
  const get = f.store.get.bind(f.store);
  vi.spyOn(f.store, 'get').mockImplementation(async (owner, collection, id) => {
    if (collection === 'local_runtime' && reads < 2) {
      reads++;
      if (reads === 2) bothReading.release();
      await blocked.promise;
    }
    return get(owner, collection, id);
  });
  const outcomes = Promise.allSettled([
    f.execution.start('owner', first.session, first.binding),
    f.execution.start('owner', second.session, second.binding),
  ]);
  await bothReading.promise;
  expect(rpc.clients).toBe(0);
  blocked.release();
  const results = await outcomes;
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { status: 503, code: 'local_capacity' } });
  expect(rpc.clients).toBe(1);
  expect(starts()).toBe(1);
  const attempts = await Promise.all([f.attempt(first.binding.turn.id), f.attempt(second.binding.turn.id)]);
  expect(attempts.filter(Boolean)).toHaveLength(1);
});
