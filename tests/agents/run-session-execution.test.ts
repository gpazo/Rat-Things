import { iamApiPrincipal } from '../../src/domain/api-permissions.js';
import { describe, expect, it, vi } from 'vitest';
import { RunSessionExecution } from '../../src/app/run-session-execution.js';
import { SessionRuntimeStore } from '../../src/core/session-runtime-store.js';
import { initialSessionRuntime } from '../../src/core/session-runtime-planning.js';
import { sessionAgent } from '../../src/core/session-planning.js';
import { EnvironmentService } from '../../src/core/environment-service.js';
import { EnvironmentTemplateService } from '../../src/core/environment-template-service.js';
import { AgentsApiError } from '../../src/domain/agents-api-validation.js';
import type { AgentSession, Turn } from '../../src/domain/agents-api.js';
import type { RunRecord } from '../../src/domain/contracts.js';
import { MemoryAgentsStore } from './fixtures.js';
import { SessionService } from '../../src/core/session-service.js';
import { AgentService } from '../../src/core/agent-service.js';
import { routeAgentsRequest } from '../../src/lambdas/agents-router.js';

async function fixture() {
  const store = new MemoryAgentsStore();
  let now = 100;
  const environments = new EnvironmentService({ store, clock: { now: () => now }, relayURL: 'https://relay.example/agents/api', credentials: {
    create: async (_owner, id) => id,
    read: async () => ({ executor: 'executor', harness: 'harness' }), revoke: async () => {},
  }, templates: new EnvironmentTemplateService({ store }), managedFiles: async () => [] });
  const environment = await environments.prepare('alice', 'sess', { type: 'self_hosted', workspace_directory: '/workspace' });
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
  const cancel = vi.fn(async () => run);
  const putJson = vi.fn(async (key: string) => ({ bucket: 'private', key, sha256: 'fixture' }));
  const execution = new RunSessionExecution({ store, environments,
    runs: { get: async () => run, idFor: () => 'unused', cancel, submit },
    interaction: { startSessionTurn: start, events, steer, interrupt, respond: async () => {} },
    artifacts: { getJson: async () => { throw new Error('Unexpected object read'); }, putJson, getBytes: async () => new Uint8Array(), getStream: async () => { throw new Error('Unexpected stream'); } },
    vaults: { requireVaults: async () => {} }, tools: { prepare: async () => {}, launch: async () => [], close: async () => {} },
  });
  if (environment.type !== 'self_hosted') throw new Error('Unexpected environment');
  const connect = () => environments.connection({ ownerId: 'alice', environmentId: environment.id, role: 'executor' }, `connection_${now}`, true);
  return { execution, session, turn, run, submit, cancel, putJson, start, steer, interrupt, events, runtime, environments, connect, store, clock: { now: () => now }, now: (time: number) => { now = time; } };
}

describe('persistent harness input admission', () => {
  it('waits for the native control bridge even after the Run starts heartbeating', async () => {
    const f = await fixture(); await f.connect();
    f.events.mockResolvedValueOnce({ runId: f.run.runId, active: true, ready: false, oldestSequence: 0, nextSequence: 0, events: [], pendingRequests: [] });
    await expect(f.execution.start('alice', f.session, { turn: f.turn, input: [] })).rejects.toMatchObject({ status: 503, code: 'service_unavailable' });
    expect(f.start).not.toHaveBeenCalled();
    await f.execution.start('alice', f.session, { turn: f.turn, input: [] });
    expect(f.start).toHaveBeenCalledTimes(1);
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
    expect((await f.runtime.get('alice', f.session.id))?.value).toEqual({ closed: true, runId: null });
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
    expect((await f.runtime.get('alice', f.session.id))?.value).toEqual({ closed: true, runId: f.run.runId });
  });
  it('sends only API message fields when continuing a worker with saved input', async () => {
    const f = await fixture();
    await f.connect();
    const content = [{ type: 'input_text' as const, text: 'Continue' }];
    await f.execution.start('alice', f.session, { turn: f.turn, input: [
      { role: 'user', content, id: 'message', afterItemId: 'previous', acceptedOrdinal: 1 },
    ] });
    expect(f.start).toHaveBeenCalledExactlyOnceWith({ runId: f.run.runId, execution: f.run.execution }, f.turn, [{ role: 'user', content }], { model: 'fixture', reasoning: { effort: null }, service_tier: 'auto' });
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
    await f.connect();
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
  it.each([false, true])('holds the HTTP acknowledgement for connection, with expired=%s', async (expired) => {
    const f = await fixture();
    await f.store.put({ id: f.session.id, ownerId: 'alice', collection: 'sessions', createdAt: 100, revision: 1, value: { session: f.session, turns: [], receipts: {}, deletedArtifacts: [] } }, 0);
    const agents = new AgentService({ store: f.store });
    const sessions = new SessionService({ store: f.store, agents, execution: f.execution, clock: f.clock, streamIntervalMs: 1 });
    let inspected!: () => void; const inspecting = new Promise<void>((resolve) => { inspected = resolve; });
    const check = f.execution.checkInputConnection.bind(f.execution);
    f.execution.checkInputConnection = async (...args) => { inspected(); await check(...args); };
    let settled = false;
    const response = routeAgentsRequest(new Request('https://api.example/v1/agents/sessions/sess/events', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'input' }, body: JSON.stringify({ events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: 'Continue' }] }] }] }) }), iamApiPrincipal('alice'), { agents, sessions }).then((value) => { settled = true; return value; });
    await Promise.race([inspecting, response.then(async (value) => { throw new Error(`Response settled before waiting: ${value.status} ${await value.text()}`); })]); expect(settled).toBe(false); expect(f.start).not.toHaveBeenCalled();
    if (expired) f.now(401);
    await f.connect();
    expect((await response).status).toBe(expired ? 408 : 204);
    await sessions.dispatch('alice', f.session.id);
    expect(f.start).toHaveBeenCalledTimes(expired ? 0 : 1);
    if (expired) expect((await sessions.turns('alice', f.session.id, {})).data[0]).toMatchObject({ status: 'failed', error: { code: 'connection_failed' } });
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

  it('waits for reconnection before sending a new Turn to an existing harness', async () => {
    const f = await fixture();
    await expect(f.execution.start('alice', f.session, { turn: f.turn, input: [] })).rejects.toMatchObject({ status: 503 });
    expect(f.start).not.toHaveBeenCalled();
    await f.connect();
    await f.execution.start('alice', f.session, { turn: f.turn, input: [] });
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(f.start).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run' }), f.turn, [], { model: 'fixture', reasoning: { effort: null }, service_tier: 'auto' });
  });

  it('does not replay input when the executor connects after its deadline', async () => {
    const f = await fixture(); f.now(401); await f.connect();
    await expect(f.execution.start('alice', f.session, { turn: f.turn, input: [] })).rejects.toMatchObject({ status: 408, code: 'environment_connection_timeout' });
    expect(f.start).not.toHaveBeenCalled();
  });

  it.each([false, true])('acknowledges saved work without replay after disconnect, with stopped harness=%s', async (stopped) => {
    const f = await fixture();
    await f.runtime.publish('alice', f.session.id, 'run', { ...initialSessionRuntime(f.session.id, f.session.agent.id, 'root'), turns: [{ threadId: 'root', nativeTurnId: 'native', turn: { ...f.turn, status: 'completed' }, items: [] }] });
    f.now(401);
    if (stopped) { f.run.status = 'succeeded'; await f.runtime.close('alice', f.session.id); }
    await expect(f.execution.checkInputConnection('alice', f.session, f.turn)).resolves.toBeUndefined();
    await expect(f.execution.start('alice', f.session, { turn: f.turn, input: [] })).resolves.toBeUndefined();
    expect(f.start).not.toHaveBeenCalled();
    await expect(f.execution.checkInputConnection('alice', f.session, { ...f.turn, id: 'another' })).rejects.toBeInstanceOf(AgentsApiError);
  });

  it('rechecks native acknowledgement when the executor disconnects during the HTTP wait', async () => {
    const f = await fixture();
    vi.spyOn(f.environments, 'launchReference').mockImplementation(async () => {
      await f.runtime.publish('alice', f.session.id, 'run', { ...initialSessionRuntime(f.session.id, f.session.agent.id, 'root'), turns: [{ threadId: 'root', nativeTurnId: 'native', turn: { ...f.turn, status: 'in_progress' }, items: [] }] });
      throw new AgentsApiError(408, 'Connection deadline elapsed', 'environment_connection_timeout');
    });
    await expect(f.execution.checkInputConnection('alice', f.session, f.turn)).resolves.toBeUndefined();
    expect(f.start).not.toHaveBeenCalled();
  });
});
