import { describe, expect, it, vi } from 'vitest';
import { VaultService } from '../../src/core/vault-service.js';
import { sessionAgent } from '../../src/core/session-planning.js';
import { SessionService } from '../../src/core/session-service.js';
import { SessionToolService } from '../../src/core/session-tool-service.js';
import { planPreparationReconciliation, type SessionPreparation } from '../../src/core/session-preparation-planning.js';
import { integrationFixture } from './integration-fixtures.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function fixture() {
  const f = await integrationFixture();
  const clock = { now: vi.fn(() => 100) };
  const secrets = { reference: (_identity: unknown, attempt: string) => attempt, create: vi.fn(async () => {}), revoke: vi.fn(async () => {}) };
  const tools = new SessionToolService({ store: f.store, clock, secrets, vaults: new VaultService({ store: f.store, secrets: { create: async () => { throw new Error('No vault credentials'); }, read: async () => { throw new Error('No vault credentials'); }, revoke: async () => {} } }) });
  const sessions = new SessionService({ store: f.store, clock, agents: { retrieve: async () => f.agent }, execution: f.execution, ids: { next: (prefix) => `${prefix}_test` } });
  f.execution.prepare = async (owner, id, _environment, agent, vaultIds, transports = [], resume) => {
    await tools.prepare(owner, id, agent, transports, vaultIds, resume);
    return { type: 'none' };
  };
  const input = { agent: { model: 'test', tools: [{ type: 'mcp', server_label: 'crm', transport: { type: 'http', server_url: 'https://crm.example/mcp', authorization: 'private-value' } }] }, environment: { type: 'none' }, input: 'Start' };
  return { ...f, sessions, tools, clock, secrets, input };
}

describe('abandoned Session preparation retention', () => {
  it('journals ordinary HTTP creation before secret effects and retires adopted credentials after a failed final write', async () => {
    const f = await fixture();
    const commit = f.store.commit.bind(f.store);
    vi.spyOn(f.store, 'commit').mockImplementation(async (writes) => {
      if (writes.some(({ resource }) => resource.collection === 'sessions')) throw new Error('Final write unavailable');
      return commit(writes);
    });
    f.secrets.create.mockImplementationOnce(async () => {
      expect(await f.store.get('operator', 'session_preparations', 'sess_test')).toBeDefined();
    });
    await expect(f.sessions.create('operator', f.input)).rejects.toThrow('Final write unavailable');
    expect(await f.tools.reconcilePreparation('operator', 'sess_test')).toEqual({ status: 'waiting', retryAfterSeconds: 86_400 });
    expect(f.secrets.revoke).not.toHaveBeenCalled();
    f.clock.now.mockReturnValue(86_500);
    await f.tools.reconcilePreparation('operator', 'sess_test');
    expect(f.secrets.revoke).toHaveBeenCalledOnce();
    expect(await f.store.get('operator', 'session_tools', 'sess_test')).toBeUndefined();
    expect((await f.store.get<SessionPreparation>('operator', 'session_preparations', 'sess_test'))?.value.abandoned).toBe(true);
    expect(JSON.stringify([...f.store.resources.values()])).not.toContain('private-value');
    await expect(f.sessions.create('operator', f.input, 'sess_test')).rejects.toMatchObject({ code: 'session_preparation_expired' });
    expect(f.secrets.create).toHaveBeenCalledOnce();
  });

  it('fences a delayed final Session commit after cleanup wins', async () => {
    const f = await fixture();
    const entered = deferred(), resume = deferred();
    const commit = f.store.commit.bind(f.store);
    vi.spyOn(f.store, 'commit').mockImplementation(async (writes) => {
      if (writes.some(({ resource }) => resource.collection === 'sessions')) { entered.resolve(); await resume.promise; }
      return commit(writes);
    });
    const create = f.sessions.create('operator', f.input, 'sess_test');
    const rejected = expect(create).rejects.toMatchObject({ code: 'conflict' });
    await entered.promise;
    f.clock.now.mockReturnValue(86_500);
    await f.tools.reconcilePreparation('operator', 'sess_test');
    resume.resolve(); await rejected;
    expect(await f.store.get('operator', 'sessions', 'sess_test')).toBeUndefined();
    expect(f.secrets.revoke).toHaveBeenCalledOnce();
  });

  it('preserves the Session and credentials when final creation wins a concurrent cleanup fence', async () => {
    const f = await fixture();
    const finalReady = deferred(), finish = deferred(), cleanupReady = deferred(), cleanup = deferred();
    const commit = f.store.commit.bind(f.store);
    vi.spyOn(f.store, 'commit').mockImplementation(async (writes) => {
      if (writes.some(({ resource }) => resource.collection === 'sessions')) { finalReady.resolve(); await finish.promise; }
      if (writes.some(({ resource }) => resource.collection === 'session_preparations' && (resource.value as SessionPreparation).abandoned)) { cleanupReady.resolve(); await cleanup.promise; }
      return commit(writes);
    });
    const create = f.sessions.create('operator', f.input, 'sess_test');
    await finalReady.promise;
    f.clock.now.mockReturnValue(86_500);
    const retire = f.tools.reconcilePreparation('operator', 'sess_test');
    const rejected = expect(retire).rejects.toMatchObject({ code: 'conflict' });
    await cleanupReady.promise;
    finish.resolve(); await create;
    cleanup.resolve(); await rejected;
    expect(await f.tools.reconcilePreparation('operator', 'sess_test')).toEqual({ status: 'created' });
    expect(f.secrets.revoke).not.toHaveBeenCalled();
  });

  it('fences adoption paused during credential creation and leaves its reserved reference recoverable', async () => {
    const f = await fixture();
    const entered = deferred(), resume = deferred();
    f.secrets.create.mockImplementationOnce(async () => { entered.resolve(); await resume.promise; });
    const create = f.sessions.create('operator', f.input, 'sess_test');
    const rejected = expect(create).rejects.toMatchObject({ code: 'conflict' });
    await entered.promise;
    f.clock.now.mockReturnValue(86_500);
    await f.tools.reconcilePreparation('operator', 'sess_test');
    resume.resolve(); await rejected;
    expect(await f.store.get('operator', 'sessions', 'sess_test')).toBeUndefined();
    expect(await f.store.get('operator', 'session_tools', 'sess_test')).toBeUndefined();
    expect(f.secrets.revoke).toHaveBeenCalledOnce();
  });

  it('retries an uncertain abandonment fence and failed credential retirement', async () => {
    const f = await fixture();
    const prepare = f.execution.prepare;
    f.execution.prepare = async (...args) => { await prepare(...args); throw new Error('Interrupted'); };
    await expect(f.sessions.create('operator', f.input, 'sess_test')).rejects.toThrow('Interrupted');
    f.clock.now.mockReturnValue(86_500);
    const put = f.store.put.bind(f.store);
    vi.spyOn(f.store, 'put').mockImplementationOnce(async (...args) => { await put(...args); throw new Error('Lost fence acknowledgement'); });
    await expect(f.tools.reconcilePreparation('operator', 'sess_test')).rejects.toThrow('Lost fence acknowledgement');
    expect(f.secrets.revoke).not.toHaveBeenCalled();
    f.secrets.revoke.mockRejectedValueOnce(new Error('Secret service unavailable'));
    await expect(f.tools.reconcilePreparation('operator', 'sess_test')).rejects.toThrow('Secret service unavailable');
    const attempts = await f.store.list<{ status: string }>('operator', 'session_tool_attempts', {});
    const cleanup = attempts.data.find(({ value }) => value.status === 'cleanup')!;
    expect(cleanup).toBeDefined();
    await f.tools.reconcile('operator', cleanup.id);
    expect(await f.tools.reconcilePreparation('operator', 'sess_test')).toEqual({ status: 'cleaned' });
  });

  it('retains legacy snapshots for explicit inventory and does not reconcile another owner', async () => {
    const f = await fixture();
    const preparation: SessionPreparation = { agent: sessionAgent({ model: 'test' }, 'agent_test', 100), now: 100 };
    expect(planPreparationReconciliation(preparation, 1_000_000)).toEqual({ type: 'legacy' });
    await f.store.put({ ownerId: 'operator', collection: 'session_preparations', id: 'sess_legacy', createdAt: 100, revision: 1, value: preparation }, 0);
    expect(await f.tools.reconcilePreparation('operator', 'sess_legacy')).toEqual({ status: 'legacy' });
    expect(await f.tools.reconcilePreparation('someone-else', 'sess_legacy')).toEqual({ status: 'cleaned' });
    expect(f.secrets.revoke).not.toHaveBeenCalled();
  });
});
