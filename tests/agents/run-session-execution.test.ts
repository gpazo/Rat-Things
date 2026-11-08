import { iamApiPrincipal } from '../../src/domain/api-permissions.js';
import { describe, expect, it, vi } from 'vitest';
import type { SessionPlacementPolicy } from '../../src/app/session-placement.js';
import { RunSessionExecution } from '../../src/app/run-session-execution.js';
import { SessionRuntimeStore } from '../../src/core/session-runtime-store.js';
import { initialSessionRuntime } from '../../src/core/session-runtime-planning.js';
import { sessionAgent } from '../../src/core/session-planning.js';
import { EnvironmentService, type StoredEnvironment } from '../../src/core/environment-service.js';
import { EnvironmentTemplateService } from '../../src/core/environment-template-service.js';
import { NotFoundError } from '../../src/core/errors.js';
import { AgentsApiError, parseAgentsContract } from '../../src/domain/agents-api-validation.js';
import type { AgentSession, Turn } from '../../src/domain/agents-api.js';
import type { RunRecord } from '../../src/domain/contracts.js';
import { MemoryAgentsStore } from './fixtures.js';
import { SessionService } from '../../src/core/session-service.js';
import { AgentService } from '../../src/core/agent-service.js';
import { routeAgentsRequest } from '../../src/lambdas/agents-router.js';

async function fixture(placement?: SessionPlacementPolicy) {
  const store = new MemoryAgentsStore();
  let now = 100;
  const environments = new EnvironmentService({ store, clock: { now: () => now }, templates: new EnvironmentTemplateService({ store }), managedFiles: async () => [] });
  const environment = { type: 'none' as const };
  const session: AgentSession = { id: 'sess', object: 'agent.session', agent: sessionAgent({ model: 'fixture' }, 'agent', now), environment,
    created_at: now, last_active_at: now, status: 'idle', error: null, required_actions: [], usage: null, vault_ids: [], metadata: {} };
  const turn: Turn = { id: 'followup', object: 'agent.session.turn', session_id: 'sess', agent_id: 'agent', subagent_id: null, status: 'queued',
    created_at: now, started_at: null, completed_at: null, error: null, usage: null };
  const run: RunRecord = { runId: 'run', ownerId: 'alice', ownerCreated: 'alice#run', status: 'running', createdAt: '', updatedAt: '', expiresAt: 10000, requestHash: '', sourceKind: 'api',
    input: { bucket: 'private', key: 'input', sha256: '' }, execution: { backend: 'microvm', id: 'vm', generation: 'generation' } };
  const submit = vi.fn(async (): Promise<RunRecord> => { throw new Error('Unexpected new harness'); });
  const start = vi.fn(async () => {});
  const steer = vi.fn(async () => {});
  const interrupt = vi.fn(async () => {});
  const events = vi.fn(async () => ({ runId: run.runId, active: true, ready: true, oldestSequence: 0, nextSequence: 0, events: [], pendingRequests: [] }));
  const runtime = new SessionRuntimeStore(store); await runtime.claim('alice', session.id, run.runId, now);
  const getRun = vi.fn(async () => run);
  const cancel = vi.fn(async () => run);
  const putJson = vi.fn(async (key: string, _value?: unknown) => ({ bucket: 'private', key, sha256: 'fixture' }));
  const execution = new RunSessionExecution({ store, environments, ...(placement ? { placement } : {}),
    runs: { get: getRun, idFor: () => 'unused', cancel, submit },
    interaction: { startSessionTurn: start, events, steer, interrupt, respond: async () => {} },
    artifacts: { getJson: async () => { throw new Error('Unexpected object read'); }, putJson, getBytes: async () => new Uint8Array(), getStream: async () => { throw new Error('Unexpected stream'); } },
    vaults: { requireVaults: async () => {} }, tools: { prepare: async () => {}, launch: async () => [], close: async () => {} },
  });
  return { execution, session, turn, run, getRun, submit, cancel, putJson, start, steer, interrupt, events, runtime, environments, store, clock: { now: () => now }, now: (time: number) => { now = time; } };
}

describe('persistent harness input admission', () => {
  it('blocks a persisted self-hosted Session before sending input to an active Run', async () => {
    const f = await fixture();
    const session = { ...f.session, environment: { type: 'self_hosted' as const, id: 'env_legacy', workspace_directory: '/workspace', capability_directories: [], remote_url: 'https://relay.example' } };
    await expect(f.execution.start('alice', session, { turn: f.turn, input: [] }))
      .rejects.toMatchObject({ status: 409, code: 'unsupported_environment' });
    expect(f.events).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
  });

  it('retires queued self-hosted launch commands so outbox retries cannot relaunch them', async () => {
    const f = await fixture();
    const session = { ...f.session, environment: { type: 'self_hosted' as const, id: 'env_legacy', workspace_directory: '/workspace', capability_directories: [], remote_url: 'https://relay.example' } };
    await f.store.put({ ownerId: 'alice', id: session.id, collection: 'sessions', createdAt: 100, revision: 1, value: {
      session, turns: [{ turn: f.turn, input: [] }],
      receipts: { initial: { digest: 'fixture', commands: [{ type: 'start', turnId: f.turn.id, input: [] }], dispatched: false } },
      deletedArtifacts: [],
    } }, 0);
    const sessions = new SessionService({ store: f.store, agents: new AgentService({ store: f.store }), execution: f.execution, clock: f.clock });

    await sessions.dispatch('alice', session.id);
    const retired = await f.store.get<import('../../src/core/session-ports.js').SessionState>('alice', 'sessions', session.id);
    expect(retired?.value.receipts.initial).toMatchObject({ dispatched: true, failure: { code: 'unsupported_environment' } });
    expect(retired?.value.session.status).toBe('failed');
    expect(retired?.value.turns[0]?.turn).toMatchObject({ status: 'failed', error: { code: 'invalid_request' } });
    expect(f.start).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();

    await sessions.dispatch('alice', session.id);
    expect(f.start).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
  });

  it('still dispatches cancellation for a persisted self-hosted Session', async () => {
    const f = await fixture();
    const session = { ...f.session, environment: { type: 'self_hosted' as const, id: 'env_legacy', workspace_directory: '/workspace', capability_directories: [], remote_url: 'https://relay.example' } };
    await f.store.put({ ownerId: 'alice', id: session.id, collection: 'sessions', createdAt: 100, revision: 1, value: {
      session, turns: [{ turn: f.turn, input: [] }],
      receipts: { cancel: { digest: 'fixture', commands: [{ type: 'cancel', turnId: f.turn.id }], dispatched: false } },
      deletedArtifacts: [],
    } }, 0);
    const sessions = new SessionService({ store: f.store, agents: new AgentService({ store: f.store }), execution: f.execution, clock: f.clock });

    await sessions.dispatch('alice', session.id);

    expect(f.interrupt).toHaveBeenCalledExactlyOnceWith({ runId: 'run', execution: f.run.execution, turnId: f.turn.id });
    expect((await f.store.get<import('../../src/core/session-ports.js').SessionState>('alice', 'sessions', session.id))?.value.receipts.cancel).toMatchObject({ dispatched: true });
    expect((await f.store.get<import('../../src/core/session-ports.js').SessionState>('alice', 'sessions', session.id))?.value.receipts.cancel).not.toHaveProperty('failure');
    expect(f.start).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
  });

  it('waits for the native control bridge even after the Run starts heartbeating', async () => {
    const f = await fixture();
    f.events.mockResolvedValueOnce({ runId: f.run.runId, active: true, ready: false, oldestSequence: 0, nextSequence: 0, events: [], pendingRequests: [] });
    await expect(f.execution.start('alice', f.session, { turn: f.turn, input: [] })).rejects.toMatchObject({ status: 503, code: 'service_unavailable' });
    expect(f.start).not.toHaveBeenCalled();
    await f.execution.start('alice', f.session, { turn: f.turn, input: [] });
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(f.submit).not.toHaveBeenCalled();
  });
  it('keeps steering pending until the heartbeating worker control bridge is ready', async () => {
    const f = await fixture();
    const input = [{ role: 'user' as const, content: [{ type: 'input_text' as const, text: 'Continue' }] }];
    f.events.mockResolvedValueOnce({ runId: f.run.runId, active: true, ready: false, oldestSequence: 0, nextSequence: 0, events: [], pendingRequests: [] });
    await expect(f.execution.steer('alice', f.session, f.turn.id, input, 'accepted-operation')).rejects.toMatchObject({ status: 503, code: 'service_unavailable' });
    expect(f.steer).not.toHaveBeenCalled();
    await f.execution.steer('alice', f.session, f.turn.id, input, 'accepted-operation');
    expect(f.steer).toHaveBeenCalledExactlyOnceWith({ runId: f.run.runId, execution: f.run.execution, turnId: f.turn.id }, 'Continue', 'accepted-operation', input);
    expect(f.submit).not.toHaveBeenCalled();
  });
  it('does not reopen a closed Session when an old dispatch receipt retries', async () => {
    const f = await fixture();
    await f.runtime.close('alice', f.session.id);
    await f.execution.start('alice', f.session, { turn: f.turn, input: [] });
    expect(f.start).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
  });
  it('closes a Session before its first harness and ignores delayed dispatch', async () => {
    const f = await fixture();
    await f.store.delete((await f.runtime.get('alice', f.session.id))!);
    await f.execution.close('alice', f.session);
    await f.execution.start('alice', f.session, { turn: f.turn, input: [] });
    expect(f.start).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.cancel).not.toHaveBeenCalled();
    expect((await f.runtime.get('alice', f.session.id))?.value).toEqual({ closed: true, runId: null, epoch: 1 });
  });
  it('rejects a first harness claim when deletion wins during launch preparation', async () => {
    const f = await fixture();
    const agents = new AgentService({ store: f.store });
    const sessions = new SessionService({ store: f.store, agents, execution: f.execution, clock: f.clock });
    const session = await sessions.create('alice', { agent: { model: 'fixture' }, environment: { type: 'none' }, input: 'Start' });
    let entered!: () => void; const preparing = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void; const blocked = new Promise<void>((resolve) => { release = resolve; });
    f.putJson.mockImplementationOnce(async (key) => {
      entered(); await blocked;
      return { bucket: 'private', key, sha256: 'fixture' };
    });
    const starting = sessions.dispatch('alice', session.id);
    const rejected = expect(starting).rejects.toMatchObject({ status: 409 });
    await preparing;
    try {
      const response = await routeAgentsRequest(new Request(`https://api.example/v1/agents/sessions/${session.id}`, { method: 'DELETE' }), iamApiPrincipal('alice'), { agents, sessions });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ id: session.id, object: 'agent.session.deleted', deleted: true });
    } finally { release(); }
    await rejected;
    await expect(sessions.retrieve('alice', session.id)).rejects.toMatchObject({ status: 404 });
    expect(f.submit).not.toHaveBeenCalled();
    expect((await f.runtime.get('alice', session.id))?.value.closed).toBe(true);
  });
  it('cancels the harness whose claim wins the first closure write', async () => {
    const f = await fixture();
    await f.store.delete((await f.runtime.get('alice', f.session.id))!);
    const put = f.store.put.bind(f.store);
    vi.spyOn(f.store, 'put').mockImplementationOnce(async (resource, expected) => {
      await f.runtime.claim('alice', f.session.id, f.run.runId, 100);
      await put(resource, expected);
    });
    await f.execution.close('alice', f.session);
    expect(f.cancel).toHaveBeenCalledExactlyOnceWith('alice', f.run.runId);
    expect((await f.runtime.get('alice', f.session.id))?.value).toEqual({ closed: true, runId: f.run.runId, epoch: 1 });
  });
  it('sends only API message fields when continuing a worker with saved input', async () => {
    const f = await fixture();
    const content = [{ type: 'input_text' as const, text: 'Continue' }];
    await f.execution.start('alice', f.session, { turn: f.turn, input: [
      { role: 'user', content, id: 'message', afterItemId: 'previous', acceptedOrdinal: 1 },
    ] });
    expect(f.start).toHaveBeenCalledExactlyOnceWith({ runId: f.run.runId, execution: f.run.execution }, f.turn, [{ role: 'user', content }], { model: 'fixture', reasoning: { effort: null }, service_tier: 'auto' });
  });
  it('strips private attribution and ordering fields from AWS steer input before strict worker parsing', async () => {
    const f = await fixture();
    const input = [{ role: 'user' as const, content: [{ type: 'input_text' as const, text: '[Authenticated participant alice] Continue' }],
      id: 'message', actor: { id: 'alice', kind: 'human' as const }, provenance: { kind: 'authenticated' as const }, afterItemId: 'previous', acceptedOrdinal: 2 }];
    f.steer.mockImplementation(async (...args: unknown[]) => { parseAgentsContract('SessionEvents', { events: [{ type: 'agent.session.input.message', input: args[3] }] }); });
    await f.execution.steer('alice', f.session, f.turn.id, input, 'operation');
    expect(f.steer).toHaveBeenCalledExactlyOnceWith({ runId: f.run.runId, execution: f.run.execution, turnId: f.turn.id }, '[Authenticated participant alice] Continue', 'operation', input.map(({ role, content }) => ({ role, content })));
  });
  it.each(['disabled', 'restricted', 'enabled'] as const)('matches managed stdio MCP admission with %s network access', async (access) => {
    const f = await fixture();
    const agent = sessionAgent({ model: 'fixture', tools: [{ type: 'mcp', server_label: 'local',
      transport: { type: 'stdio', command: 'node', args: ['server.js'], cwd: '/workspace' },
    }] }, 'agent', 100);
    const preparation = f.execution.prepare('alice', `managed-${access}`, {
      type: 'openai_hosted', network: { access, allowed_domains: access === 'restricted' ? ['api.example.com'] : [] },
    }, agent, []);
    if (access === 'enabled') await expect(preparation).resolves.toMatchObject({ type: 'openai_hosted', network: { access } });
    else await expect(preparation).rejects.toMatchObject({ status: 400, param: 'environment.network' });
  });
  it('submits a native harness launch when a previous worker has stopped', async () => {
    const f = await fixture();
    f.run.status = 'succeeded';
    f.submit.mockResolvedValueOnce(f.run);
    await f.execution.start('alice', f.session, { turn: f.turn, input: [] });
    expect(f.submit).toHaveBeenCalledExactlyOnceWith('alice', expect.objectContaining({
      agent: expect.objectContaining({ driver: 'codex' }),
    }), expect.objectContaining({ agentsSession: expect.objectContaining({ sessionId: 'sess', turnId: 'followup' }) }));
    expect(f.start).not.toHaveBeenCalled();
  });

  it('keeps a new Turn queued while the previous harness is terminal and replacement dispatch is pending', async () => {
    const f = await fixture();
    f.run.status = 'failed';
    await f.runtime.publish('alice', f.session.id, f.run.runId, {
      ...initialSessionRuntime(f.session.id, f.session.agent.id, 'root'),
      turns: [{ threadId: 'root', nativeTurnId: 'previous-native', turn: { ...f.turn, id: 'previous', status: 'completed' }, items: [] }],
    });
    expect(await f.execution.observe('alice', f.session, f.turn)).toEqual({ turn: f.turn, requiredActions: [] });
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
  });

  it('still fails an acknowledged active Turn when its harness stops', async () => {
    const f = await fixture();
    f.run.status = 'failed';
    await f.runtime.publish('alice', f.session.id, f.run.runId, {
      ...initialSessionRuntime(f.session.id, f.session.agent.id, 'root'),
      turns: [{ threadId: 'root', nativeTurnId: 'native', turn: { ...f.turn, status: 'in_progress' }, items: [] }],
    });
    expect(await f.execution.observe('alice', f.session, f.turn)).toMatchObject({
      turn: { id: f.turn.id, status: 'failed', error: { code: 'connection_failed' } }, requiredActions: [],
    });
  });

  it('does not attribute the previous harness output to unacknowledged input', async () => {
    const f = await fixture();
    expect(await f.execution.items('alice', f.session, f.turn.id)).toEqual([]);
    expect(f.events).not.toHaveBeenCalled();
  });

  it('addresses steering and cancellation to the requested Turn in a reused worker', async () => {
    const f = await fixture();
    const input = [{ role: 'user' as const, content: [{ type: 'input_text' as const, text: 'Continue' }] }];
    await f.execution.steer('alice', f.session, 'intended_turn', input, 'operation_1');
    await f.execution.cancel('alice', f.session, 'intended_turn');
    const target = { runId: f.run.runId, execution: f.run.execution, turnId: 'intended_turn' };
    expect(f.steer).toHaveBeenCalledExactlyOnceWith(target, 'Continue', 'operation_1', input);
    expect(f.interrupt).toHaveBeenCalledExactlyOnceWith(target);
  });

  it('validates the 256-character idempotency boundary before accepting input', async () => {
    const f = await fixture();
    await f.store.put({ id: f.session.id, ownerId: 'alice', collection: 'sessions', createdAt: 100, revision: 1, value: { session: f.session, turns: [], receipts: {}, deletedArtifacts: [] } }, 0);
    const sessions = new SessionService({ store: f.store, agents: new AgentService({ store: f.store }), execution: f.execution, clock: f.clock });
    const body = { events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: 'Continue' }] }] }] };
    await expect(sessions.events('alice', f.session.id, body, 'x'.repeat(257))).rejects.toMatchObject({ status: 400, param: 'Idempotency-Key' });
    await expect(sessions.events('alice', f.session.id, body, 'x'.repeat(256))).resolves.toBeUndefined();
    await expect(sessions.events('alice', f.session.id, body, 'x'.repeat(256))).resolves.toBeUndefined();
    expect((await sessions.turns('alice', f.session.id, {})).data).toHaveLength(1);
  });


});


describe('Session observation before the first Run', () => {
  it.each([
    ['openai_hosted', 'pending', 'in_progress'],
    ['openai_hosted', 'disconnected', 'in_progress'],
    ['openai_hosted', 'connected', 'in_progress'],
    ['openai_hosted', 'failed', 'failed'],
  ] as const)('reports a %s environment that is %s as %s', async (type, status, sessionStatus) => {
    const f = await fixture();
    await f.store.delete((await f.runtime.get('alice', f.session.id))!);
    f.getRun.mockRejectedValue(new NotFoundError('Run not created yet'));
    if (type === 'openai_hosted') f.session.environment = await f.environments.prepare('alice', f.session.id, { type });
    if (f.session.environment.type === 'none') throw new Error('Expected an execution environment');
    const environment = (await f.store.get<StoredEnvironment>('alice', 'environments', f.session.environment.id))!;
    await f.store.put({ ...environment, revision: environment.revision + 1,
      value: { ...environment.value, status, connectedUntil: 145 },
    }, environment.revision);
    await f.store.put({ id: f.session.id, ownerId: 'alice', collection: 'sessions', createdAt: 100, revision: 1,
      value: { session: f.session, turns: [{ turn: f.turn, input: [] }], receipts: {}, deletedArtifacts: [] },
    }, 0);
    const sessions = new SessionService({ store: f.store, agents: new AgentService({ store: f.store }), execution: f.execution, clock: f.clock });

    const snapshot = await sessions.streamSnapshot('alice', f.session.id);

    expect(snapshot.session).toMatchObject({
      status: sessionStatus,
      required_actions: [],
      error: status === 'failed' ? 'The execution environment is unavailable. Create a new session.' : null,
    });
    expect(snapshot.environment).toMatchObject({ type, status,
      error: status === 'failed' ? { code: 'environment_unavailable' } : null,
    });
    expect(snapshot.turns).toEqual([f.turn]);
    expect(f.getRun).toHaveBeenCalled();
    expect(f.events).not.toHaveBeenCalled();
  });
});

describe('saved Session placement', () => {
  it.each(['microvm', 'ec2'] as const)('submits a replacement on the saved %s backend', async backend => {
    const f = await fixture({ ec2Workloads: [], availableBackends: ['microvm', 'ec2'] });
    f.run.status = 'failed';
    f.session.environment = { type: 'none' };
    f.submit.mockResolvedValue(f.run);
    await f.execution.start('alice', f.session, { turn: f.turn, input: [] }, [], backend);
    expect(f.submit).toHaveBeenCalledWith('alice', expect.objectContaining({ execution: { backend, timeoutSeconds: 28_000 } }), expect.anything());
  });

  it('uses saved EC2 placement for hosted bootstrap with no initial input', async () => {
    const f = await fixture({ ec2Workloads: [], availableBackends: ['microvm', 'ec2'] });
    await f.store.delete((await f.runtime.get('alice', f.session.id))!);
    f.session.environment = await f.environments.prepare('alice', f.session.id, { type: 'openai_hosted' });
    f.submit.mockResolvedValue(f.run);
    await f.execution.initialize('alice', f.session, 'ec2');
    expect(f.submit).toHaveBeenCalledWith('alice', expect.objectContaining({ execution: { backend: 'ec2', timeoutSeconds: 28_000 } }), expect.objectContaining({ agentsSession: expect.objectContaining({ turnId: 'bootstrap' }) }));
  });

  it('seeds a fresh managed harness with completed conversation history before its first continuation', async () => {
    const f = await fixture();
    await f.store.delete((await f.runtime.get('alice', f.session.id))!);
    f.session.environment = await f.environments.prepare('alice', f.session.id, { type: 'openai_hosted' });
    f.submit.mockResolvedValue(f.run);
    const history = [{ id: 'prior-message', type: 'message' as const, role: 'user' as const, turn_id: 'prior-turn',
      status: 'completed' as const, phase: null, content: [{ type: 'input_text' as const, text: 'Remember this conversation-only context.' }] }];
    await f.execution.initialize('alice', f.session, 'microvm', history);
    expect(f.putJson).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ history, input: [], turnId: 'bootstrap' }));
    expect(f.start).not.toHaveBeenCalled();
  });

  it('rejects an unavailable saved backend before launch effects', async () => {
    const f = await fixture();
    f.run.status = 'failed';
    await expect(f.execution.start('alice', f.session, { turn: f.turn, input: [] }, [], 'ec2')).rejects.toMatchObject({ status: 503 });
    expect(f.putJson).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
  });
});


it('launches with the fixed admission reference while applying the accepted Turn model settings', async () => {
  const f = await fixture();
  const sessions = new SessionService({ store: f.store, agents: new AgentService({ store: f.store }), execution: f.execution, clock: f.clock });
  const session = await sessions.create('alice', { agent: { model: 'gpt-6-sol' }, environment: { type: 'none' }, input: 'Start' });
  await sessions.update('alice', session.id, { agent: { reasoning: { effort: 'high' } } });
  f.submit.mockResolvedValue(f.run);
  await sessions.dispatch('alice', session.id);
  const launch = f.putJson.mock.calls.at(-1)?.[1] as import('../../src/domain/session-execution.js').SessionLaunch;
  expect(launch.configuration).toEqual({ subject: { kind: 'session', id: session.id }, revision: 1 });
  expect(launch.agent.reasoning.effort).toBe(session.agent.reasoning.effort);
  const state = (await f.store.get<import('../../src/core/session-ports.js').SessionState>('alice', 'sessions', session.id))!.value;
  expect(state.configuration!.current.revision).toBeGreaterThan(launch.configuration!.revision);
});

it.each(['closing', 'fork'] as const)('does not continue an active harness when %s wins legacy baseline admission', async fence => {
  const f = await fixture();
  const resource = { ownerId: 'alice', id: f.session.id, collection: 'sessions', createdAt: 100, revision: 1,
    value: { session: f.session, turns: [], receipts: {}, deletedArtifacts: [] } };
  await f.store.put(resource, 0);
  const commit = f.store.commit.bind(f.store); let race = true;
  vi.spyOn(f.store, 'commit').mockImplementation(async (writes, observations) => {
    if (race && writes.some(write => write.resource.collection === 'sessions')) {
      race = false;
      await commit([{ resource: { ...resource, revision: 2, value: { ...resource.value,
        ...(fence === 'closing' ? { closing: true } : { forkLock: { id: 'fork', expiresAt: 9999999999 } }),
      } }, expectedRevision: 1 }]);
      throw new AgentsApiError(409, 'Resource changed concurrently.', 'conflict');
    }
    await commit(writes, observations);
  });
  await f.execution.start('alice', f.session, { turn: f.turn, input: [] });
  expect(f.start).not.toHaveBeenCalled();
  expect(f.submit).not.toHaveBeenCalled();
  expect(f.putJson).not.toHaveBeenCalled();
});

it('continues an active harness with the refreshed legacy Session after baseline contention', async () => {
  const f = await fixture();
  const resource = { ownerId: 'alice', id: f.session.id, collection: 'sessions', createdAt: 100, revision: 1,
    value: { session: f.session, turns: [], receipts: {}, deletedArtifacts: [] } };
  await f.store.put(resource, 0);
  const commit = f.store.commit.bind(f.store); let race = true;
  vi.spyOn(f.store, 'commit').mockImplementation(async (writes, observations) => {
    if (race && writes.some(write => write.resource.collection === 'sessions')) {
      race = false;
      await commit([{ resource: { ...resource, revision: 2, value: { ...resource.value, session: { ...f.session, agent: { ...f.session.agent, model: 'refreshed' } } } }, expectedRevision: 1 }]);
      throw new AgentsApiError(409, 'Resource changed concurrently.', 'conflict');
    }
    await commit(writes, observations);
  });
  await f.execution.start('alice', f.session, { turn: f.turn, input: [] });
  expect(f.start).toHaveBeenCalledExactlyOnceWith({ runId: f.run.runId, execution: f.run.execution }, f.turn, [], expect.objectContaining({ model: 'refreshed' }));
  expect(f.submit).not.toHaveBeenCalled();
});
