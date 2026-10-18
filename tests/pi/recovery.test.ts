import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunSessionExecution } from '../../src/app/run-session-execution.js';
import { SessionRuntimeStore } from '../../src/core/session-runtime-store.js';
import { initialSessionRuntime } from '../../src/core/session-runtime-planning.js';
import { sessionAgent } from '../../src/core/session-planning.js';
import { resolveRuntime, type PiModelDescriptor } from '../../src/domain/session-runtime.js';
import type { SessionState } from '../../src/core/session-ports.js';
import type { AgentSession, Turn } from '../../src/domain/agents-api.js';
import type { RunRecord } from '../../src/domain/contracts.js';
import { NotFoundError } from '../../src/core/errors.js';
import { MemoryAgentsStore } from '../agents/fixtures.js';

const descriptor: PiModelDescriptor = { id: 'fixture', name: 'Fixture', provider: 'amazon-bedrock', api: 'bedrock-converse-stream', region: 'us-east-1', input: ['text'], reasoning: [], contextWindow: 1000, maxTokens: 100 };
async function fixture() {
  const store = new MemoryAgentsStore();
  const session: AgentSession = { id: 'session', object: 'agent.session', agent: sessionAgent({ model: 'fixture' }, 'agent', 100), environment: { type: 'none' }, created_at: 100, last_active_at: 100, status: 'in_progress', error: null, required_actions: [], usage: null, vault_ids: [], metadata: {} };
  const turn: Turn = { id: 'turn', object: 'agent.session.turn', session_id: session.id, agent_id: session.agent.id, subagent_id: null, status: 'in_progress', created_at: 100, started_at: 100, completed_at: null, error: null, usage: null };
  const state: SessionState = { session, runtime: resolveRuntime({ rat_things_runtime: 'pi' }, null, [descriptor]), turns: [{ turn, input: [] }], receipts: { initial: { digest: 'input', commands: [{ type: 'start', turnId: turn.id, input: [] }], dispatched: true } }, deletedArtifacts: [] };
  await store.put({ ownerId: 'owner', id: session.id, collection: 'sessions', createdAt: 100, revision: 1, value: state }, 0);
  const runtime = new SessionRuntimeStore(store);
  const run: RunRecord = { runId: 'agents:session:attempt:0', ownerId: 'owner', ownerCreated: 'owner#run', status: 'failed', createdAt: '', updatedAt: '', expiresAt: 10000, requestHash: '', sourceKind: 'api', input: { bucket: 'private', key: 'input', sha256: '' }, execution: { backend: 'microvm', id: 'vm', generation: 'generation' } };
  const runs = new Map<string, RunRecord>([[run.runId, run]]);
  await runtime.claim('owner', session.id, run.runId, 100, undefined, { phase: 'submitting', ordinal: 0, turnId: turn.id, failures: [], dueAt: 0 });
  await runtime.publish('owner', session.id, run.runId, { ...initialSessionRuntime(session.id, session.agent.id, 'root'), turns: [{ threadId: 'root', nativeTurnId: 'native', turn, items: [] }] });
  const submit = vi.fn(async (_owner: string, _request: unknown, options: { idempotencyKey?: string } = {}) => { const created = { ...run, runId: options.idempotencyKey!, status: 'queued' as const }; runs.set(created.runId, created); return created; });
  const stopped = vi.fn(async () => true);
  const abort = vi.fn(async () => ({ hasLiveTasks: false }));
  const repair = vi.fn(async () => ({ hasLiveTasks: true }));
  const execution = new RunSessionExecution({ store, sourceStopped: stopped, repairPi: repair, abortPi: abort,
    runs: { get: async (_owner, id) => { const value = runs.get(id); if (!value) throw new NotFoundError('missing'); return value; }, idFor: (_owner, key) => key, cancel: async () => run, submit },
    interaction: { events: async () => ({ runId: run.runId, active: true, ready: true, oldestSequence: 0, nextSequence: 0, events: [], pendingRequests: [] }), steer: async () => {}, interrupt: async () => {}, respond: async () => {} },
    artifacts: { getJson: async () => { throw new Error('Unexpected launch read'); }, putJson: async key => ({ bucket: 'private', key, sha256: 'fixture' }), getBytes: async () => new Uint8Array(), getStream: async () => { throw new Error('Unexpected stream'); } },
    environments: { prepare: async () => ({ type: 'none' }), state: async () => { throw new Error('Unexpected state'); }, retire: async () => {}, launchReference: async () => { throw new Error('Unexpected credential'); }, managedLaunch: async () => ({}), attachManaged: async () => {} },
    vaults: { requireVaults: async () => {} }, tools: { prepare: async () => {}, launch: async () => [], close: async () => {} },
  });
  return { store, session, turn, state, run, runs, runtime, submit, stopped, repair, abort, execution };
}
afterEach(() => vi.useRealTimers());
describe('Pi worker attempt recovery', () => {
  it('retains the outbox wakeup until termination is proven, then starts one replacement after backoff', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000);
    const f = await fixture(); f.stopped.mockResolvedValueOnce(false);
    await expect(f.execution.reconcile('owner', f.session)).rejects.toMatchObject({ status: 503 });
    expect(f.submit).not.toHaveBeenCalled();
    await expect(f.execution.reconcile('owner', f.session)).rejects.toMatchObject({ status: 503 });
    vi.setSystemTime(1_002_000);
    await f.execution.reconcile('owner', f.session);
    expect(f.submit).toHaveBeenCalledTimes(1);
    expect(f.submit.mock.calls[0]?.[2]).toMatchObject({ idempotencyKey: 'agents:session:attempt:1' });
    await f.execution.reconcile('owner', f.session); expect(f.submit).toHaveBeenCalledTimes(1);
  });
  it('never treats a missing previously submitted Run as termination, even before a native commit', async () => {
    const f = await fixture(); f.runs.clear();
    await expect(f.execution.start('owner', f.session, { turn: f.turn, input: [] })).rejects.toMatchObject({ status: 503 });
    await expect(f.execution.reconcile('owner', f.session)).rejects.toMatchObject({ status: 503 });
    expect(f.submit).not.toHaveBeenCalled();
  });
  it('resumes only a durably reserved initial attempt that has never been submitted', async () => {
    const f = await fixture(); f.runs.clear();
    const runtime = (await f.runtime.get('owner', f.session.id))!;
    await f.store.put({ ...runtime, revision: runtime.revision + 1, value: { ...runtime.value, attempt: { ...runtime.value.attempt!, phase: 'reserved' } } }, runtime.revision);
    await f.execution.start('owner', f.session, { turn: f.turn, input: [] });
    expect(f.submit.mock.calls[0]?.[2]).toMatchObject({ idempotencyKey: 'agents:session:attempt:0' });
  });
  it('recovers committed background work even when the projected root is complete', async () => {
    const f = await fixture();
    const saved = (await f.store.get<SessionState>('owner', 'sessions', f.session.id))!;
    await f.store.put({ ...saved, revision: 2, value: { ...saved.value, turns: [{ turn: { ...f.turn, status: 'completed' }, input: [] }] } }, 1);
    const runtime = (await f.runtime.get('owner', f.session.id))!;
    await f.runtime.publish('owner', f.session.id, f.run.runId, { ...runtime.value.snapshot!, turns: [{ ...runtime.value.snapshot!.turns[0]!, turn: { ...f.turn, status: 'completed' } }] });
    await expect(f.execution.reconcile('owner', f.session)).rejects.toMatchObject({ status: 503 });
    expect(f.repair).toHaveBeenCalled();
    expect((await f.runtime.get('owner', f.session.id))?.value.attempt?.dueAt).toBeGreaterThan(0);
  });
  it('keeps accepted steer, cancel, and function results retryable during worker recovery', async () => {
    const f = await fixture(); f.stopped.mockResolvedValue(false);
    await expect(f.execution.steer('owner', f.session, f.turn.id, [], 'steer')).rejects.toMatchObject({ status: 503 });
    await expect(f.execution.cancel('owner', f.session, f.turn.id)).rejects.toMatchObject({ status: 503 });
    await expect(f.execution.toolResult('owner', f.session, { type: 'agent.session.input.tool_result', turn_id: f.turn.id, call_id: 'call', success: true, output: 'result' })).rejects.toMatchObject({ status: 503 });
  });
  it('settles exhaustion once and fails accepted input that never reached native admission', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000);
    const f = await fixture(); const runtime = (await f.runtime.get('owner', f.session.id))!;
    await f.store.put({ ...runtime, revision: runtime.revision + 1, value: { ...runtime.value, snapshot: initialSessionRuntime(f.session.id, f.session.agent.id, 'root'), attempt: { ...runtime.value.attempt!, failures: [900, 950, 999] } } }, runtime.revision);
    await f.execution.reconcile('owner', f.session);
    expect(f.abort).toHaveBeenCalledTimes(1);
    expect((await f.runtime.get('owner', f.session.id))?.value.recoveryExhausted).toBe(true);
    const state = (await f.store.get<SessionState>('owner', 'sessions', f.session.id))!.value;
    expect(state.turns[0]?.turn).toMatchObject({ status: 'failed', error: { code: 'server_error' } });
    expect(state.receipts.initial?.failure?.code).toBe('recovery_exhausted');
    await f.execution.reconcile('owner', f.session); expect(f.abort).toHaveBeenCalledTimes(1);
  });
  it('clears an exhausted recovery budget for a legitimate new Turn claim', async () => {
    const f = await fixture(); const runtime = (await f.runtime.get('owner', f.session.id))!;
    await f.store.put({ ...runtime, revision: runtime.revision + 1, value: { ...runtime.value, recoveryExhausted: true, attempt: { ...runtime.value.attempt!, failures: [1, 2, 3] } } }, runtime.revision);
    await f.execution.start('owner', f.session, { turn: { ...f.turn, id: 'new-turn' }, input: [] });
    expect((await f.runtime.get('owner', f.session.id))?.value).toMatchObject({ recoveryExhausted: false, attempt: { failures: [], turnId: 'new-turn' } });
  });
});
