import { describe, it, expect } from 'vitest';
import type { CredentialAuthCreateParam } from 'openai/resources/beta/agents/vaults/credentials';
import { VaultService } from '../../src/core/vault-service.js';
import { planOAuthRefresh, refreshedOAuthCredential, type OAuthCredential } from '../../src/domain/vault-oauth.js';
import { HttpOAuthRefreshClient } from '../../src/adapters/oauth-refresh-client.js';
import { MemoryAgentsStore } from './fixtures.js';
import { AgentsApiError } from '../../src/domain/agents-api-validation.js';

const auth: OAuthCredential = {
  type: 'mcp_oauth', mcp_server_url: 'https://mcp.example.com', access_token: 'expired', expires_at: '2000-01-01T00:00:00Z',
  refresh: { client_id: 'client:id', refresh_token: 'refresh-original', token_endpoint: 'https://auth.example.com/token', token_endpoint_auth: { type: 'client_secret_basic', client_secret: 'client secret' }, scope: '' },
};
function fixture(refresh: () => Promise<unknown>) {
  const store = new MemoryAgentsStore();
  const secrets = new Map<string, CredentialAuthCreateParam>();
  const service = new VaultService({ store, oauth: { refresh }, secrets: {
    create: async (_owner, id, auth) => { const reference = `${id}/${crypto.randomUUID()}`; secrets.set(reference, structuredClone(auth)); return reference; },
    read: async (reference) => structuredClone(secrets.get(reference)!),
    revoke: async (reference) => { secrets.delete(reference); },
  } });
  return { store, secrets, service };
}

describe('vault OAuth refresh', () => {
  it('preserves empty scope, handles Basic encoding and explicit zero expiry without mutating inputs', () => {
    const previous = structuredClone(auth);
    const planned = planOAuthRefresh(auth);
    expect(new URLSearchParams(planned.body).get('scope')).toBe('');
    expect(Buffer.from(planned.headers.authorization!.slice(6), 'base64').toString()).toBe('client%3Aid:client+secret');
    const result = refreshedOAuthCredential(auth, { access_token: 'new-token', token_type: 'Bearer', expires_in: 0 }, 100);
    expect(result.expires_at).toBe('1970-01-01T00:01:40.000Z');
    expect(result.refresh?.refresh_token).toBe('refresh-original');
    expect(auth).toEqual(previous);
    expect(() => refreshedOAuthCredential(auth, { access_token: 'new-token', token_type: 'Basic' }, 100)).toThrow('invalid response');
  });

  it('serializes concurrent refreshes and commits the rotated grant despite unrelated vault changes', async () => {
    let count = 0;
    let enter!: () => void;
    let finish!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const f = fixture(async () => { count++; enter(); await gate; return { access_token: 'fresh', refresh_token: 'refresh-rotated', token_type: 'bearer', expires_in: 3600 }; });
    const vault = await f.service.create('alice');
    const credential = await f.service.createCredential('alice', vault.id, { name: 'MCP', auth });
    const read = () => f.service.authorization('alice', vault.id, credential.id, auth.mcp_server_url);
    const first = read();
    await entered;
    const second = read();
    await f.service.createCredential('alice', vault.id, { name: 'Unrelated', auth: { type: 'static_bearer', mcp_server_url: 'https://other.example.com', token: 'other-secret' } });
    finish();
    expect(await Promise.all([first, second])).toEqual(['Bearer fresh', 'Bearer fresh']);
    expect(count).toBe(1);
    expect([...f.secrets.values()].filter((secret) => secret.type === 'mcp_oauth')).toEqual([expect.objectContaining({ access_token: 'fresh', refresh: expect.objectContaining({ refresh_token: 'refresh-rotated' }) })]);
    expect(JSON.stringify([...f.store.resources.values()])).not.toContain('refresh-rotated');
    expect(await read()).toBe('Bearer fresh');
    await expect(f.service.authorization('bob', vault.id, credential.id, auth.mcp_server_url)).rejects.toMatchObject({ status: 404 });
    await expect(f.service.authorization('alice', vault.id, credential.id, 'https://other.example.com')).rejects.toMatchObject({ status: 404 });
    await f.service.deleteCredential('alice', vault.id, credential.id);
    await expect(read()).rejects.toMatchObject({ status: 404 });
  });

  it('keeps a concurrent manual rotation and never overwrites it with a stale refresh', async () => {
    let finish!: () => void;
    let enter!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const f = fixture(async () => { enter(); await gate; return { access_token: 'stale', refresh_token: 'stale-refresh', token_type: 'bearer', expires_in: 3600 }; });
    const vault = await f.service.create('alice');
    const credential = await f.service.createCredential('alice', vault.id, { name: 'MCP', auth });
    const reading = f.service.authorization('alice', vault.id, credential.id, auth.mcp_server_url);
    await entered;
    await f.service.updateCredential('alice', vault.id, credential.id, { auth: { type: 'mcp_oauth', access_token: 'manual' } });
    finish();
    expect(await reading).toBe('Bearer manual');
    expect([...f.secrets.values()]).toEqual([expect.objectContaining({ access_token: 'manual' })]);
  });

  it('finishes a staged refresh after prolonged storage contention without exchanging the grant twice', async () => {
    let exchanges = 0;
    const f = fixture(async () => { exchanges++; return { access_token: 'fresh', refresh_token: 'rotated-once', token_type: 'bearer', expires_in: 3600 }; });
    const vault = await f.service.create('alice');
    const credential = await f.service.createCredential('alice', vault.id, { name: 'MCP', auth });
    const commit = f.store.commit.bind(f.store);
    let conflicts = 11;
    f.store.commit = async (writes) => {
      if (writes.length === 2 && conflicts-- > 0) throw new AgentsApiError(409, 'Concurrent vault change.', 'conflict');
      return commit(writes);
    };
    const read = () => f.service.authorization('alice', vault.id, credential.id, auth.mcp_server_url);
    await expect(read()).rejects.toMatchObject({ status: 503, code: 'credential_refresh_in_progress' });
    expect(exchanges).toBe(1);
    expect(await read()).toBe('Bearer fresh');
    expect(exchanges).toBe(1);
    expect([...f.secrets.values()]).toEqual([expect.objectContaining({ access_token: 'fresh', refresh: expect.objectContaining({ refresh_token: 'rotated-once' }) })]);
  });

  it('does not follow a token endpoint redirect or expose provider diagnostics', async () => {
    const calls: RequestInit[] = [];
    const client = new HttpOAuthRefreshClient(async (_input, init) => { calls.push(init!); return new Response('secret in diagnostic', { status: 302, headers: { location: 'https://untrusted.example.com' } }); });
    await expect(client.refresh(planOAuthRefresh(auth))).rejects.toThrow('could not be refreshed');
    expect(calls[0]?.redirect).toBe('error');
    expect(calls).toHaveLength(1);
  });
});
