import { describe, expect, it, vi } from 'vitest';
import routes from '../../spec/agents-api-routes.json' with { type: 'json' };
import { API_SCOPES, SPACE_ROLES, iamApiPrincipal, routeActions, requireSpaceActions, type ApiPrincipal } from '../../src/domain/api-permissions.js';
import { SpaceAccessService, spaceOwner } from '../../src/identity/space-access.js';
import { GuardedAgentsStore } from '../../src/identity/guarded-agents-store.js';
import { WorkloadAdmissionService } from '../../src/identity/workload-admission.js';
import { oidcActorId } from '../../src/identity/principal.js';
import { AgentService } from '../../src/core/agent-service.js';
import { routeAgentsRequest } from '../../src/lambdas/agents-router.js';
import { MemoryAgentsStore } from './fixtures.js';

const issuer = 'https://id.example.test';
function principal(subject: string): ApiPrincipal { return { ownerId: '', authentication: 'oidc', scopes: API_SCOPES, expiresAt: Date.now() + 60_000, actor: { id: oidcActorId(issuer, subject), kind: 'human', issuer, subject } }; }
async function setup() {
  const base = new MemoryAgentsStore(); const guardedStore = new GuardedAgentsStore(base);
  const access = new SpaceAccessService(guardedStore); const manager = principal('alice');
  const space = await access.bootstrap(iamApiPrincipal('operator'), { name: 'Team', manager: { issuer, subject: 'alice' } });
  const authority = await access.authorize(manager, space.id, ['manage_space']);
  const agents = new AgentService({ store: guardedStore }); const admission = new WorkloadAdmissionService(guardedStore);
  return { base, guardedStore, access, manager, space, authority, agents, admission };
}
const role = { name: 'Workload', models: ['model'], tools: [], environments: [{ type: 'none' }], vault_ids: [], capability_profile_ids: [], connection_grant_ids: [] };

describe('team route policy', () => {
  it('classifies every published Agents route and denies unknown actions', () => {
    for (const [method, path] of routes) {
      const actions = routeActions(String(method), String(path).replaceAll(/\{[^}]+\}/g, 'id').split('/').filter(Boolean), { events: [{ type: 'agent.session.input.message' }] });
      expect(actions, `${method} ${path}`).not.toEqual([]);
    }
    expect(routeActions('POST', ['v1', 'agents', 'sessions', 'id', 'future-operation'])).toEqual([]);
    expect(routeActions('POST', ['v1', 'rat', 'spaces', 'id', 'unknown'])).toEqual([]);
  });
  it('checks every event in mixed batches and intersects role with API scopes', () => {
    const parts = ['v1', 'agents', 'sessions', 'id', 'events'];
    const actions = routeActions('POST', parts, { events: [{ type: 'agent.session.input.message' }, { type: 'agent.session.input.cancel' }] });
    expect(actions).toEqual(['contribute', 'cancel']);
    expect(() => requireSpaceActions(principal('alice'), 'collaborator', actions)).toThrow();
    expect(() => requireSpaceActions(principal('alice'), 'controller', actions)).not.toThrow();
    expect(() => requireSpaceActions({ ...principal('alice'), scopes: ['api.agents.write'] }, 'manager', ['contribute'])).toThrow();
    expect(routeActions('POST', parts, { events: [{ type: 'agent.session.input.message' }, { type: 'unknown' }] })).toEqual([]);
    for (const role of SPACE_ROLES) expect(() => requireSpaceActions(principal('alice'), role, [])).toThrow();
  });
});

describe('current space authority', () => {
  it('uses exact identities and server-owned namespaces, never body owners or discovery indexes', async () => {
    const s = await setup();
    await expect(s.access.bootstrap(principal('mallory'), { name: 'Spoof', manager: { issuer, subject: 'mallory' } })).rejects.toThrow();
    await expect(s.access.authorize(principal('mallory'), s.space.id, ['read'])).rejects.toThrow();
    expect(s.authority.ownerId).toBe(spaceOwner(s.space.id));
    expect(s.authority.actor.id).toBe(principal('alice').actor!.id);
    const alice = principal('alice');
    await expect(s.access.authorize({ ...alice, actor: { ...alice.actor!, issuer: 'https://attacker.test' } }, s.space.id, ['read'])).rejects.toThrow();
    await s.access.bind(s.authority, { issuer, subject: 'bob', role: 'viewer' });
    expect((await s.access.list(principal('bob'))).data).toHaveLength(1);
    await s.access.revoke(s.authority, principal('bob').actor!.id);
    expect((await s.access.list(principal('bob'))).data).toHaveLength(0);
    expect((await s.base.list(principal('bob').actor!.id, 'space_discovery', {})).data).toHaveLength(1);
  });
  it('requires explicit workload registration instead of treating a machine as a human', async () => {
    const s = await setup();
    await s.access.bind(s.authority, { issuer, subject: 'machine', role: 'collaborator' });
    const machine = { ...principal('machine'), actor: { ...principal('machine').actor!, kind: 'workload' as const } };
    await expect(s.access.authorize(machine, s.space.id, ['read'])).rejects.toThrow();
    await s.access.bind(s.authority, { issuer, subject: 'machine', role: 'collaborator', kind: 'workload' });
    await expect(s.access.authorize(machine, s.space.id, ['contribute'])).resolves.toMatchObject({ actor: { kind: 'workload' } });
  });
  it('checks revocation atomically with acceptance, including deletes', async () => {
    const s = await setup();
    await s.access.bind(s.authority, { issuer, subject: 'bob', role: 'manager' });
    const bob = await s.access.authorize(principal('bob'), s.space.id, ['configure']);
    const accepted = await s.guardedStore.run(bob, false, () => s.agents.create(bob.ownerId, { model: 'model' }));
    await s.access.revoke(s.authority, bob.actor.id);
    await expect(s.guardedStore.run(bob, false, () => s.agents.create(bob.ownerId, { model: 'model' }))).rejects.toThrow();
    expect(await s.agents.retrieve(bob.ownerId, accepted.id)).toMatchObject({ id: accepted.id });
    // A revocation after the freshness read still loses the revision-guarded delete.
    await s.access.bind(s.authority, { issuer, subject: 'bob', role: 'manager' });
    const fresh = await s.access.authorize(principal('bob'), s.space.id, ['configure']);
    fresh.revalidate = async () => { await new SpaceAccessService(s.base).revoke(s.authority, fresh.actor.id); };
    await expect(s.guardedStore.run(fresh, false, () => s.agents.delete(fresh.ownerId, accepted.id))).rejects.toThrow();
    expect(await s.agents.retrieve(bob.ownerId, accepted.id)).toMatchObject({ id: accepted.id });
  });
  it('rejects expiry at acceptance and forbids writes from read requests', async () => {
    const s = await setup();
    const expired = { ...s.authority, expiresAt: Date.now() - 1, revalidate: async () => {} };
    await expect(s.guardedStore.run(expired, false, () => s.agents.create(expired.ownerId, { model: 'model' }))).rejects.toThrow();
    await expect(s.guardedStore.run(s.authority, true, () => s.agents.create(s.authority.ownerId, { model: 'model' }))).rejects.toThrow();
    expect((await s.agents.list(s.authority.ownerId)).data).toEqual([]);
  });
});

describe('workload admission', () => {
  it('admits saved configuration and rejects inline capability or runtime changes', async () => {
    const s = await setup();
    await s.admission.setRole(s.authority, 'default', role);
    const agent = await s.agents.create(s.authority.ownerId, { model: 'model' });
    await s.admission.assign(s.authority, agent.id, { execution_role_id: 'default' });
    const input = { agent_id: agent.id, environment: { type: 'none' }, input: 'hello' };
    const admission = await s.admission.admit(s.authority, input);
    expect(admission.observations.map(o => o.collection).sort()).toEqual(['agent_workloads', 'agents', 'execution_roles']);
    for (const override of [{ agent: { tools: [] } }, { vault_ids: ['secret'] }, { environment: { type: 'self_hosted' } }, { metadata: { rat_things_runtime: 'pi' } }]) await expect(s.admission.admit(s.authority, { ...input, ...override })).rejects.toThrow();
    await s.agents.update(s.authority.ownerId, agent.id, { instructions: 'changed' });
    await expect(s.admission.admit(s.authority, input)).rejects.toThrow();
    const accepted = { ownerId: s.authority.ownerId, collection: 'session_preparations', id: 's', createdAt: 1, revision: 1, value: input };
    await expect(s.base.commit([{ resource: accepted, expectedRevision: 0 }], admission.observations)).rejects.toThrow();
  });
  it('keeps the admitted Session model fixed even when the space ceiling lists another model', async () => {
    const s = await setup();
    const agent = await s.agents.create(s.authority.ownerId, { model: 'model' });
    await s.base.put({ ownerId: s.authority.ownerId, id: 'session', collection: 'sessions', createdAt: 1, revision: 1,
      value: { session: { agent }, workloadAdmission: { ceiling: { ...role, models: ['model', 'broader'] } } } }, 0);
    await expect(s.admission.validateSessionUpdate(s.authority, 'session', { agent: { model: 'broader' } })).rejects.toMatchObject({ status: 403 });
    await expect(s.admission.validateSessionUpdate(s.authority, 'session', { agent: { model: 'model' } })).resolves.toBeUndefined();
    await expect(s.admission.setRole(s.authority, 'unused', { ...role, capability_profile_ids: ['microvm-full'] })).rejects.toThrow();
    await expect(s.admission.setRole(s.authority, 'template', { ...role, environments: [{ type: 'openai_hosted', environment_template_id: 'mutable' }] })).rejects.toThrow();
  });
  it('admits a continuing Agent during Share under a matching ceiling without target Agent selection', async () => {
    const s = await setup();
    await s.admission.setRole(s.authority, 'default', role);
    const source = await s.agents.create('local', { model: 'model', instructions: 'Continue the same goal' });
    await s.access.bind(s.authority, { issuer, subject: 'bob', role: 'collaborator' });
    const bob = await s.access.authorize(principal('bob'), s.space.id, ['share']);
    const manifest = { source_agent: source, session: { agent: { ...source, tools: [] }, vault_ids: [], created_at: source.created_at }, environment: { type: 'none' as const } };
    const first = await s.admission.admitShare(bob, manifest);
    const second = await s.admission.admitShare(bob, manifest);
    expect(first.evidence).toEqual(second.evidence);
    expect(await s.agents.retrieve(bob.ownerId, source.id)).toEqual(source);
    await expect(s.admission.admitShare(bob, { ...manifest, source_agent: { ...source, instructions: 'unrelated collision' } })).rejects.toThrow();
  });
});

describe('team router', () => {
  it('accepts generic effects before revocation and rejects a revocation that wins the intent transaction', async () => {
    const s = await setup();
    await s.access.bind(s.authority, { issuer, subject: 'bob', role: 'manager' });
    const bob = principal('bob');
    const effects: string[] = [];
    const createFile = async () => {
      await s.access.revoke(s.authority, bob.actor!.id);
      effects.push('write'); return {};
    };
    const services = { ...s, environments: { createFile } as never };
    const request = () => new Request('https://api.test/v1/agents/environments/env/files', { method: 'POST', headers: { 'x-rat-space': s.space.id }, body: '{}' });
    await routeAgentsRequest(request(), bob, services);
    expect(effects).toEqual(['write']);
    expect((await s.base.list(s.authority.ownerId, 'request_acceptances', {})).data).toHaveLength(1);
    await s.access.bind(s.authority, { issuer, subject: 'bob', role: 'manager' });
    const commit = s.base.commit.bind(s.base);
    s.base.commit = async (writes, observations) => {
      if (writes.some(w => w.resource.collection === 'request_acceptances')) await new SpaceAccessService(s.base).revoke(s.authority, bob.actor!.id);
      return commit(writes, observations);
    };
    expect((await routeAgentsRequest(request(), bob, services)).status).toBe(409);
    expect(effects).toEqual(['write']);
  });
  it('emits role downgrades while idle and closes visibility after revocation', async () => {
    const s = await setup();
    await s.access.bind(s.authority, { issuer, subject: 'bob', role: 'collaborator' });
    const abort = new AbortController();
    const services = { ...s, activity: {
      snapshot: async () => ({ cursor: 's:1', inputs: [] }),
      follow: async function* (_owner: string, _id: string, signal: AbortSignal) {
        yield { type: 'rat.session.activity', event_id: 's:1', activity: { cursor: 's:1', inputs: [] } };
        while (!signal.aborted) await new Promise(resolve => setTimeout(resolve, 10));
      },
    } };
    const response = await routeAgentsRequest(new Request('https://api.test/v1/rat/sessions/s/activity/events', { headers: { 'x-rat-space': s.space.id }, signal: abort.signal }), principal('bob'), services);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    try {
      expect(decoder.decode((await reader.read()).value)).toContain('"role":"collaborator"');
      await s.access.bind(s.authority, { issuer, subject: 'bob', role: 'viewer' });
      let permission = '';
      for (let attempt = 0; attempt < 4 && !permission.includes('"role":"viewer"'); attempt++) permission = decoder.decode((await reader.read()).value);
      expect(permission).toContain('rat.space.permissions');
      expect(permission).toContain('"role":"viewer"');
      await s.access.revoke(s.authority, principal('bob').actor!.id);
      await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
    } finally { abort.abort(); await reader.cancel().catch(() => {}); }
  });
  it('rejects viewers and missing selectors before invoking effects and preserves IAM bootstrap', async () => {
    const s = await setup();
    await s.access.bind(s.authority, { issuer, subject: 'bob', role: 'viewer' });
    const events = vi.fn();
    const services = { ...s, sessions: { events } as never };
    const request = (path: string, body?: unknown, selector = s.space.id) => new Request(`https://api.test${path}`, { method: body ? 'POST' : 'GET', headers: { 'x-rat-space': selector }, ...(body ? { body: JSON.stringify(body) } : {}) });
    expect((await routeAgentsRequest(request('/v1/agents/sessions/s/events', { events: [{ type: 'agent.session.input.message', input: [] }] }), principal('bob'), services)).status).toBe(403);
    expect(events).not.toHaveBeenCalled();
    expect((await routeAgentsRequest(request('/v1/agents', undefined, ''), principal('bob'), services)).status).toBe(403);
    expect((await routeAgentsRequest(request('/v1/agents'), principal('bob'), services)).status).toBe(200);
    const list = await routeAgentsRequest(request('/v1/rat/spaces'), principal('bob'), services);
    expect(await list.json()).toMatchObject({ data: [{ id: s.space.id, role: 'viewer' }] });
    const spoof = await routeAgentsRequest(request('/v1/rat/spaces', { name: 'Fake', manager: { issuer, subject: 'bob' } }), principal('bob'), services);
    expect(spoof.status).toBe(403);
  });
});

describe('multiplayer messages and typing', () => {
  it('enforces roles and owner scope through real collaboration services, including replies', async () => {
    const { SessionEventStore } = await import('../../src/core/session-event-store.js');
    const { SessionService } = await import('../../src/core/session-service.js');
    const { integrationFixture } = await import('./integration-fixtures.js');
    const s = await setup();
    const fixture = await integrationFixture();
    const store = new SessionEventStore(s.guardedStore);
    const sessions = new SessionService({ store, agents: s.agents, execution: fixture.execution, streamIntervalMs: 5 });
    const session = await sessions.create(s.authority.ownerId, { agent: { model: 'test' }, environment: { type: 'none' }, input: 'Product direction' }, undefined, undefined, undefined, s.authority);
    await s.access.bind(s.authority, { issuer, subject: 'bob', role: 'collaborator', label: 'Engineer' });
    await s.access.bind(s.authority, { issuer, subject: 'viewer', role: 'viewer' });
    const services = { ...s, sessions, activity: { snapshot: sessions.activity.bind(sessions), follow: sessions.activityEvents.bind(sessions) } };
    const post = (endpoint: string, body: unknown, subject = 'bob') => routeAgentsRequest(new Request(`https://api.test/v1/rat/sessions/${session.id}/${endpoint}`, {
      method: 'POST', headers: { 'x-rat-space': s.space.id, 'idempotency-key': `${endpoint}-${subject}` }, body: JSON.stringify(body),
    }), principal(subject), services);
    const typing = { client_id: 'window', sequence: 1, typing: true };
    expect((await post('typing', typing)).status).toBe(204);
    expect((await post('typing', typing, 'viewer')).status).toBe(403);
    for (const endpoint of ['workspace/feedback', 'workspace/browser', 'workspace/browser/capture']) expect((await post(endpoint, {}, 'viewer')).status).toBe(403);
    expect((await post('workspace/feedback', { text: 'forged', target: { kind: 'artifact', id: 'outside', anchor: { type: 'item' } } })).status).toBe(404);
    expect((await post('messages', { text: 'No', reply_to: 'outside' })).status).toBe(400);
    const snapshot = await sessions.activity(s.authority.ownerId, session.id);
    const target = snapshot.inputs[0]!.message_ids[0]!;
    expect((await post('messages', { text: 'Engineering feedback', reply_to: target })).status).toBe(204);
    expect((await post('messages', { text: 'Engineering feedback', reply_to: target })).status).toBe(204);
    expect((await post('messages', { text: 'Not allowed' }, 'viewer')).status).toBe(403);
    const activity = await sessions.activity(s.authority.ownerId, session.id);
    expect(activity.inputs).toHaveLength(2);
    expect(activity.inputs[1]).toMatchObject({ actor: { label: 'Engineer' }, reply: { text: 'Product direction' } });
    await s.access.revoke(s.authority, principal('bob').actor!.id);
    expect((await post('typing', { ...typing, sequence: 2 })).status).toBe(403);
    expect((await post('messages', { text: 'Revoked' })).status).toBe(403);
    expect(fixture.execution.start).not.toHaveBeenCalled();
  });
});
