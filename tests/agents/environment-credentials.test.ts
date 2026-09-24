import { describe, expect, it, vi } from 'vitest';
import type { CredentialAuthCreateParam } from 'openai/resources/beta/agents/vaults/credentials';
import { VaultService } from '../../src/core/vault-service.js';
import { SessionToolService } from '../../src/core/session-tool-service.js';
import { sessionAgent } from '../../src/core/session-planning.js';
import type { SessionToolAttempt } from '../../src/core/session-tool-planning.js';
import { parseSessionEnvironmentSecret, type SessionCredentialSecret, type SessionCredentialIdentity } from '../../src/credentials/session-tools.js';
import type { SessionEnvironmentCredentialBinding } from '../../src/domain/session-execution.js';
import { substituteEnvironmentHeaders, type HostedCredentialPolicy } from '../../src/domain/environment-credential-planning.js';
import { MemoryAgentsStore } from './fixtures.js';

async function fixture() {
  const store = new MemoryAgentsStore();
  const vaultValues = new Map<string, CredentialAuthCreateParam>();
  const sessionValues = new Map<string, SessionCredentialSecret>();
  let version = 0;
  const read = vi.fn(async (reference: string) => structuredClone(vaultValues.get(reference)!));
  const vaults = new VaultService({ store, secrets: {
    create: async (_owner, id, value) => { const reference = `${id}/${++version}`; vaultValues.set(reference, structuredClone(value)); return reference; },
    read, revoke: async reference => { vaultValues.delete(reference); },
  } });
  const retired = new Set<string>();
  const secrets = {
    reference: (identity: SessionCredentialIdentity, attempt: string) => `${attempt}/${'environmentId' in identity ? identity.environmentId : identity.serverLabel}`,
    create: vi.fn(async (value: SessionCredentialSecret, reference: string) => {
      if (retired.has(reference)) throw new Error('Retired reservation');
      sessionValues.set(reference, structuredClone(value));
    }),
    revoke: vi.fn(async (reference: string) => { retired.add(reference); sessionValues.delete(reference); }),
  };
  const clock = { now: vi.fn(() => 100) };
  const tools = new SessionToolService({ store, vaults, secrets, clock });
  const vault = await vaults.create('alice');
  const credential = await vaults.createCredential('alice', vault.id, { name: 'Hosted API', auth: {
    type: 'environment_variable', secret_name: 'SERVICE_KEY', secret_value: 'original-private-value', networking: { type: 'limited', allowed_hosts: ['api.example.com'] },
  } });
  const policy: HostedCredentialPolicy = { environmentId: 'env_test', network: { access: 'restricted', allowed_domains: ['api.example.com'] }, env: {} };
  const prepare = (override = policy, owner = 'alice') => tools.prepare(owner, 'sess_test', sessionAgent({ model: 'test' }, 'agent', 100), [], [vault.id], false, override);
  const binding = async () => (await store.get<SessionEnvironmentCredentialBinding>('alice', 'session_environment_credentials', 'sess_test'))!.value;
  const attempts = async () => (await store.list<SessionToolAttempt>('alice', 'session_tool_attempts', {})).data;
  return { store, vaults, vault, credential, tools, secrets, read, sessionValues, clock, policy, prepare, binding, attempts };
}

describe('hosted environment credential snapshots', () => {
  it('keeps Session credentials stable across Vault rotation and revokes snapshots when the Session closes', async () => {
    const f = await fixture(); await f.prepare();
    const saved = await f.binding();
    const original = JSON.stringify(f.sessionValues.get(saved.references[0]!));
    const identity = { ownerId: 'alice', sessionId: 'sess_test', environmentId: 'env_test' };
    expect(parseSessionEnvironmentSecret(original, identity).credentials[0]?.secret_value).toBe('original-private-value');
    expect(JSON.stringify([...f.store.resources.values()])).not.toContain('original-private-value');
    await f.vaults.updateCredential('alice', f.vault.id, f.credential.id, { auth: { type: 'environment_variable', secret_value: 'rotated-private-value' } });
    expect(JSON.stringify(f.sessionValues.get(saved.references[0]!))).toBe(original);
    await expect(f.prepare(f.policy, 'bob')).rejects.toMatchObject({ status: 404 });
    expect(() => parseSessionEnvironmentSecret(original, { ...identity, environmentId: 'another' })).toThrow('identity');
    expect(() => parseSessionEnvironmentSecret(original, { ...identity, ownerId: 'bob' })).toThrow('identity');
    await f.tools.close('alice', 'sess_test');
    expect(f.sessionValues.size).toBe(0);
    expect(await f.store.get('alice', 'session_environment_credentials', 'sess_test')).toBeUndefined();
    expect(await f.vaults.credential('alice', f.vault.id, f.credential.id)).toBeDefined();
  });

  it.each(['disabled', 'host', 'collision', 'duplicate', 'unrestricted'] as const)('rejects %s policy conflicts before reading credential values', async conflict => {
    const f = await fixture();
    let policy = f.policy;
    if (conflict === 'disabled') policy = { ...policy, network: { access: 'disabled', allowed_domains: [] } };
    if (conflict === 'host') policy = { ...policy, network: { access: 'restricted', allowed_domains: ['other.example.com'] } };
    if (conflict === 'collision') policy = { ...policy, env: { SERVICE_KEY: 'configured' } };
    if (conflict === 'duplicate' || conflict === 'unrestricted') await f.vaults.createCredential('alice', f.vault.id, { name: 'Conflict', auth: {
      type: 'environment_variable', secret_name: conflict === 'duplicate' ? 'SERVICE_KEY' : 'OTHER_KEY', secret_value: 'other-private-value', networking: { type: 'unrestricted' },
    } });
    if (conflict === 'unrestricted') policy = { ...policy, network: { access: 'enabled', allowed_domains: [] } };
    await expect(f.prepare(policy)).rejects.toMatchObject({ status: 400 });
    expect(f.read).not.toHaveBeenCalled();
    expect(f.secrets.create).not.toHaveBeenCalled();
  });

  it('recovers uncertain creation and a failed immediate cleanup through the existing durable outbox', async () => {
    const f = await fixture();
    const create = f.secrets.create.getMockImplementation()!;
    f.secrets.create.mockImplementationOnce(async (...args) => { await create(...args); throw new Error('Lost creation acknowledgement'); });
    f.secrets.revoke.mockRejectedValueOnce(new Error('Cleanup unavailable'));
    await expect(f.prepare()).rejects.toThrow('Lost creation acknowledgement');
    const [attempt] = await f.attempts();
    expect(attempt?.value.status).toBe('cleanup');
    expect(f.sessionValues.size).toBe(1);
    expect(JSON.stringify(attempt)).not.toContain('original-private-value');
    await f.tools.reconcile('alice', attempt!.id);
    expect(f.sessionValues.size).toBe(0);
    expect(await f.attempts()).toEqual([]);
  });

  it('retains adopted snapshots after a lost transaction acknowledgement', async () => {
    const f = await fixture();
    const commit = f.store.commit.bind(f.store);
    let loseAcknowledgement = true;
    vi.spyOn(f.store, 'commit').mockImplementation(async writes => {
      await commit(writes);
      if (loseAcknowledgement && writes.some(write => write.resource.collection === 'session_tools')) {
        loseAcknowledgement = false;
        throw new Error('Lost adoption acknowledgement');
      }
    });
    await expect(f.prepare()).resolves.toBeUndefined();
    expect((await f.binding()).references).toHaveLength(1);
    expect(f.sessionValues.size).toBe(1);
    expect(f.secrets.revoke).not.toHaveBeenCalled();
  });
});

describe('credential header substitution', () => {
  const credentials = [{ placeholder: 'placeholder-A', secret: 'token-$&-placeholder-B', allowedHosts: ['api.example.com'] },
    { placeholder: 'placeholder-B', secret: 'other-token', allowedHosts: ['api.example.com'] }];
  it.each(['https://api.example.com/path', 'https://api.example.com:8443/path'])('substitutes literal values once for %s without changing the input', destination => {
    const headers = { authorization: 'Bearer placeholder-A', 'x-values': ['placeholder-B', 'unchanged'] };
    expect(substituteEnvironmentHeaders(headers, new URL(destination), credentials)).toEqual({ authorization: 'Bearer token-$&-placeholder-B', 'x-values': ['other-token', 'unchanged'] });
    expect(headers.authorization).toBe('Bearer placeholder-A');
  });
  it.each(['http://api.example.com', 'https://api.example.com:444', 'https://api.example.com.evil.test', 'https://user@api.example.com', 'https://other.example.com'])('never substitutes for %s', destination => {
    const headers = { authorization: 'Bearer placeholder-A' };
    expect(substituteEnvironmentHeaders(headers, new URL(destination), credentials)).toEqual(headers);
  });
});
