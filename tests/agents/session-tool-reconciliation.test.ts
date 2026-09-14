import { describe, expect, it, vi } from 'vitest';
import { VaultService } from '../../src/core/vault-service.js';
import { SessionToolService } from '../../src/core/session-tool-service.js';
import type { SessionToolAttempt } from '../../src/core/session-tool-planning.js';
import { sessionAgent } from '../../src/core/session-planning.js';
import type { SessionToolSecret } from '../../src/credentials/session-tools.js';
import type { AgentToolParam } from '../../src/domain/agents-api.js';
import { MemoryAgentsStore } from './fixtures.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const store = new MemoryAgentsStore();
  const values = new Map<string, SessionToolSecret>();
  const retired = new Set<string>();
  const clock = { now: vi.fn(() => 100) };
  const secrets = {
    reference: (identity: Pick<SessionToolSecret, 'ownerId' | 'sessionId' | 'serverLabel'>, attempt: string) => `${attempt}/${identity.serverLabel}`,
    create: vi.fn(async (value: SessionToolSecret, reference: string) => {
      if (retired.has(reference)) throw new Error('Retired reference');
      values.set(reference, structuredClone(value));
    }),
    revoke: vi.fn(async (reference: string) => { retired.add(reference); values.delete(reference); }),
  };
  const vaults = new VaultService({ store, secrets: { create: async () => { throw new Error('No vault credentials'); }, read: async () => { throw new Error('No vault credentials'); }, revoke: async () => {} } });
  const service = new SessionToolService({ store, secrets, clock, vaults });
  const tools: AgentToolParam[] = [{ type: 'mcp', server_label: 'crm', transport: { type: 'http', server_url: 'https://crm.example/mcp', authorization: 'Bearer private-value' } }];
  const agent = sessionAgent({ model: 'test', tools }, 'agent_test', 100);
  const prepare = () => service.prepare('alice', 'sess_test', agent, tools, [], true);
  const attempts = async () => (await store.list<SessionToolAttempt>('alice', 'session_tool_attempts', {})).data;
  return { store, values, retired, secrets, service, clock, prepare, attempts };
}

describe('durable Session tool reconciliation', () => {
  it('recovers an uncertain secret creation even when immediate revocation fails', async () => {
    const f = fixture();
    const create = f.secrets.create.getMockImplementation()!;
    f.secrets.create.mockImplementationOnce(async (...args) => { await create(...args); throw new Error('Creation acknowledgement lost'); });
    f.secrets.revoke.mockRejectedValueOnce(new Error('Cleanup unavailable'));
    await expect(f.prepare()).rejects.toThrow('Creation acknowledgement lost');
    const [attempt] = await f.attempts();
    expect(attempt?.value.status).toBe('cleanup');
    expect(JSON.stringify(attempt)).not.toContain('private-value');
    expect(f.values.size).toBe(1);
    await f.service.reconcile('alice', attempt!.id);
    expect(f.values.size).toBe(0);
    expect(await f.attempts()).toEqual([]);
  });

  it('retires reservations after an uncertain intent write without creating credentials', async () => {
    const f = fixture();
    const put = f.store.put.bind(f.store);
    vi.spyOn(f.store, 'put').mockImplementationOnce(async (...args) => { await put(...args); throw new Error('Intent acknowledgement lost'); });
    await expect(f.prepare()).rejects.toThrow('Intent acknowledgement lost');
    expect(f.secrets.create).not.toHaveBeenCalled();
    const [attempt] = await f.attempts();
    expect(await f.service.reconcile('alice', attempt!.id)).toEqual({ status: 'waiting', retryAfterSeconds: 300 });
    expect(f.secrets.revoke).not.toHaveBeenCalled();
    f.clock.now.mockReturnValue(400);
    await f.service.reconcile('alice', attempt!.id);
    expect(f.retired.size).toBe(1);
    expect(await f.attempts()).toEqual([]);
  });

  it('fences delayed adoption when the outbox retires an expired attempt', async () => {
    const f = fixture();
    const commit = f.store.commit.bind(f.store);
    const entered = deferred();
    const resume = deferred();
    vi.spyOn(f.store, 'commit').mockImplementation(async (writes) => {
      if (writes.some(({ resource }) => resource.collection === 'session_tools')) { entered.resolve(); await resume.promise; }
      await commit(writes);
    });
    const preparation = f.prepare();
    const rejected = expect(preparation).rejects.toMatchObject({ code: 'conflict' });
    await entered.promise;
    f.clock.now.mockReturnValue(400);
    const [attempt] = await f.attempts();
    await f.service.reconcile('alice', attempt!.id);
    resume.resolve();
    await rejected;
    expect(await f.store.get('alice', 'session_tools', 'sess_test')).toBeUndefined();
    expect(f.values.size).toBe(0);
  });

  it('rejects a delayed creation after its reserved name is retired', async () => {
    const f = fixture();
    const entered = deferred();
    const resume = deferred();
    const create = f.secrets.create.getMockImplementation()!;
    f.secrets.create.mockImplementationOnce(async (...args) => { entered.resolve(); await resume.promise; await create(...args); });
    const preparation = f.prepare();
    const rejected = expect(preparation).rejects.toThrow('Retired reference');
    await entered.promise;
    f.clock.now.mockReturnValue(400);
    const [attempt] = await f.attempts();
    await f.service.reconcile('alice', attempt!.id);
    resume.resolve();
    await rejected;
    expect(f.values.size).toBe(0);
    expect(await f.attempts()).toEqual([]);
  });

  it('protects adopted credentials when adoption wins a concurrent cleanup fence', async () => {
    const f = fixture();
    const creating = deferred();
    const createReady = deferred();
    const fencing = deferred();
    const fenceReady = deferred();
    const create = f.secrets.create.getMockImplementation()!;
    f.secrets.create.mockImplementationOnce(async (...args) => { creating.resolve(); await createReady.promise; await create(...args); });
    const put = f.store.put.bind(f.store);
    vi.spyOn(f.store, 'put').mockImplementation(async (resource, revision) => {
      if (revision === 1) { fencing.resolve(); await fenceReady.promise; }
      await put(resource, revision);
    });
    const preparation = f.prepare();
    await creating.promise;
    const [attempt] = await f.attempts();
    const cleanup = f.service.reconcile('alice', attempt!.id, true);
    const rejected = expect(cleanup).rejects.toMatchObject({ code: 'conflict' });
    await fencing.promise;
    createReady.resolve();
    await preparation;
    fenceReady.resolve();
    await rejected;
    expect(await f.service.reconcile('alice', attempt!.id)).toEqual({ status: 'adopted' });
    expect(f.secrets.revoke).not.toHaveBeenCalled();
    expect(f.values.size).toBe(1);
  });

  it('leaves a failed cleanup fence durable and retries a lost fence acknowledgement', async () => {
    const f = fixture();
    f.secrets.create.mockRejectedValueOnce(new Error('Create uncertain'));
    const put = f.store.put.bind(f.store);
    vi.spyOn(f.store, 'put').mockImplementation(async (resource, revision) => {
      await put(resource, revision);
      if (revision === 1) throw new Error('Cleanup fence acknowledgement lost');
    });
    await expect(f.prepare()).rejects.toThrow('Create uncertain');
    expect(f.secrets.revoke).not.toHaveBeenCalled();
    const [attempt] = await f.attempts();
    expect(attempt?.value.status).toBe('cleanup');
    await f.service.reconcile('alice', attempt!.id);
    expect(f.retired.size).toBe(1);
  });

  it('does not revoke after uncertain adoption while storage reads are unavailable', async () => {
    const f = fixture();
    const commit = f.store.commit.bind(f.store);
    const get = vi.spyOn(f.store, 'get');
    vi.spyOn(f.store, 'commit').mockImplementation(async (writes) => {
      await commit(writes);
      if (writes.some(({ resource }) => resource.collection === 'session_tools')) {
        get.mockRejectedValue(new Error('Read unavailable'));
        throw new Error('Adoption acknowledgement lost');
      }
    });
    await expect(f.prepare()).rejects.toThrow('Adoption acknowledgement lost');
    expect(f.secrets.revoke).not.toHaveBeenCalled();
    get.mockRestore();
    const [attempt] = await f.attempts();
    expect(attempt?.value.status).toBe('adopted');
    expect(await f.service.reconcile('alice', attempt!.id)).toEqual({ status: 'adopted' });
    expect(f.values.size).toBe(1);
    expect(f.secrets.revoke).not.toHaveBeenCalled();
  });

  it('recovers a rejected adoption after storage reads return', async () => {
    const f = fixture();
    const commit = f.store.commit.bind(f.store);
    const get = vi.spyOn(f.store, 'get');
    vi.spyOn(f.store, 'commit').mockImplementation(async (writes) => {
      if (!writes.some(({ resource }) => resource.collection === 'session_tools')) return commit(writes);
      get.mockRejectedValue(new Error('Read unavailable'));
      throw new Error('Adoption outcome unknown');
    });
    await expect(f.prepare()).rejects.toThrow('Adoption outcome unknown');
    expect(f.secrets.revoke).not.toHaveBeenCalled();
    get.mockRestore();
    f.clock.now.mockReturnValue(400);
    const [attempt] = await f.attempts();
    await f.service.reconcile('alice', attempt!.id);
    expect(f.values.size).toBe(0);
  });

  it('retains the winning preparation’s credentials across concurrent retries', async () => {
    const f = fixture();
    await Promise.all([f.prepare(), f.prepare()]);
    expect(f.secrets.create).toHaveBeenCalledTimes(2);
    expect(f.values.size).toBe(1);
    const binding = (await f.store.get<Array<{ inlineReference: string }>>('alice', 'session_tools', 'sess_test'))!.value[0]!;
    expect(f.values.has(binding.inlineReference)).toBe(true);
    for (const attempt of await f.attempts()) await f.service.reconcile('alice', attempt.id);
    expect(f.values.has(binding.inlineReference)).toBe(true);
  });

  it.each(['revoke', 'acknowledgement'] as const)('keeps deletion cleanup durable after a failed %s', async (failure) => {
    const f = fixture();
    await f.prepare();
    for (const attempt of await f.attempts()) await f.service.reconcile('alice', attempt.id);
    if (failure === 'revoke') f.secrets.revoke.mockRejectedValueOnce(new Error('Deletion interrupted'));
    else {
      const remove = f.store.delete.bind(f.store);
      vi.spyOn(f.store, 'delete').mockImplementationOnce(async (...args) => { await remove(...args); throw new Error('Deletion interrupted'); });
    }
    await expect(f.service.close('alice', 'sess_test')).rejects.toThrow('Deletion interrupted');
    expect(await f.store.get('alice', 'session_tools', 'sess_test')).toBeUndefined();
    const [attempt] = await f.attempts();
    expect(attempt?.value.status).toBe('cleanup');
    await f.service.close('alice', 'sess_test');
    await f.service.reconcile('alice', attempt!.id);
    await f.service.reconcile('alice', attempt!.id);
    expect(f.values.size).toBe(0);
    expect(await f.attempts()).toEqual([]);
  });

  it('cannot reconcile another owner’s credentials', async () => {
    const f = fixture();
    await f.prepare();
    const [attempt] = await f.attempts();
    await f.service.reconcile('bob', attempt!.id, true);
    expect(f.secrets.revoke).not.toHaveBeenCalled();
    expect(await f.attempts()).toHaveLength(1);
  });
});
