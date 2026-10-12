import { expect, it, vi } from 'vitest';
import { integrationFixture } from './integration-fixtures.js';
import { publicTemplate } from '../../src/domain/environment-planning.js';
import { planSessionFork } from '../../src/core/session-fork-planning.js';
import type { SessionState } from '../../src/core/session-ports.js';
import { routeAgentsRequest } from '../../src/lambdas/agents-router.js';
import { AgentService } from '../../src/core/agent-service.js';

async function fixture() {
  const f = await integrationFixture();
  const environment = { ...publicTemplate({ network: { access: 'restricted', allowed_domains: ['example.com'] } }, { id: 'env_source', created_at: 1, updated_at: 1 }), type: 'openai_hosted' as const, files: [], skills: [] };
  f.execution.prepare = async () => environment;
  const source = await f.sessions.create('operator', { agent_id: f.agent.id, environment: { type: 'openai_hosted' }, input: 'Remember source', metadata: { source: 'only' }, vault_ids: ['vault_a'] });
  await f.sessions.dispatch('operator', source.id);
  const observed = [...f.observations.values()][0]!;
  f.observations.set(observed.turn.id, { ...observed, turn: { ...observed.turn, status: 'completed', completed_at: 2 } });
  const prepare = vi.fn(async () => ({ environment: { ...environment, id: 'env_child' }, fork: { sourceSessionId: source.id, sourceEnvironmentId: environment.id,
    checkpoint: { id: 'checkpoint', source: { runId: 'run', generation: 'generation' }, sandboxId: 'sandbox', setupDigest: 'setup', policyDigest: 'policy', rootThreadId: 'root', lastRootTurnId: observed.turn.id, lastNativeTurnId: 'native', reason: 'hibernate' as const, createdAt: 1 },
    lease: { id: 'lease', expiresAt: 9999999999 }, storageKey: 'snapshot' } }));
  f.execution.prepareFork = prepare;
  return { ...f, source: await f.sessions.retrieve('operator', source.id), prepare };
}

it('branches the snapshotted agent, keeps private recovery history and starts with empty public history', async () => {
  const f = await fixture();
  await new AgentService({ store: f.store }).update('operator', f.agent.id, { instructions: 'changed saved agent' });
  const fork = await f.sessions.fork('operator', f.source.id, { vault_ids: [], environment: { network: { access: 'disabled' } } });
  expect(fork.agent).toEqual(f.source.agent);
  expect(fork.metadata).toEqual({});
  expect(fork.vault_ids).toEqual([]);
  expect((await f.sessions.items('operator', fork.id)).data).toEqual([]);
  expect((await f.sessions.turns('operator', fork.id)).data).toEqual([]);
  expect(await f.sessions.lineage('operator', fork.id)).toEqual({ forked_from: { session_id: f.source.id, turn_id: [...f.observations.keys()][0], created_at: fork.created_at } });
  const saved = (await f.store.get<SessionState>('operator', 'sessions', fork.id))!;
  expect(JSON.stringify(saved.value.fork?.history)).toContain('Remember source');
  await expect(f.sessions.events('operator', f.source.id, { events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: 'race' }] }] }] })).rejects.toMatchObject({ code: 'session_busy' });
  await expect(f.sessions.delete('operator', f.source.id)).rejects.toMatchObject({ code: 'session_busy' });
  const parent = (await f.store.get<SessionState>('operator', 'sessions', f.source.id))!;
  const { forkLock: _lock, ...value } = parent.value;
  await f.store.put({ ...parent, revision: parent.revision + 1, value }, parent.revision);
  await f.sessions.delete('operator', f.source.id);
  await f.sessions.events('operator', fork.id, { events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: 'continue' }] }] }] });
  await f.sessions.dispatch('operator', fork.id);
  expect(JSON.stringify(vi.mocked(f.execution.start).mock.calls.at(-1)?.[3])).toContain('Remember source');
});

it('rejects authority widening, busy sources, unsupported environments and cross-owner reads before effects', async () => {
  const f = await fixture();
  for (const body of [{ vault_ids: ['vault_b'] }, { environment: { network: { access: 'enabled' } } }, { environment: { network: { access: 'restricted', allowed_domains: ['elsewhere.com'] } } }, { agent: {} }]) await expect(f.sessions.fork('operator', f.source.id, body)).rejects.toMatchObject({ status: 400 });
  for (const status of ['in_progress', 'requires_action'] as const) expect(() => planSessionFork({ ...f.source, status }, {})).toThrow('idle');
  expect(() => planSessionFork({ ...f.source, environment: { type: 'none' } }, {})).toThrow('managed');
  await expect(f.sessions.fork('other', f.source.id, {})).rejects.toMatchObject({ status: 404 });
  expect(f.prepare).not.toHaveBeenCalled();
});

it('checks read, write and inference scopes before fork effects', async () => {
  const f = await fixture();
  const services = { agents: new AgentService({ store: f.store }), sessions: f.sessions };
  for (const scopes of [['api.agents.write'], ['api.agents.read'], ['api.agents.read', 'api.agents.write']] as const) {
    const result = await routeAgentsRequest(new Request(`https://example/v1/agents/sessions/${f.source.id}/fork`, { method: 'POST', body: JSON.stringify({ input: 'run' }) }), { ownerId: 'operator', scopes }, services);
    expect(result.status).toBe(403);
  }
  expect(f.prepare).not.toHaveBeenCalled();
});

it('creates child-owned inline MCP credentials so deleting the source cannot revoke the child', async () => {
  const { SessionToolService } = await import('../../src/core/session-tool-service.js');
  const { sessionAgent } = await import('../../src/core/session-planning.js');
  const { MemoryAgentsStore } = await import('./fixtures.js');
  const store = new MemoryAgentsStore();
  const values = new Map<string, import('../../src/credentials/session-tools.js').SessionCredentialSecret>();
  const service = new SessionToolService({ store, secrets: {
    reference: (identity, attempt) => `${identity.sessionId}/${attempt}`,
    create: async (value, reference) => { values.set(reference, value); },
    revoke: async reference => { values.delete(reference); },
    readTool: async (reference, identity) => {
      const value = values.get(reference) as import('../../src/credentials/session-tools.js').SessionToolSecret;
      expect(value).toMatchObject(identity); return value;
    },
  }, vaults: { requireVaults: async () => {}, resolve: vi.fn().mockResolvedValue(undefined) } });
  const tools: import('../../src/domain/agents-api.js').AgentToolParam[] = [{ type: 'mcp', server_label: 'crm', transport: { type: 'http', server_url: 'https://example.com/mcp', authorization: 'Bearer private-inline' } }];
  const f = await fixture();
  const agent = sessionAgent({ model: 'test', tools }, 'agent', 1);
  const source = { ...f.source, id: 'source', agent, vault_ids: [] };
  await service.prepare('operator', 'source', agent, tools, []);
  await service.prepare('operator', 'child', agent, await service.forkTools('operator', source), []);
  const one = await service.launch('operator', source);
  const two = await service.launch('operator', { ...source, id: 'child' });
  expect(one[0]!.inlineReference).not.toBe(two[0]!.inlineReference);
  expect(JSON.stringify([...store.resources.values()])).not.toContain('private-inline');
  await service.close('operator', 'source');
  expect(values.has(one[0]!.inlineReference!)).toBe(false);
  expect(values.get(two[0]!.inlineReference!)).toMatchObject({ sessionId: 'child', headers: { Authorization: 'Bearer private-inline' } });
});

it.each([false, true])('retains child admission after a lost commit acknowledgement (read failure=%s)', async readFailure => {
  const f = await fixture();
  const release = vi.fn(async () => {}); f.execution.releaseFork = release;
  const commit = f.store.commit.bind(f.store), get = f.store.get.bind(f.store);
  let childId: string | undefined, failRead = false;
  vi.spyOn(f.store, 'commit').mockImplementation(async writes => {
    await commit(writes);
    const child = writes.find(write => write.resource.collection === 'sessions' && write.resource.id !== f.source.id);
    if (child) { childId = child.resource.id; failRead = readFailure; throw new Error('Lost acknowledgement'); }
  });
  vi.spyOn(f.store, 'get').mockImplementation(async (owner, collection, id) => {
    if (failRead && collection === 'sessions' && id === childId) { failRead = false; throw new Error('Read unavailable'); }
    return get(owner, collection, id);
  });
  if (readFailure) await expect(f.sessions.fork('operator', f.source.id, {})).rejects.toThrow('Lost acknowledgement');
  else expect((await f.sessions.fork('operator', f.source.id, {})).id).toBe(childId);
  expect(release).not.toHaveBeenCalled();
  expect((await get<SessionState>('operator', 'sessions', f.source.id))?.value.forkLock?.id).toBe(childId);
  expect((await get<SessionState>('operator', 'sessions', childId!))?.value.fork).toBeDefined();
});

it('releases admission after failed preparation and rejects a concurrent fork while deletion closes', async () => {
  const f = await fixture();
  f.prepare.mockRejectedValueOnce(new Error('Preparation failed'));
  await expect(f.sessions.fork('operator', f.source.id, {})).rejects.toThrow('Preparation failed');
  expect((await f.store.get<SessionState>('operator', 'sessions', f.source.id))?.value.forkLock).toBeUndefined();
  let done!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.execution.close = async () => { entered(); await new Promise<void>(resolve => { done = resolve; }); };
  const deleting = f.sessions.delete('operator', f.source.id);
  await started;
  await expect(f.sessions.fork('operator', f.source.id, {})).rejects.toMatchObject({ code: 'session_busy' });
  done(); await deleting;
});
