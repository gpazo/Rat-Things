import { describe, expect, it, vi } from 'vitest';
import type { CredentialAuthCreateParam } from 'openai/resources/beta/agents/vaults/credentials';
import { AgentService } from '../../src/core/agent-service.js';
import { VaultService } from '../../src/core/vault-service.js';
import { ConfigurationHistory, changedPaths, configurationCollection } from '../../src/core/configuration-history.js';
import { resolveAgentConfiguration } from '../../src/domain/agent-configuration.js';
import { AgentsResourceConflictError } from '../../src/domain/agents-api-validation.js';
import type { ConfigurationRevision } from '../../src/domain/configuration-history.js';
import type { SessionState } from '../../src/core/session-ports.js';
import { MemoryAgentsStore } from './fixtures.js';
import { integrationFixture } from './integration-fixtures.js';

const owner = 'operator';
const url = 'https://mcp.example.com/tool?tenant=private';
function vaultFixture(refresh?: () => Promise<unknown>) {
  const store = new MemoryAgentsStore();
  const values = new Map<string, CredentialAuthCreateParam>();
  let next = 0;
  const secrets = {
    create: vi.fn(async (_owner: string, _id: string, value: CredentialAuthCreateParam) => {
      const reference = `secret/private-${++next}`; values.set(reference, structuredClone(value)); return reference;
    }),
    read: vi.fn(async (reference: string) => {
      const value = values.get(reference); if (!value) throw new Error('Secret missing'); return structuredClone(value);
    }),
    revoke: vi.fn(async (reference: string) => { values.delete(reference); }),
  };
  const service = new VaultService({ store, secrets, ...(refresh ? { oauth: { refresh } } : {}), clock: { now: () => 100 } });
  return { store, values, secrets, service, history: new ConfigurationHistory(store) };
}

function histories(store: MemoryAgentsStore): ConfigurationRevision[] {
  return [...store.resources.values()].filter(resource => resource.collection.startsWith('configuration_revisions/')).map(resource => resource.value as ConfigurationRevision);
}

describe('immutable configuration history', () => {
  it('retains atomic Agent revisions and tombstones, ordered by revision under clock skew and scoped after deletion', async () => {
    const store = new MemoryAgentsStore(); let now = 100;
    const agents = new AgentService({ store, clock: { now: () => now } });
    const history = new ConfigurationHistory(store);
    const agent = await agents.create(owner, { model: 'test', instructions: 'original' });
    const subject = { kind: 'agent' as const, id: agent.id };
    now = 50;
    await agents.update(owner, agent.id, { instructions: 'second' }, { actor: { kind: 'system' }, requestId: 'req-update' });
    await agents.delete(owner, agent.id);
    await expect(agents.retrieve(owner, agent.id)).rejects.toMatchObject({ status: 404 });
    const first = await history.list(owner, subject, { order: 'asc', limit: 2 });
    expect(first.data.map(row => row.ref.revision)).toEqual([1, 2]);
    expect(first.has_more).toBe(true);
    expect(first.data[1]).toMatchObject({ recordedAt: 50, actor: { kind: 'system' }, requestId: 'req-update', changedPaths: ['/agent/instructions', '/agent/updated_at'] });
    const last = await history.list(owner, subject, { order: 'asc', after: first.last_id!, limit: 2 });
    expect(last.data).toMatchObject([{ ref: { revision: 3 }, change: 'deleted', snapshot: null }]);
    expect(last.has_more).toBe(false);
    expect((await history.retrieve(owner, subject, '0000000000000001')).snapshot).toEqual({ kind: 'agent', agent });
    await expect(history.retrieve('other-owner', subject, 1)).rejects.toMatchObject({ status: 404 });
    expect((await history.list('other-owner', subject)).data).toEqual([]);
    expect(histories(store).every(row => row.object === 'rat_things.configuration_revision')).toBe(true);
    expect([...store.resources.values()].filter(row => row.collection.startsWith('configuration_revisions/')).every(row => row.expiresAt === undefined)).toBe(true);
  });

  it('retains an honest legacy baseline before referencing and changing a saved Agent', async () => {
    const store = new MemoryAgentsStore();
    const agent = resolveAgentConfiguration({ model: 'test', instructions: 'legacy' }, { id: 'agent_legacy', created_at: 1, updated_at: 2 });
    await store.commit([{ resource: { ownerId: owner, collection: 'agents', id: agent.id, revision: 7, createdAt: 1, value: agent }, expectedRevision: 0 }]);
    const agents = new AgentService({ store, clock: { now: () => 10 } });
    const observed = await agents.configuration(owner, agent.id);
    expect(observed).toEqual({ agent, revision: { subject: { kind: 'agent', id: agent.id }, revision: 7 } });
    const history = new ConfigurationHistory(store);
    expect(await history.retrieve(owner, observed.revision.subject, 7)).toMatchObject({ change: 'legacy_observed', actor: { kind: 'unknown' } });
    await agents.update(owner, agent.id, { instructions: 'current' });
    expect((await history.list(owner, observed.revision.subject, { order: 'asc' })).data.map(row => row.ref.revision)).toEqual([7, 8]);
    await expect(history.retrieve(owner, observed.revision.subject, 6)).rejects.toMatchObject({ status: 404 });
  });

  it('replans rejected Agent CAS writes and recovers lost create, update and delete acknowledgements', async () => {
    const store = new MemoryAgentsStore(); const agents = new AgentService({ store, clock: { now: () => 100 } });
    const commit = store.commit.bind(store); let fail = false;
    vi.spyOn(store, 'commit').mockImplementation(async (writes, observations) => { await commit(writes, observations); if (fail) { fail = false; throw new Error('Lost acknowledgement'); } });
    fail = true; const agent = await agents.create(owner, { model: 'test' });
    await Promise.all([agents.update(owner, agent.id, { name: 'named' }), agents.update(owner, agent.id, { instructions: 'instructed' })]);
    expect(await agents.retrieve(owner, agent.id)).toMatchObject({ name: 'named', instructions: 'instructed' });
    fail = true; await agents.update(owner, agent.id, { name: 'final' });
    const remove = store.delete.bind(store);
    vi.spyOn(store, 'delete').mockImplementation(async (resource, writes) => { await remove(resource, writes); throw new Error('Lost deletion acknowledgement'); });
    await agents.delete(owner, agent.id);
    const page = await new ConfigurationHistory(store).list(owner, { kind: 'agent', id: agent.id }, { order: 'asc' });
    expect(page.data.map(row => row.ref.revision)).toEqual([1, 2, 3, 4, 5]);
  });

  it('never commits a head without its immutable row when persistence fails', async () => {
    const store = new MemoryAgentsStore(); const agents = new AgentService({ store });
    const agent = await agents.create(owner, { model: 'test' });
    const before = await agents.configuration(owner, agent.id);
    vi.spyOn(store, 'commit').mockRejectedValue(new Error('Store unavailable'));
    await expect(agents.update(owner, agent.id, { instructions: 'uncommitted' })).rejects.toThrow('Store unavailable');
    expect(await agents.retrieve(owner, agent.id)).toEqual(before.agent);
    expect(histories(store)).toHaveLength(1);
  });

  it('keeps null, false, missing keys, array changes and JSON Pointer escaping distinct in pure diffs', () => {
    const before = { nullable: null, falsey: false, 'slash/~': { list: [1] } };
    const copy = structuredClone(before);
    expect(changedPaths(before, { falsey: true, 'slash/~': { list: [2] } })).toEqual(['/falsey', '/nullable', '/slash~1~0/list']);
    expect(before).toEqual(copy);
    expect(changedPaths({ a: false }, { a: false })).toEqual([]);
    for (const value of [null, false, 0]) {
      expect(changedPaths({}, { added: value })).toEqual(['/added']);
      expect(changedPaths({ removed: value }, {})).toEqual(['/removed']);
    }
  });
});

describe('Session configuration admission', () => {
  it('pins the saved Agent in interrupted preparation and preserves admitted versus current Turn settings', async () => {
    const f = await integrationFixture();
    const agents = new AgentService({ store: f.store });
    const original = await agents.configuration(owner, f.agent.id);
    const prepare = f.execution.prepare; let interrupted = true;
    f.execution.prepare = async (...args) => { if (interrupted) { interrupted = false; throw new Error('Interrupted'); } return prepare(...args); };
    const input = { agent_id: f.agent.id, environment: { type: 'none' }, input: 'start' };
    await expect(f.sessions.create(owner, input, 'sess_pinned')).rejects.toThrow('Interrupted');
    await agents.update(owner, f.agent.id, { instructions: 'later authority' });
    await agents.delete(owner, f.agent.id);
    const session = await f.sessions.create(owner, input, 'sess_pinned');
    const history = new ConfigurationHistory(f.store);
    const admission = await history.retrieve(owner, { kind: 'session', id: session.id }, 1);
    expect(admission.snapshot).toMatchObject({ kind: 'session', configuration: { sourceAgent: original.revision, agent: { instructions: null } } });
    const first = (await f.store.get<SessionState>(owner, 'sessions', session.id))!.value;
    await f.sessions.update(owner, session.id, { agent: { model: 'gpt-6-sol', reasoning: { effort: 'high' } } });
    const updated = (await f.store.get<SessionState>(owner, 'sessions', session.id))!;
    expect(updated.value.configuration!.admitted).toEqual(first.configuration!.admitted);
    expect(updated.value.configuration!.current).not.toEqual(first.configuration!.current);
    expect(updated.value.turns[0]!.configuration).toEqual(first.configuration!.current);
    const next = { ...updated.value, turns: updated.value.turns.map(binding => ({ ...binding, turn: { ...binding.turn, status: 'completed' as const, completed_at: 120 } })) };
    await f.store.put({ ...updated, revision: updated.revision + 1, value: next }, updated.revision);
    await f.sessions.events(owner, session.id, { events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: 'new' }] }] }] });
    const current = (await f.store.get<SessionState>(owner, 'sessions', session.id))!.value;
    expect(current.turns.at(-1)!.configuration).toEqual(updated.value.configuration!.current);
    expect(current.turns.at(-1)!.modelSettings).toMatchObject({ model: 'gpt-6-sol', reasoning: { effort: 'high' } });
  });

  it('observes legacy Session settings without attributing today\'s Agent or rewriting historical Turns', async () => {
    const f = await integrationFixture(); const session = await f.sessions.create(owner, { agent_id: f.agent.id, environment: { type: 'none' }, input: 'legacy' });
    const current = (await f.store.get<SessionState>(owner, 'sessions', session.id))!;
    const { configuration: _configuration, ...legacy } = current.value;
    legacy.turns = legacy.turns.map(({ configuration: _ref, ...binding }) => binding);
    for (const [key, resource] of f.store.resources) if (resource.collection === configurationCollection({ kind: 'session', id: session.id })) f.store.resources.delete(key);
    await f.store.put({ ...current, revision: current.revision + 1, value: legacy }, current.revision);
    await new AgentService({ store: f.store }).update(owner, f.agent.id, { instructions: 'today' });
    await f.sessions.retrieve(owner, session.id);
    const baseline = (await new ConfigurationHistory(f.store).list(owner, { kind: 'session', id: session.id })).data[0]!;
    expect(baseline.change).toBe('legacy_observed');
    expect(baseline.snapshot).toMatchObject({ kind: 'session', configuration: { agent: { instructions: null } } });
    expect(JSON.stringify(baseline)).not.toContain('sourceAgent');
    expect((await f.store.get<SessionState>(owner, 'sessions', session.id))!.value.turns[0]!.configuration).toBeUndefined();
  });
});

describe('safe live Vault evidence', () => {
  it('uses the rotated token and its exact retained revision when rotation races a secret read', async () => {
    const f = vaultFixture(); const vault = await f.service.create(owner);
    const credential = await f.service.createCredential(owner, vault.id, { name: 'MCP', auth: { type: 'static_bearer', mcp_server_url: url, token: 'old-private-token' } });
    const read = f.secrets.read.getMockImplementation()!; let rotate = true;
    f.secrets.read.mockImplementation(async reference => {
      const auth = await read(reference);
      if (rotate) { rotate = false; await f.service.updateCredential(owner, vault.id, credential.id, { auth: { type: 'static_bearer', token: 'rotated-private-token' } }); }
      return auth;
    });
    const result = await f.service.authorizeMcp(owner, vault.id, credential.id, url);
    expect(result.authorization).toBe('Bearer rotated-private-token');
    expect(result.evidence).toMatchObject({ kind: 'vault', vault: { revision: 3 }, credential: { revision: 2 } });
    if (result.evidence.kind !== 'vault') throw new Error('Expected Vault evidence');
    expect(await f.history.retrieve(owner, result.evidence.credential.subject, result.evidence.credential.revision)).toMatchObject({ snapshot: { kind: 'credential', status: 'active' } });
    await f.service.delete(owner, vault.id);
    await expect(f.service.authorizeMcp(owner, vault.id, credential.id, url)).rejects.toMatchObject({ status: 404 });
    expect((await f.history.list(owner, { kind: 'credential', vaultId: vault.id, id: credential.id })).data[0]).toMatchObject({ change: 'deleted', snapshot: { status: 'archived' } });
    const retained = JSON.stringify(histories(f.store));
    for (const forbidden of ['old-private-token', 'rotated-private-token', 'secret/private-', 'pendingRefresh', 'refreshLease']) expect(retained).not.toContain(forbidden);
  });

  it('fails closed when a credential is archived during its secret read', async () => {
    const f = vaultFixture(); const vault = await f.service.create(owner);
    const credential = await f.service.createCredential(owner, vault.id, { name: 'MCP', auth: { type: 'static_bearer', mcp_server_url: url, token: 'private-token' } });
    const read = f.secrets.read.getMockImplementation()!;
    f.secrets.read.mockImplementation(async reference => { const auth = await read(reference); await f.service.deleteCredential(owner, vault.id, credential.id); return auth; });
    await expect(f.service.authorizeMcp(owner, vault.id, credential.id, url)).rejects.toMatchObject({ status: 404 });
  });

  it('retains refresh coordination revisions safely and returns the final committed policy', async () => {
    const refresh = vi.fn(async () => ({ access_token: 'refreshed-private', refresh_token: 'rotated-refresh', token_type: 'bearer', expires_in: 3600 }));
    const f = vaultFixture(refresh); const vault = await f.service.create(owner);
    const credential = await f.service.createCredential(owner, vault.id, { name: 'MCP', auth: { type: 'mcp_oauth', mcp_server_url: url, access_token: 'expired-private', expires_at: '1970-01-01T00:00:00Z', refresh: { client_id: 'client', refresh_token: 'initial-refresh', token_endpoint: 'https://auth.example/token', token_endpoint_auth: { type: 'none' } } } });
    const authorization = await f.service.authorizeMcp(owner, vault.id, credential.id, url);
    expect(authorization).toMatchObject({ authorization: 'Bearer refreshed-private', evidence: { kind: 'vault', credential: { revision: 4 } } });
    const rows = (await f.history.list(owner, { kind: 'credential', vaultId: vault.id, id: credential.id }, { order: 'asc' })).data;
    expect(rows.map(row => row.ref.revision)).toEqual([1, 2, 3, 4]);
    expect(rows.slice(1).every(row => row.actor.kind === 'system')).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
    const retained = JSON.stringify(histories(f.store));
    for (const forbidden of ['refreshed-private', 'expired-private', 'initial-refresh', 'rotated-refresh', 'secret/private-', 'pendingRefresh', 'refreshLease']) expect(retained).not.toContain(forbidden);
  });

  it('does not mistake equal safe histories for an acknowledged competing token rotation', async () => {
    const f = vaultFixture(); const vault = await f.service.create(owner);
    const credential = await f.service.createCredential(owner, vault.id, { name: 'MCP', auth: { type: 'static_bearer', mcp_server_url: url, token: 'initial-private' } });
    const commit = f.store.commit.bind(f.store); let intercept = true;
    vi.spyOn(f.store, 'commit').mockImplementation(async (writes, observations) => {
      if (intercept && writes.some(write => write.resource.collection.endsWith('/credentials'))) {
        intercept = false;
        await f.service.updateCredential(owner, vault.id, credential.id, { auth: { type: 'static_bearer', token: 'winning-private' } });
        throw new AgentsResourceConflictError();
      }
      await commit(writes, observations);
    });
    await expect(f.service.updateCredential(owner, vault.id, credential.id, { auth: { type: 'static_bearer', token: 'losing-private' } })).rejects.toMatchObject({ status: 409 });
    expect((await f.service.authorizeMcp(owner, vault.id, credential.id, url)).authorization).toBe('Bearer winning-private');
    expect([...f.values.values()]).toEqual([{ type: 'static_bearer', mcp_server_url: url, token: 'winning-private' }]);
  });
});
