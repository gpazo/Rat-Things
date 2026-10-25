import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { createLocalServices, LOCAL_OWNER } from '../../src/app/local-composition.js';
import { LocalSessionExecution } from '../../src/runner/local-session-execution.js';
import type { LocalManagedEnvironment } from '../../src/runner/local-managed-environment.js';
import type { LocalRuntime, LocalStartRequest } from '../../src/core/local-runtime-ports.js';
import type { PiModelDescriptor } from '../../src/domain/session-runtime.js';
import { PI_MANAGED_TOOLS } from '../../src/runner/pi-managed-tools.js';
import { AgentsApiError } from '../../src/domain/agents-api-validation.js';

const bridge = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('../../src/runner/local-pi-effects.js', () => ({ openLocalPiEffects: bridge.open }));
afterEach(() => { vi.restoreAllMocks(); bridge.open.mockReset(); });
const catalog: PiModelDescriptor[] = [{ id: 'fixture', name: 'Fixture', provider: 'openai-codex', api: 'openai-codex-responses',
  input: ['text'], contextWindow: 100000, maxTokens: 10000, reasoning: ['low', 'medium', 'high'] }];

async function fixture(existing?: string) {
  const directory = existing ?? await mkdtemp(join(tmpdir(), 'rat-pi-managed-'));
  const faux = fauxProvider({ provider: 'openai-codex', api: 'openai-codex-responses', tokensPerSecond: Infinity,
    models: [{ id: 'fixture', reasoning: true, input: ['text'], contextWindow: 100000, maxTokens: 10000 }] });
  const models = createModels(); models.setProvider(faux.provider);
  const starts: LocalStartRequest[] = [];
  const status = { ready: true, engine: 'native-linux' as const, image: 'fixture', checks: [] };
  const runtime: LocalRuntime = { status: async () => status, setup: async () => status, running: async () => true,
    start: vi.fn(async (request, commit) => { starts.push(request); await commit(); return 'http://127.0.0.1:3211'; }),
    admitTurn: vi.fn(async () => {}), stop: vi.fn(async () => {}), snapshot: async () => [], close: vi.fn(async () => {}) };
  let managed!: LocalManagedEnvironment;
  const services = createLocalServices({ directory, runtime, model: 'fixture', pi: { catalog, models: () => models },
    execution: (store, environment) => { managed = environment; return new LocalSessionExecution({ store, directory, managed, maxSessions: 2 }); } });
  const create = (input?: string, tools: import('../../src/domain/agents-api.js').AgentToolParam[] = []) => services.sessions.create(LOCAL_OWNER, { metadata: { rat_things_runtime: 'pi' },
    agent: { model: 'fixture', reasoning: { effort: 'medium' }, multi_agent: { enabled: false }, tools }, environment: { type: 'openai_hosted' },
    ...(input ? { input } : {}) });
  return { directory, faux, services, managed, starts, runtime, create,
    cleanup: async () => { await services.close(); await rm(directory, { recursive: true, force: true }); } };
}

it('initializes an empty managed Pi Session and exposes its environment state without inference', async () => {
  const f = await fixture();
  try {
    const session = await f.create();
    await f.services.sessions.dispatch(LOCAL_OWNER, session.id);
    expect(f.starts).toHaveLength(1);
    expect(await f.managed.state(LOCAL_OWNER, session)).toMatchObject({ status: 'connected' });
    expect(bridge.open).not.toHaveBeenCalled(); expect(f.faux.state.callCount).toBe(0);
  } finally { await f.cleanup(); }
});

it('opens a fresh native epoch over the same workspace and closes effects before the shared worker', async () => {
  const f = await fixture(); const events: string[] = [];
  bridge.open.mockImplementation(async (options: Parameters<typeof import('../../src/runner/local-pi-effects.js').openLocalPiEffects>[0]) => ({
    tools: PI_MANAGED_TOOLS, execute: async () => { await options.lease.assertActive(); events.push('effect'); return { output: [{ type: 'text', text: 'written' }], isError: false }; },
    close: async () => { events.push('bridge-close'); },
  }));
  vi.mocked(f.runtime.close).mockImplementation(async () => { events.push('worker-close'); });
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall('write_file', { path: 'test.txt', content: 'value' }), { stopReason: 'toolUse' }), fauxAssistantMessage('written'), fauxAssistantMessage('continued')]);
  try {
    const session = await f.create('Write a file.'); await f.services.sessions.dispatch(LOCAL_OWNER, session.id);
    await expect.poll(async () => (await f.services.sessions.turns(LOCAL_OWNER, session.id)).data[0]?.status).toBe('completed');
    await expect.poll(() => events.filter(value => value === 'bridge-close').length).toBe(1);
    await f.services.sessions.events(LOCAL_OWNER, session.id, { events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: 'Continue.' }] }] }] });
    await f.services.sessions.dispatch(LOCAL_OWNER, session.id);
    await expect.poll(() => bridge.open.mock.calls.length).toBe(2);
    const [first, second] = bridge.open.mock.calls.map(call => call[0]);
    expect(second.generation).toBe(first.generation); expect(second.epoch).toBe(first.epoch + 1); expect(second.runId).not.toBe(first.runId);
    expect(f.runtime.start).toHaveBeenCalledOnce(); expect(f.runtime.admitTurn).toHaveBeenCalled();
    await f.services.close();
    expect(events.lastIndexOf('bridge-close')).toBeLessThan(events.indexOf('worker-close'));
  } finally { await f.cleanup(); }
});

it('does not deadlock failed-open cleanup and refuses a worker whose stop is unconfirmed', async () => {
  const f = await fixture();
  bridge.open.mockImplementation(async (options: Parameters<typeof import('../../src/runner/local-pi-effects.js').openLocalPiEffects>[0]) => {
    await options.stopWorker(); throw new Error('broker failed');
  });
  try {
    const session = await f.create(); await f.services.sessions.dispatch(LOCAL_OWNER, session.id);
    await expect(f.managed.openPiEffects(LOCAL_OWNER, session, { assertActive: async () => {} }, { runId: 'test', epoch: 0 })).rejects.toThrow('broker failed');
    expect(f.runtime.stop).toHaveBeenCalledOnce();
    vi.mocked(f.runtime.stop).mockRejectedValueOnce(new Error('stop unconfirmed'));
    await expect(f.managed.openPiEffects(LOCAL_OWNER, session, { assertActive: async () => {} }, { runId: 'test', epoch: 1 })).rejects.toThrow('stop unconfirmed');
    await expect(f.managed.initialize(LOCAL_OWNER, session)).rejects.toThrow('cleanup is unconfirmed');
    await expect(f.managed.admitTurn(session)).rejects.toThrow('cleanup is unconfirmed');
  } finally { await f.cleanup(); }
});

it('cancels a durable function after restart without admitting another worker turn', async () => {
  const f = await fixture();
  bridge.open.mockImplementation(async () => ({ tools: PI_MANAGED_TOOLS, execute: async () => { throw new Error('Unexpected effect'); }, close: async () => {} }));
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall('lookup', {}), { stopReason: 'toolUse' })]);
  const session = await f.create('Wait for lookup.', [{ type: 'function', name: 'lookup', description: 'Lookup', parameters: { type: 'object', properties: {} } }]);
  await f.services.sessions.dispatch(LOCAL_OWNER, session.id);
  await expect.poll(async () => (await f.services.sessions.retrieve(LOCAL_OWNER, session.id)).required_actions.length).toBe(1);
  await f.services.close();
  const recovered = await fixture(f.directory); recovered.services.stop();
  try {
    await recovered.services.sessions.events(LOCAL_OWNER, session.id, { events: [{ type: 'agent.session.input.cancel' }] });
    await recovered.services.sessions.dispatch(LOCAL_OWNER, session.id);
    await expect.poll(async () => (await recovered.services.sessions.turns(LOCAL_OWNER, session.id)).data[0]?.status).toBe('cancelled');
    expect(recovered.runtime.admitTurn).not.toHaveBeenCalled(); expect(recovered.runtime.start).not.toHaveBeenCalled();
    expect(recovered.runtime.stop).toHaveBeenCalledWith(session.id); expect(recovered.faux.state.callCount).toBe(0);
  } finally { await recovered.cleanup(); }
});

it('does not publish ready state for an empty Session when worker sandbox verification fails', async () => {
  const f = await fixture();
  vi.mocked(f.runtime.start).mockImplementation(async (_request, commit) => { await commit(); throw new Error('Local worker failed during sandbox.'); });
  try {
    const session = await f.create();
    await expect(f.services.sessions.dispatch(LOCAL_OWNER, session.id)).rejects.toThrow('sandbox');
    expect((await f.managed.state(LOCAL_OWNER, session))?.status).not.toBe('connected');
    expect(f.faux.state.callCount).toBe(0); expect(bridge.open).not.toHaveBeenCalled();
  } finally { await f.cleanup(); }
});

it('settles a refused initial Turn only after worker cleanup, without retrying startup or inference', async () => {
  const f = await fixture(); f.services.stop();
  vi.mocked(f.runtime.start).mockImplementation(async (_request, commit) => { await commit(); throw new Error('Local worker failed during setup.'); });
  let stopped!: () => void;
  vi.mocked(f.runtime.stop).mockImplementationOnce(() => new Promise<void>(resolve => { stopped = resolve; }));
  try {
    const session = await f.create('Start coding.');
    const dispatching = f.services.sessions.dispatch(LOCAL_OWNER, session.id);
    await expect.poll(() => f.runtime.stop).toHaveBeenCalledOnce();
    expect((await f.services.sessions.turns(LOCAL_OWNER, session.id)).data[0]?.status).toBe('queued');
    expect(f.faux.state.callCount).toBe(0); expect(bridge.open).not.toHaveBeenCalled();
    stopped(); await dispatching;
    expect((await f.services.sessions.turns(LOCAL_OWNER, session.id)).data[0]).toMatchObject({ status: 'failed', error: { code: 'connection_failed' } });
    expect((await f.managed.state(LOCAL_OWNER, session))?.status).toBe('disconnected');
    await f.services.sessions.completeReadyTurns(LOCAL_OWNER, session.id);
    await f.services.sessions.dispatch(LOCAL_OWNER, session.id);
    await f.services.sessions.dispatch(LOCAL_OWNER, session.id);
    expect(f.runtime.start).toHaveBeenCalledOnce();
    expect(f.faux.state.callCount).toBe(0); expect(bridge.open).not.toHaveBeenCalled();

    vi.mocked(f.runtime.start).mockImplementation(async (_request, commit) => { await commit(); return 'http://127.0.0.1:3211'; });
    bridge.open.mockResolvedValue({ tools: PI_MANAGED_TOOLS, execute: async () => { throw new Error('Unexpected effect'); }, close: async () => {} });
    f.faux.setResponses([fauxAssistantMessage('Runtime recovered.')]);
    await f.services.sessions.events(LOCAL_OWNER, session.id, { events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: 'Retry after repairing the runtime.' }] }] }] });
    await f.services.sessions.dispatch(LOCAL_OWNER, session.id);
    await expect.poll(async () => (await f.services.sessions.turns(LOCAL_OWNER, session.id)).data.map(turn => turn.status).sort()).toEqual(['completed', 'failed']);
    expect(f.runtime.start).toHaveBeenCalledTimes(2);
    expect(f.faux.state.callCount).toBe(1);
  } finally { stopped?.(); await f.cleanup(); }
});

it.each(['local_capacity', 'local_memory_pressure', 'local_disk_capacity', 'local_runtime_starting', 'local_runtime_unavailable'])(
  'keeps temporary %s startup failure queued and retryable', async code => {
    const f = await fixture(); f.services.stop();
    vi.mocked(f.runtime.start).mockRejectedValue(new AgentsApiError(503, 'Temporary runtime wait', code));
    try {
      const session = await f.create('Start when ready.');
      await expect(f.services.sessions.dispatch(LOCAL_OWNER, session.id)).rejects.toMatchObject({ code });
      await expect(f.services.sessions.dispatch(LOCAL_OWNER, session.id)).rejects.toMatchObject({ code });
      expect((await f.services.sessions.turns(LOCAL_OWNER, session.id)).data[0]?.status).toBe('queued');
      expect(f.runtime.start).toHaveBeenCalledTimes(2);
      expect(f.runtime.stop).not.toHaveBeenCalled();
      expect(f.faux.state.callCount).toBe(0); expect(bridge.open).not.toHaveBeenCalled();
    } finally { await f.cleanup(); }
  },
);
