import OpenAI from 'openai';
import type { CredentialAuthCreateParam } from 'openai/resources/beta/agents/vaults/credentials';
import { describe, expect, it } from 'vitest';
import { AgentService } from '../../src/core/agent-service.js';
import { VaultService } from '../../src/core/vault-service.js';
import { EnvironmentTemplateService } from '../../src/core/environment-template-service.js';
import { parseAgentsContract } from '../../src/domain/agents-api-validation.js';
import { routeAgentsRequest } from '../../src/lambdas/agents-router.js';
import { MemoryAgentsStore } from './fixtures.js';

function fixture() {
  const store = new MemoryAgentsStore();
  const secrets = new Map<string, CredentialAuthCreateParam>();
  let version = 0;
  const vaults = new VaultService({ store, secrets: {
    create: async (_owner, id, auth) => { const reference = `${id}/${++version}`; secrets.set(reference, structuredClone(auth)); return reference; },
    read: async (reference) => structuredClone(secrets.get(reference)!),
    revoke: async (reference) => { secrets.delete(reference); },
  } });
  const templates = new EnvironmentTemplateService({ store });
  const agents = new AgentService({ store });
  const client = (owner: string) => new OpenAI({ apiKey: 'test', baseURL: 'https://rat.invalid/v1', maxRetries: 0,
    fetch: (input, init) => routeAgentsRequest(new Request(input, init), owner, { agents, vaults, templates }),
  }).beta.agents;
  return { store, secrets, vaults, templates, api: client('alice'), other: client('bob') };
}

describe('vault and environment template contracts', () => {
  it('keeps credential secrets outside public resources and definition storage through rotation and deletion', async () => {
    const f = fixture();
    const vault = await f.api.vaults.create({ name: '  Tools  ' });
    expect(vault.name).toBe('Tools');
    const credential = await f.api.vaults.credentials.create(vault.id, {
      name: 'GitHub', auth: { type: 'static_bearer', mcp_server_url: 'https://mcp.example.com/tools', token: 'first-secret-value' },
    });
    parseAgentsContract('Credential', credential);
    expect(JSON.stringify([...f.store.resources.values()])).not.toContain('first-secret-value');
    expect(JSON.stringify(credential)).not.toContain('first-secret-value');
    const selected = await f.vaults.resolve('alice', [vault.id], 'https://mcp.example.com/tools');
    expect(selected.credential.id).toBe(credential.id);
    const rotated = await f.api.vaults.credentials.update(credential.id, { vault_id: vault.id, auth: { type: 'static_bearer', token: 'second-secret-value' } });
    expect(rotated.id).toBe(credential.id);
    expect(JSON.stringify(rotated)).not.toContain('second-secret-value');
    expect(f.secrets.has(selected.reference)).toBe(false);
    expect(f.secrets.size).toBe(1);
    const deleted = await f.api.vaults.delete(vault.id);
    parseAgentsContract('VaultDeleted', deleted);
    expect(f.secrets.size).toBe(0);
    expect((await f.api.vaults.list({ status: 'active' })).data).toEqual([]);
    expect((await f.api.vaults.list({ status: ['archived'] })).data.map((item) => item.id)).toEqual([vault.id]);
    await expect(f.vaults.resolve('alice', [vault.id], 'https://mcp.example.com/tools')).rejects.toMatchObject({ status: 404 });
    await expect(f.api.vaults.credentials.create(vault.id, { name: 'invalid', auth: { type: 'static_bearer', mcp_server_url: 'https://mcp.example.com/tools', token: 'x' } })).rejects.toMatchObject({ status: 404 });
  });

  it('preserves OAuth expiry, refresh tokens and client secrets according to rotation semantics', async () => {
    const f = fixture();
    const vault = await f.api.vaults.create();
    const credential = await f.api.vaults.credentials.create(vault.id, { name: 'OAuth', auth: {
      type: 'mcp_oauth', mcp_server_url: 'https://mcp.example.com', access_token: 'access-a', expires_at: '2030-01-01T00:00:00Z',
      refresh: { client_id: 'public-id', token_endpoint: 'https://auth.example.com/token', refresh_token: 'refresh-a', scope: 'read', token_endpoint_auth: { type: 'client_secret_basic', client_secret: 'client-a' } },
    } });
    const rotated = await f.api.vaults.credentials.update(credential.id, { vault_id: vault.id, auth: { type: 'mcp_oauth', access_token: 'access-b', refresh: { scope: null, token_endpoint_auth: { type: 'client_secret_basic', client_secret: null } } } });
    expect(rotated.auth).toMatchObject({ expires_at: null, refresh: { scope: null, token_endpoint_auth: { type: 'client_secret_basic' } } });
    expect([...f.secrets.values()][0]).toMatchObject({ access_token: 'access-b', expires_at: null, refresh: { refresh_token: 'refresh-a', scope: null, token_endpoint_auth: { client_secret: 'client-a' } } });
    await expect(f.api.vaults.credentials.update(credential.id, { vault_id: vault.id, auth: { type: 'static_bearer', token: 'x' } })).rejects.toMatchObject({ status: 400 });
    await expect(f.api.vaults.credentials.update(credential.id, { vault_id: vault.id, auth: { type: 'mcp_oauth', refresh: { token_endpoint_auth: { type: 'client_secret_post', client_secret: 'x' } } } })).rejects.toMatchObject({ status: 400 });
    expect(f.secrets.size).toBe(1);
  });

  it('requires ownership and exact MCP destinations, and disambiguates matching credentials', async () => {
    const f = fixture();
    const vault = await f.api.vaults.create();
    const credential = await f.api.vaults.credentials.create(vault.id, { name: 'One', auth: { type: 'static_bearer', mcp_server_url: 'https://mcp.example.com/a', token: 'token' } });
    await expect(f.other.vaults.retrieve(vault.id)).rejects.toMatchObject({ status: 404 });
    await expect(f.other.vaults.credentials.retrieve(credential.id, { vault_id: vault.id })).rejects.toMatchObject({ status: 404 });
    await expect(f.vaults.resolve('alice', [vault.id], 'https://mcp.example.com/b')).rejects.toMatchObject({ status: 400 });
    await f.api.vaults.credentials.create(vault.id, { name: 'Two', auth: { type: 'static_bearer', mcp_server_url: 'https://mcp.example.com/a', token: 'token-2' } });
    await expect(f.vaults.resolve('alice', [vault.id], 'https://mcp.example.com/a')).rejects.toMatchObject({ status: 400 });
    expect((await f.vaults.resolve('alice', [vault.id], 'https://mcp.example.com/a', credential.id)).credential.id).toBe(credential.id);
  });

  it('stores confidential template inputs while exposing metadata, preserving omitted fields and clearing nulls', async () => {
    const f = fixture();
    const template = await f.api.environments.templates.create({
      name: 'Worker', env: { PRIVATE_VALUE: 'hidden-value' },
      files: [{ type: 'inline', path: '/workspace/example.txt', data: Buffer.from('private file content').toString('base64') }],
      network: { access: 'restricted', allowed_domains: ['api.example.com', 'files.example.com'] },
      packages: { npm: ['typescript'], python: ['requests'] },
    });
    parseAgentsContract('EnvironmentTemplate', template);
    expect(template.files[0]).toEqual({ type: 'inline', path: '/workspace/example.txt', size_bytes: 20 });
    expect(JSON.stringify(template)).not.toContain('hidden-value');
    const updated = await f.api.environments.templates.update(template.id, { packages: { npm: [] } });
    expect(updated.packages).toEqual({ npm: [], python: [], system: [] });
    expect(updated.network).toEqual(template.network);
    const resolved = await f.templates.resolve('alice', template.id, { network: { access: 'restricted', allowed_domains: ['api.example.com'] } });
    expect(resolved.env).toEqual({ PRIVATE_VALUE: 'hidden-value' });
    await expect(f.templates.resolve('alice', template.id, { network: null })).rejects.toMatchObject({ status: 400 });
    await expect(f.templates.resolve('alice', template.id, { network: { access: 'restricted', allowed_domains: ['example.com.evil.test'] } })).rejects.toMatchObject({ status: 400 });
    await expect(f.other.environments.templates.retrieve(template.id)).rejects.toMatchObject({ status: 404 });
    expect((await f.api.environments.templates.update(template.id, { files: null })).files).toEqual([]);
    await f.api.environments.templates.delete(template.id);
    await expect(f.api.environments.templates.retrieve(template.id)).rejects.toMatchObject({ status: 404 });
  });

  it('rejects traversal and invalid base64 before creating a template', async () => {
    const f = fixture();
    for (const path of ['/workspace/../secret', '/etc/passwd', '/workspace/sub/../../secret']) await expect(f.api.environments.templates.create({ files: [{ type: 'inline', path, data: '' }] })).rejects.toMatchObject({ status: 400 });
    await expect(f.api.environments.templates.create({ files: [{ type: 'inline', path: '/workspace/file', data: 'not base64' }] })).rejects.toMatchObject({ status: 400 });
    expect(f.store.resources.size).toBe(0);
  });
});
