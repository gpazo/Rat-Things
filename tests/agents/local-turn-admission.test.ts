import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CodexRpcClient, CodexRpcEvent } from '../../src/adapters/codex-rpc.js';
import { AgentService } from '../../src/core/agent-service.js';
import { EnvironmentService } from '../../src/core/environment-service.js';
import { EnvironmentTemplateService } from '../../src/core/environment-template-service.js';
import { SessionService } from '../../src/core/session-service.js';
import type { SessionState } from '../../src/core/session-ports.js';
import type { SessionRuntimeState } from '../../src/core/session-runtime-planning.js';
import type { Turn } from '../../src/domain/agents-api.js';
import { managedCodexConfiguration } from '../../src/domain/codex-managed-policy.js';
import { LocalManagedEnvironment } from '../../src/runner/local-managed-environment.js';
import { LocalSessionExecution } from '../../src/runner/local-session-execution.js';
import { developmentLocalCodexHost } from '../../src/runner/local-codex.js';
import { MemoryAgentsStore } from './fixtures.js';
import { gate, nativeFixture, type FixtureMachine } from '../simulation/native-runtime-fixtures.js';

const rpc = vi.hoisted(() => ({ clients: [] as Array<{ initialize: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; emit(event: CodexRpcEvent): void }>,
  calls: [] as string[], initialize: undefined as (() => Promise<void>) | undefined,
  turn: undefined as (() => Promise<void>) | undefined,
  interrupt: undefined as (() => Promise<void>) | undefined }));
vi.mock('../../src/runner/local-codex.js', async original => ({ ...await original<typeof import('../../src/runner/local-codex.js')>(),
  localCodexClient: (options: ConstructorParameters<typeof CodexRpcClient>[0]) => {
    const index = rpc.clients.length;
    const client = { initialize: vi.fn(async () => { await rpc.initialize?.(); }), close: vi.fn(async () => {}),
      emit: (event: CodexRpcEvent) => options.onEvent?.(event),
      call: async (method: string) => {
        rpc.calls.push(method);
        if (method === 'config/read') return {
          config: managedCodexConfiguration({ workspace: '/workspace', network: { access: 'disabled', allowed_domains: [] }, credentialProxy: false }),
          layers: [{ name: { type: 'sessionFlags' }, config: {} },
            ...['user', 'system'].map(type => ({ name: { type, file: join(options.cwd!, type, 'config.toml') }, config: {} }))],
        };
        if (method === 'configRequirements/read') return { requirements: null };
        if (method === 'turn/start') { await rpc.turn?.(); return { turn: { id: `native_turn_${rpc.calls.length}` } }; }
        if (method === 'turn/interrupt') await rpc.interrupt?.();
        if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: `thread_${index}` } };
        return {};
      } };
    rpc.clients.push(client);
    return client;
  } }));
beforeEach(() => { rpc.clients.length = 0; rpc.calls.length = 0; rpc.initialize = undefined; rpc.turn = undefined; rpc.interrupt = undefined; });
afterEach(() => vi.restoreAllMocks());

async function services() {
  const native = await nativeFixture();
  const store = new MemoryAgentsStore();
  const environments = new EnvironmentService({ store, templates: new EnvironmentTemplateService({ store }),
    managedFiles: async () => { throw new Error('Fixture does not read files'); },
    credentials: { create: async () => { throw new Error('Fixture has no credentials'); }, read: async () => { throw new Error('Fixture has no credentials'); }, revoke: async () => {} } });
  const managed = new LocalManagedEnvironment({ store, environments, runtime: native.runtime, maxSessions: 2,
    hostCodex: developmentLocalCodexHost(native.directory, {}) });
  const execution = new LocalSessionExecution({ store, directory: native.directory, maxSessions: 2, managed, environment: {} });
  const sessions = new SessionService({ store, agents: new AgentService({ store }), execution });
  const create = async () => {
    const session = await sessions.create('owner', { agent: { model: 'fixture' }, environment: { type: 'openai_hosted' }, input: 'Fixture input' });
    const binding = (await store.get<SessionState>('owner', 'sessions', session.id))!.value.turns[0]!;
    return { session, binding };
  };
  return { ...native, store, environments, managed, execution, sessions, create,
    attempt: (id: string) => store.get<Turn>('owner', 'local_turn_attempts', id),
    claim: (id: string) => store.get('owner', 'local_prepared', id),
    state: async (id: string) => (await store.get<SessionState>('owner', 'sessions', id))!.value,
    async close() { try { await execution.shutdown(); } finally { await native.close(); } } };
}
const turnStarts = () => rpc.calls.filter(method => method === 'turn/start').length;

it('keeps two refused preparations queued without claims or accepted receipts and dispatches once after pressure clears', async () => {
  const fixture = await services();
  try {
    const { session, binding } = await fixture.create();
    fixture.facts.memoryPressure = 'critical';
    for (let attempt = 0; attempt < 2; attempt++) await expect(fixture.execution.start('owner', session, binding)).rejects.toMatchObject({ status: 503, code: 'local_memory_pressure' });
    expect(await fixture.claim(session.id)).toBeUndefined();
    expect(await fixture.attempt(binding.turn.id)).toBeUndefined();
    expect((await fixture.state(session.id)).receipts.initial?.dispatched).toBe(false);
    expect((await fixture.state(session.id)).turns[0]!.turn.status).toBe('queued');
    await expect(lstat(join(fixture.directory, 'native-proof', session.id))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(fixture.machines).toHaveLength(0);
    expect(rpc.clients).toHaveLength(0);
    fixture.facts.memoryPressure = 'normal';
    await fixture.sessions.dispatch('owner', session.id);
    const claim = await fixture.claim(session.id);
    expect(claim).toBeDefined();
    expect(await fixture.attempt(binding.turn.id)).toBeDefined();
    expect((await fixture.state(session.id)).receipts.initial?.dispatched).toBe(true);
    expect(turnStarts()).toBe(1);
    await fixture.execution.close('owner', session);
    await fixture.managed.initialize('owner', session);
    expect(await fixture.claim(session.id)).toEqual(claim);
    expect(fixture.machines.at(-1)!.configuration.workspace).toBe('existing');
  } finally { await fixture.close(); }
});

it('keeps a second Session queued when configured capacity exceeds the native limit', async () => {
  const fixture = await services();
  try {
    const first = await fixture.create();
    const second = await fixture.create();
    await fixture.sessions.dispatch('owner', first.session.id);
    await expect(fixture.sessions.dispatch('owner', second.session.id)).rejects.toMatchObject({ code: 'local_capacity' });
    expect(await fixture.claim(second.session.id)).toBeUndefined();
    expect(await fixture.attempt(second.binding.turn.id)).toBeUndefined();
    expect((await fixture.state(second.session.id)).receipts.initial?.dispatched).toBe(false);
    await fixture.execution.close('owner', first.session);
    await fixture.sessions.dispatch('owner', second.session.id);
    expect(turnStarts()).toBe(2);
    expect(fixture.maximumLive()).toBe(1);
  } finally { await fixture.close(); }
});

it.each(['snapshot', 'readiness'] as const)('keeps Turn receipts queued while %s owns the native slot', async operation => {
  const fixture = await services();
  const paused = gate();
  let operationPromise: Promise<unknown> | undefined;
  try {
    const first = await fixture.create();
    const second = await fixture.create();
    if (operation === 'snapshot') await fixture.managed.initialize('owner', first.session);
    const held = vi.fn();
    fixture.onMachine.mockImplementation((machine: FixtureMachine) => { machine.beforeControl = async command => {
      if (command === (operation === 'snapshot' ? 'snapshot' : 'ping')) { held(); await paused.promise; }
    }; });
    operationPromise = operation === 'snapshot' ? fixture.managed.snapshot(first.session.id) : fixture.runtime.setup();
    await vi.waitFor(() => expect(held).toHaveBeenCalledOnce());
    await expect(fixture.sessions.dispatch('owner', second.session.id)).rejects.toMatchObject({ code: 'local_capacity' });
    expect(await fixture.claim(second.session.id)).toBeUndefined();
    expect(await fixture.attempt(second.binding.turn.id)).toBeUndefined();
    expect((await fixture.state(second.session.id)).receipts.initial?.dispatched).toBe(false);
    paused.release(); await operationPromise;
    fixture.onMachine.mockReset();
    await fixture.sessions.dispatch('owner', second.session.id);
    expect(turnStarts()).toBe(1);
    expect(fixture.maximumLive()).toBe(1);
  } finally { paused.release(); await operationPromise?.catch(() => {}); await fixture.close(); }
});

it('checks pressure again after harness preparation and resumes the retained workspace on retry', async () => {
  const fixture = await services();
  try {
    const { session, binding } = await fixture.create();
    rpc.initialize = async () => { fixture.facts.memoryPressure = 'critical'; };
    await expect(fixture.execution.start('owner', session, binding)).rejects.toMatchObject({ code: 'local_memory_pressure' });
    const claim = await fixture.claim(session.id);
    expect(claim).toBeDefined();
    const bindingPath = join(fixture.directory, 'native-proof', session.id, 'binding.json');
    const diskBinding = await readFile(bindingPath, 'utf8');
    expect(await fixture.attempt(binding.turn.id)).toBeUndefined();
    expect(turnStarts()).toBe(0);
    expect(fixture.machines.every(machine => !machine.alive())).toBe(true);
    expect(rpc.clients[0]!.close).toHaveBeenCalled();
    rpc.initialize = undefined; fixture.facts.memoryPressure = 'normal';
    await fixture.execution.start('owner', session, binding);
    expect(turnStarts()).toBe(1);
    expect(await fixture.claim(session.id)).toEqual(claim);
    expect(await readFile(bindingPath, 'utf8')).toBe(diskBinding);
    expect(fixture.machines[1]!.configuration.workspace).toBe('existing');
  } finally { await fixture.close(); }
});

it.each(['managed readiness', 'host initialization'] as const)('releases resources after failed %s and records a sanitized terminal failure', async failure => {
  const fixture = await services();
  try {
    const { session, binding } = await fixture.create();
    if (failure === 'managed readiness') vi.spyOn(fixture.environments, 'managedReady').mockRejectedValue(new Error('Private readiness diagnostic'));
    else rpc.initialize = async () => { throw new Error('Private host diagnostic'); };
    await fixture.sessions.dispatch('owner', session.id);
    expect((await fixture.state(session.id)).receipts.initial?.dispatched).toBe(true);
    expect((await fixture.attempt(binding.turn.id))?.value).toMatchObject({ status: 'failed', error: { code: 'connection_failed' } });
    expect(JSON.stringify((await fixture.attempt(binding.turn.id))?.value)).not.toContain('Private');
    expect(fixture.machines.every(machine => !machine.alive())).toBe(true);
    expect(turnStarts()).toBe(0);
  } finally { await fixture.close(); }
});

it.each([false, true])('does not execute after a receipt write fails and retains ambiguous receipts: %s', async committed => {
  const fixture = await services();
  try {
    const { session, binding } = await fixture.create();
    const put = fixture.store.put.bind(fixture.store);
    const write = vi.spyOn(fixture.store, 'put').mockImplementation(async (resource, expected) => {
      if (resource.collection === 'local_turn_attempts') {
        if (committed) await put(resource, expected);
        throw new Error('Receipt storage failed');
      }
      await put(resource, expected);
    });
    await expect(fixture.execution.start('owner', session, binding)).rejects.toThrow('Receipt storage failed');
    expect(turnStarts()).toBe(0);
    expect(fixture.machines.every(machine => !machine.alive())).toBe(true);
    expect(rpc.clients[0]!.close).toHaveBeenCalled();
    expect(Boolean(await fixture.attempt(binding.turn.id))).toBe(committed);
    write.mockRestore();
    await fixture.execution.start('owner', session, binding);
    expect(turnStarts()).toBe(committed ? 0 : 1);
  } finally { await fixture.close(); }
});

it('serializes concurrent dispatches so one receipt admits one native turn without closing the winner', async () => {
  const fixture = await services();
  const paused = gate();
  try {
    const { session, binding } = await fixture.create();
    rpc.initialize = () => paused.promise;
    const first = fixture.execution.start('owner', session, binding);
    const second = fixture.execution.start('owner', session, binding);
    await vi.waitFor(() => expect(rpc.clients).toHaveLength(1));
    expect(await fixture.attempt(binding.turn.id)).toBeUndefined();
    paused.release(); await Promise.all([first, second]);
    expect(turnStarts()).toBe(1);
    expect((await fixture.attempt(binding.turn.id))?.revision).toBe(1);
    expect(rpc.clients[0]!.close).not.toHaveBeenCalled();
    expect(fixture.machines[0]!.alive()).toBe(true);
  } finally { paused.release(); await fixture.close(); }
});

it('retains an accepted receipt after an ambiguous native turn start and never replays it', async () => {
  const fixture = await services();
  try {
    const { session, binding } = await fixture.create();
    rpc.turn = async () => {
      expect(await fixture.attempt(binding.turn.id)).toBeDefined();
      throw new Error('Ambiguous native response');
    };
    await fixture.execution.start('owner', session, binding);
    await fixture.execution.start('owner', session, binding);
    expect(turnStarts()).toBe(1);
    expect((await fixture.attempt(binding.turn.id))?.value.status).toBe('failed');
    expect(fixture.machines.every(machine => !machine.alive())).toBe(true);
  } finally { await fixture.close(); }
});

it('blocks a new Turn under critical pressure while preserving an already accepted Turn and health reads', async () => {
  const fixture = await services();
  try {
    const { session, binding } = await fixture.create();
    await fixture.execution.start('owner', session, binding);
    fixture.facts.memoryPressure = 'critical';
    const next = { ...binding, turn: { ...binding.turn, id: 'turn_waiting' } };
    await expect(fixture.execution.start('owner', session, next)).rejects.toMatchObject({ code: 'local_memory_pressure' });
    expect(await fixture.attempt(next.turn.id)).toBeUndefined();
    expect(await fixture.attempt(binding.turn.id)).toBeDefined();
    expect(await fixture.runtime.running(session.id)).toBe(true);
    expect(rpc.clients[0]!.close).not.toHaveBeenCalled();
    expect(fixture.machines[0]!.alive()).toBe(true);
    expect(turnStarts()).toBe(1);
    await fixture.execution.cancel('owner', session, binding.turn.id);
    expect(rpc.calls).toContain('turn/interrupt');
  } finally { await fixture.close(); }
});

it('drains preparation and receipt acceptance before shutdown releases the VM', async () => {
  const fixture = await services();
  const paused = gate();
  try {
    const { session, binding } = await fixture.create();
    rpc.initialize = () => paused.promise;
    const starting = fixture.execution.start('owner', session, binding);
    await vi.waitFor(() => expect(rpc.clients).toHaveLength(1));
    const closing = fixture.execution.shutdown();
    await expect(fixture.execution.start('owner', session, binding)).rejects.toMatchObject({ code: 'service_unavailable' });
    paused.release(); await starting; await closing;
    expect(turnStarts()).toBe(1);
    expect(fixture.machines.every(machine => !machine.alive())).toBe(true);
    expect(rpc.clients[0]!.close).toHaveBeenCalled();
  } finally { paused.release(); await fixture.close(); }
});

it('keeps an ambiguously persisted claim when no disk was allocated and refuses a later resume', async () => {
  const fixture = await services();
  try {
    const { session, binding } = await fixture.create();
    const put = fixture.store.put.bind(fixture.store);
    const write = vi.spyOn(fixture.store, 'put').mockImplementation(async (resource, expected) => {
      await put(resource, expected);
      if (resource.collection === 'local_prepared') throw new Error('Ambiguous claim write');
    });
    await fixture.execution.start('owner', session, binding);
    const claim = await fixture.claim(session.id);
    expect(claim).toBeDefined();
    expect((await fixture.attempt(binding.turn.id))?.value.status).toBe('failed');
    write.mockRestore();
    const next = { ...binding, turn: { ...binding.turn, id: 'turn_retry' } };
    await fixture.execution.start('owner', session, next);
    expect((await fixture.attempt(next.turn.id))?.value.status).toBe('failed');
    expect(await fixture.claim(session.id)).toEqual(claim);
    await expect(lstat(join(fixture.directory, 'native-proof', session.id, 'workspace.raw'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(fixture.machines).toHaveLength(0);
    expect(turnStarts()).toBe(0);
  } finally { await fixture.close(); }
});

it('does not relabel initialization metadata storage failures as resource waits and releases the prepared worker', async () => {
  const fixture = await services();
  try {
    const { session, binding } = await fixture.create();
    const put = fixture.store.put.bind(fixture.store);
    vi.spyOn(fixture.store, 'put').mockImplementation(async (resource, expected) => {
      if (resource.collection === 'local_runtime') throw new Error('Metadata storage failed');
      await put(resource, expected);
    });
    await expect(fixture.execution.start('owner', session, binding)).rejects.toThrow('Metadata storage failed');
    expect(await fixture.attempt(binding.turn.id)).toBeUndefined();
    expect(turnStarts()).toBe(0);
    expect(fixture.machines.every(machine => !machine.alive())).toBe(true);
  } finally { await fixture.close().catch(() => {}); }
});

it('disconnects immediately after snapshot failure and resumes the same workspace on retry', async () => {
  const fixture = await services();
  try {
    const { session } = await fixture.create();
    await fixture.managed.initialize('owner', session);
    const claim = await fixture.claim(session.id);
    expect((await fixture.managed.state('owner', session))?.status).toBe('connected');
    fixture.onMachine.mockImplementation(machine => { machine.beforeControl = async operation => {
      if (operation === 'snapshot') throw new Error('Snapshot failed after replacement');
    }; });
    await expect(fixture.managed.snapshot(session.id)).rejects.toThrow('Snapshot failed after replacement');
    expect((await fixture.managed.state('owner', session))?.status).toBe('disconnected');
    expect(fixture.machines.every(machine => !machine.alive())).toBe(true);
    fixture.onMachine.mockReset();
    await fixture.managed.initialize('owner', session);
    expect((await fixture.managed.state('owner', session))?.status).toBe('connected');
    expect(await fixture.claim(session.id)).toEqual(claim);
    expect(fixture.machines.at(-1)!.configuration.workspace).toBe('existing');
    expect(fixture.maximumLive()).toBe(1);
  } finally { await fixture.close(); }
});

it('preserves the connected workspace when snapshot admission refuses before stopping it', async () => {
  const fixture = await services();
  try {
    const { session } = await fixture.create();
    await fixture.managed.initialize('owner', session);
    fixture.facts.memoryPressure = 'critical';
    await expect(fixture.managed.snapshot(session.id)).rejects.toMatchObject({ code: 'local_memory_pressure' });
    expect((await fixture.managed.state('owner', session))?.status).toBe('connected');
    expect(fixture.machines).toHaveLength(1);
    expect(fixture.machines[0]!.stop).not.toHaveBeenCalled();
    expect(await fixture.runtime.running(session.id)).toBe(true);
  } finally { await fixture.close(); }
});

it('honors public cancellation accepted during preparation before creating an accepted Turn receipt', async () => {
  const fixture = await services();
  const paused = gate();
  let starting: Promise<void> | undefined;
  let cancelling: Promise<void> | undefined;
  try {
    const { session, binding } = await fixture.create();
    const admit = fixture.managed.admitTurn.bind(fixture.managed);
    const admitting = vi.spyOn(fixture.managed, 'admitTurn').mockImplementation(async input => { await paused.promise; await admit(input); });
    starting = fixture.sessions.dispatch('owner', session.id);
    await vi.waitFor(() => expect(admitting).toHaveBeenCalledOnce());
    await fixture.sessions.events('owner', session.id, { events: [{ type: 'agent.session.input.cancel' }] });
    expect((await fixture.state(session.id)).turns[0]!.cancelRequested).toBe(true);
    expect(await fixture.attempt(binding.turn.id)).toBeUndefined();
    cancelling = fixture.sessions.dispatch('owner', session.id);
    paused.release();
    await starting; await cancelling;
    expect(turnStarts()).toBe(0);
    expect((await fixture.attempt(binding.turn.id))?.value.status).toBe('cancelled');
    expect((await fixture.execution.observe('owner', session, binding.turn)).turn.status).toBe('cancelled');
    expect(Object.values((await fixture.state(session.id)).receipts).every(receipt => receipt.dispatched)).toBe(true);
    expect(fixture.machines.every(machine => !machine.alive())).toBe(true);
  } finally { paused.release(); await starting?.catch(() => {}); await cancelling?.catch(() => {}); await fixture.close(); }
});

it('delivers cancellation after an accepted native Turn returns its binding', async () => {
  const fixture = await services();
  const paused = gate();
  let starting: Promise<void> | undefined;
  let cancelling: Promise<void> | undefined;
  try {
    const { session, binding } = await fixture.create();
    rpc.turn = () => paused.promise;
    starting = fixture.execution.start('owner', session, binding);
    await vi.waitFor(() => expect(turnStarts()).toBe(1));
    expect(await fixture.attempt(binding.turn.id)).toBeDefined();
    cancelling = fixture.execution.cancel('owner', session, binding.turn.id);
    paused.release(); await starting; await cancelling;
    expect(rpc.calls.filter(method => method === 'turn/interrupt')).toHaveLength(1);
    expect(turnStarts()).toBe(1);
  } finally { paused.release(); await starting?.catch(() => {}); await cancelling?.catch(() => {}); await fixture.close(); }
});

it('waits for managed descendant shutdown before publishing cancellation and reopens the retained workspace', async () => {
  const fixture = await services();
  const stopped = gate();
  let cancelling: Promise<void> | undefined;
  try {
    const { session, binding } = await fixture.create();
    await fixture.execution.start('owner', session, binding);
    const claim = await fixture.claim(session.id);
    const snapshot = (await fixture.store.get<SessionRuntimeState>('owner', 'local_runtime', session.id))!.value;
    const native = snapshot.turns[0]!;
    const machine = fixture.machines[0]!;
    machine.beforeStop = () => stopped.promise;
    rpc.interrupt = async () => { rpc.clients[0]!.emit({ method: 'turn/completed', params: {
      threadId: native.threadId, turn: { id: native.nativeTurnId, status: 'interrupted' },
    } }); };
    let settled = false;
    cancelling = fixture.execution.cancel('owner', session, binding.turn.id).then(() => { settled = true; });
    await vi.waitFor(() => expect(machine.stop).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    expect(machine.alive()).toBe(true);
    expect((await fixture.execution.observe('owner', session, binding.turn)).turn.status).toBe(binding.turn.status);
    expect((await fixture.store.get<SessionRuntimeState>('owner', 'local_runtime', session.id))!.value.turns[0]!.turn.status).toBe(binding.turn.status);
    stopped.release(); await cancelling;
    expect(machine.alive()).toBe(false);
    expect(rpc.clients[0]!.close).toHaveBeenCalled();
    expect((await fixture.execution.observe('owner', session, binding.turn)).turn.status).toBe('cancelled');
    expect((await fixture.attempt(binding.turn.id))!.value.status).toBe('cancelled');
    const next = { ...binding, turn: { ...binding.turn, id: 'turn_after_cancel' } };
    await fixture.execution.start('owner', session, next);
    expect(turnStarts()).toBe(2);
    expect(await fixture.claim(session.id)).toEqual(claim);
    expect(fixture.machines[1]!.configuration.workspace).toBe('existing');
    await fixture.execution.cancel('owner', session, binding.turn.id);
    expect(fixture.machines[1]!.alive()).toBe(true);
    expect(fixture.machines[1]!.stop).not.toHaveBeenCalled();
    expect(rpc.calls.filter(method => method === 'turn/interrupt')).toHaveLength(1);
  } finally { stopped.release(); await cancelling?.catch(() => {}); await fixture.close(); }
});

it('keeps managed cancellation nonterminal and refuses new work until failed worker cleanup is confirmed', async () => {
  const fixture = await services();
  try {
    const { session, binding } = await fixture.create();
    await fixture.execution.start('owner', session, binding);
    const machine = fixture.machines[0]!;
    machine.unconfirmedStopError = new Error('Fixture worker shutdown unconfirmed');
    await expect(fixture.execution.cancel('owner', session, binding.turn.id)).rejects.toThrow('could not confirm worker shutdown');
    expect(machine.alive()).toBe(true);
    expect((await fixture.execution.observe('owner', session, binding.turn)).turn.status).toBe(binding.turn.status);
    const next = { ...binding, turn: { ...binding.turn, id: 'turn_during_failed_cancel' } };
    await expect(fixture.execution.start('owner', session, next)).rejects.toMatchObject({ code: 'local_runtime_stopping' });
    expect(await fixture.attempt(next.turn.id)).toBeUndefined();
    expect(turnStarts()).toBe(1);
    machine.unconfirmedStopError = undefined;
    await fixture.execution.cancel('owner', session, binding.turn.id);
    expect(machine.alive()).toBe(false);
    expect((await fixture.execution.observe('owner', session, binding.turn)).turn.status).toBe('cancelled');
    await fixture.execution.start('owner', session, next);
    expect(turnStarts()).toBe(2);
    expect(fixture.maximumLive()).toBe(1);
  } finally { await fixture.close(); }
});

it('honors cancellation persisted during the awaited receipt write before issuing native work', async () => {
  const fixture = await services();
  const paused = gate();
  let starting: Promise<void> | undefined;
  try {
    const { session, binding } = await fixture.create();
    const put = fixture.store.put.bind(fixture.store);
    const receipt = vi.fn();
    vi.spyOn(fixture.store, 'put').mockImplementation(async (resource, expected) => {
      await put(resource, expected);
      if (resource.collection === 'local_turn_attempts' && resource.revision === 1) { receipt(); await paused.promise; }
    });
    starting = fixture.sessions.dispatch('owner', session.id);
    await vi.waitFor(() => expect(receipt).toHaveBeenCalledOnce());
    await fixture.sessions.events('owner', session.id, { events: [{ type: 'agent.session.input.cancel' }] });
    paused.release(); await starting;
    await fixture.sessions.dispatch('owner', session.id);
    expect(turnStarts()).toBe(0);
    expect((await fixture.attempt(binding.turn.id))?.value.status).toBe('cancelled');
    expect(fixture.machines.every(machine => !machine.alive())).toBe(true);
  } finally { paused.release(); await starting?.catch(() => {}); await fixture.close(); }
});

it('does not start native work after public Session deletion marks a preparing Session as closing', async () => {
  const fixture = await services();
  const paused = gate();
  let starting: Promise<void> | undefined;
  let deleting: Promise<unknown> | undefined;
  try {
    const { session } = await fixture.create();
    const admit = fixture.managed.admitTurn.bind(fixture.managed);
    const admitting = vi.spyOn(fixture.managed, 'admitTurn').mockImplementation(async input => { await paused.promise; await admit(input); });
    starting = fixture.sessions.dispatch('owner', session.id);
    await vi.waitFor(() => expect(admitting).toHaveBeenCalledOnce());
    deleting = fixture.sessions.delete('owner', session.id);
    await vi.waitFor(async () => expect((await fixture.state(session.id)).closing).toBe(true));
    paused.release(); await starting; await deleting;
    expect(turnStarts()).toBe(0);
    expect(await fixture.store.get('owner', 'sessions', session.id)).toBeUndefined();
    expect(fixture.machines.every(machine => !machine.alive())).toBe(true);
  } finally { paused.release(); await starting?.catch(() => {}); await deleting?.catch(() => {}); await fixture.close(); }
});
