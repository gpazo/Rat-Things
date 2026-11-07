import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { API_SCOPES, iamApiPrincipal, type ApiPrincipal } from '../../src/domain/api-permissions.js';
import type { AgentSession } from '../../src/domain/agents-api.js';
import { publicTemplate } from '../../src/domain/environment-planning.js';
import { SpaceAccessService } from '../../src/identity/space-access.js';
import { GuardedAgentsStore } from '../../src/identity/guarded-agents-store.js';
import { WorkloadAdmissionService, agentConfigurationDigest, type WorkloadAdmission } from '../../src/identity/workload-admission.js';
import { oidcActorId } from '../../src/identity/principal.js';
import { AgentService } from '../../src/core/agent-service.js';
import { SessionService } from '../../src/core/session-service.js';
import { SessionEventStore } from '../../src/core/session-event-store.js';
import { SessionShareService, releaseDigest, shareDigest } from '../../src/core/session-share-service.js';
import { ConfigurationHistory } from '../../src/core/configuration-history.js';
import { sessionAgent } from '../../src/core/session-planning.js';
import type { SessionState } from '../../src/core/session-ports.js';
import type { SessionShareManifest } from '../../src/core/session-share-types.js';
import { routeAgentsRequest } from '../../src/lambdas/agents-router.js';
import { integrationFixture } from './integration-fixtures.js';

const issuer = 'https://id.example.test';
const principal = (subject: string): ApiPrincipal => ({ ownerId: '', authentication: 'oidc', scopes: API_SCOPES,
  actor: { id: oidcActorId(issuer, subject), issuer, subject, kind: 'human' } });
const baseRole = { name: 'Workload', models: ['model'], tools: [], environments: [{ type: 'none' }], vault_ids: [], capability_profile_ids: [], connection_grant_ids: [] };
async function fixture() {
  const f = await integrationFixture();
  const guardedStore = new GuardedAgentsStore(f.store);
  const store = new SessionEventStore(guardedStore);
  const access = new SpaceAccessService(store), admission = new WorkloadAdmissionService(store), agents = new AgentService({ store });
  const sessions = new SessionService({ store, agents, execution: f.execution });
  const space = await access.bootstrap(iamApiPrincipal('operator'), { name: 'Team', manager: { issuer, subject: 'manager' } });
  const manager = await access.authorize(principal('manager'), space.id, ['manage_space']);
  await access.bind(manager, { issuer, subject: 'collaborator', role: 'collaborator' });
  const caller = await access.authorize(principal('collaborator'), space.id, ['share']);
  const services = { agents, sessions, guardedStore, access, admission };
  const post = (path: string, body: unknown = {}) => routeAgentsRequest(new Request(`https://api.test/v1/${path}`, {
    method: 'POST', headers: { 'x-rat-space': space.id }, body: JSON.stringify(body),
  }), principal('collaborator'), services);
  return { ...f, base: f.store, store, access, admission, agents, sessions, manager, caller, post };
}
async function forkFixture() {
  const f = await fixture();
  const configuration = { network: { access: 'disabled' as const } };
  const environment = { ...publicTemplate(configuration, { id: 'env_source', created_at: 1, updated_at: 1 }), type: 'openai_hosted' as const, files: [], skills: [] };
  f.execution.prepare = async (ownerId, sessionId) => {
    await f.store.put({ ownerId, id: environment.id, collection: 'environments', createdAt: 1, revision: 1,
      value: { environment, sessionId, configuration, status: 'ready' } }, 0);
    return environment;
  };
  const role = { ...baseRole, environments: [{ type: 'openai_hosted', ...configuration }] };
  await f.admission.setRole(f.manager, 'default', role);
  const agent = await f.agents.create(f.manager.ownerId, { model: 'model' });
  await f.admission.assign(f.manager, agent.id, { execution_role_id: 'default' });
  const created = await f.post('agents/sessions', { agent_id: agent.id, environment: role.environments[0], input: 'Goal' });
  expect(created.status).toBe(200);
  const source = await created.json() as AgentSession;
  await f.sessions.dispatch(f.manager.ownerId, source.id);
  const observed = [...f.observations.values()][0]!;
  f.observations.set(observed.turn.id, { ...observed, turn: { ...observed.turn, status: 'completed', completed_at: 2 } });
  const prepare = vi.fn(async () => ({ environment: { ...environment, id: 'env_child' }, fork: { sourceSessionId: source.id, sourceEnvironmentId: environment.id,
    checkpoint: { id: 'checkpoint', source: { runId: 'run', generation: 'generation' }, sandboxId: 'sandbox', setupDigest: 'setup', policyDigest: 'policy', rootThreadId: 'root', lastRootTurnId: observed.turn.id, lastNativeTurnId: 'native', reason: 'hibernate' as const, createdAt: 1 },
    lease: { id: 'lease', expiresAt: 9999999999 }, storageKey: 'snapshot' } }));
  f.execution.prepareFork = prepare;
  return { ...f, agent, source, role, prepare };
}
it('rejects a new fork after the current ceiling narrows while preserving parent continuation', async () => {
  const f = await forkFixture();
  await f.admission.setRole(f.manager, 'default', { ...f.role, models: ['other'] });
  expect((await f.post('agents/sessions', { agent_id: f.agent.id, environment: f.role.environments[0], input: 'New' })).status).toBe(403);
  expect((await f.post(`agents/sessions/${f.source.id}/fork`)).status).toBe(403);
  expect(f.prepare).not.toHaveBeenCalled();
  expect((await f.post(`agents/sessions/${f.source.id}/events`, { events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: 'Continue accepted parent' }] }] }] })).status).toBe(204);
});
it.each(['execution_roles', 'agent_workloads', 'agents'])('fences a concurrent %s change before fork effects', async collection => {
  const f = await forkFixture();
  const admit = f.admission.admitFork.bind(f.admission);
  f.admission.admitFork = async (authority, id) => {
    const admission = await admit(authority, id);
    const observed = admission.observations.find(item => item.collection === collection)!;
    const current = (await f.store.get(observed.ownerId, observed.collection, observed.id))!;
    await f.store.put({ ...current, revision: current.revision + 1 }, current.revision);
    return admission;
  };
  expect((await f.post(`agents/sessions/${f.source.id}/fork`)).status).toBe(409);
  expect(f.prepare).not.toHaveBeenCalled();
});
it('records current fork admission for the exact child without replacing the parent admission', async () => {
  const f = await forkFixture();
  const before = (await f.store.get<SessionState>(f.manager.ownerId, 'sessions', f.source.id))!.value.workloadAdmission;
  await f.admission.setRole(f.manager, 'default', { ...f.role, name: 'Current ceiling' });
  const response = await f.post(`agents/sessions/${f.source.id}/fork`);
  expect(response.status).toBe(201);
  const child = await response.json() as AgentSession;
  const saved = (await f.store.get<SessionState>(f.manager.ownerId, 'sessions', child.id))!.value;
  expect(saved.workloadAdmission).toMatchObject({ execution_role_revision: 2, ceiling: { name: 'Current ceiling' }, configuration: { agent: child.agent, vault_ids: child.vault_ids } });
  expect((await f.store.get<SessionState>(f.manager.ownerId, 'sessions', f.source.id))!.value.workloadAdmission).toEqual(before);
  expect(f.prepare).toHaveBeenCalledOnce();
});

it('does not borrow a broader Share ceiling when the continuing Agent has a narrower assignment', async () => {
  const f = await fixture();
  await f.admission.setRole(f.manager, 'narrow', baseRole);
  await f.admission.setRole(f.manager, 'broad', { ...baseRole, tools: [{ type: 'web_search' }] });
  const source = await f.agents.create(f.manager.ownerId, { model: 'model' });
  await f.admission.assign(f.manager, source.id, { execution_role_id: 'narrow' });
  const assignment = await f.admission.assignment(f.manager, source.id);
  const manifest = { source_agent: source, session: { agent: sessionAgent({ tools: [{ type: 'web_search' }] }, source.id, 1, source), vault_ids: [], created_at: 1 }, environment: { type: 'none' as const } };
  await expect(f.admission.admitShare(f.caller, manifest)).rejects.toMatchObject({ status: 403 });
  expect(await f.admission.assignment(f.manager, source.id)).toEqual(assignment);
});

async function sharedFixture() {
  const f = await fixture();
  await f.admission.setRole(f.manager, 'broad', { ...baseRole, tools: [{ type: 'web_search' }] });
  const source = await f.agents.create('local', { model: 'model' });
  const session = await f.sessions.create('local', { agent_id: source.id, environment: { type: 'none' }, input: 'Imported goal' });
  const sourceHistory = await new ConfigurationHistory(f.store).retrieve('local', { kind: 'session', id: session.id }, 1);
  const release = 'fixture-release';
  const manifest: SessionShareManifest = { version: 1, operation_id: randomUUID(), release_hash: releaseDigest(release),
    source_agent: source, session: { ...session, status: 'idle', agent: sessionAgent({ tools: [{ type: 'web_search' }] }, source.id, 1, source) },
    runtime: { kind: 'codex' }, environment: { type: 'none' }, turns: [], subagents: [], imported_history: [], inputs: [], artifacts: [], deleted_artifacts: [],
    admission: { admitted: sourceHistory, current: sourceHistory }, workspace: { sha256: shareDigest('empty'), files: 0, bytes: 0, parts: [] } };
  const shares = new SessionShareService({ store: f.store, sessions: f.sessions, admit: (_owner, value) => f.admission.admitShare(f.caller, value) });
  return { ...f, source, manifest, shares, release };
}
it('binds Share evidence and execution to the effective Session rather than the saved Agent defaults', async () => {
  const f = await sharedFixture();
  const status = await f.shares.stage(f.manager.ownerId, { manifest: f.manifest, digest: shareDigest(f.manifest), workspace_file_ids: [], artifact_file_ids: {} }, f.caller);
  await f.shares.activate(f.manager.ownerId, status.id, { digest: status.digest, release_token: f.release }, f.caller);
  const saved = (await f.store.get<SessionState>(f.manager.ownerId, 'sessions', f.manifest.session.id))!.value;
  const admission = saved.workloadAdmission as WorkloadAdmission['evidence'];
  expect(admission.execution_role_id).toBe('broad');
  expect(admission.configuration.agent).toEqual(saved.session.agent);
  expect(admission.agent_digest).not.toBe(agentConfigurationDigest(f.source));
  expect(admission.source_agent_digest).toBe(agentConfigurationDigest(f.source));
  expect((await f.agents.retrieve(f.manager.ownerId, f.source.id)).tools).toEqual([]);
});
it('fences a narrowed matching Share ceiling even when source and assignment already exist', async () => {
  const f = await sharedFixture();
  await f.admission.admitShare(f.caller, f.manifest);
  const admit = f.admission.admitShare.bind(f.admission);
  f.admission.admitShare = async (authority, manifest) => {
    const admission = await admit(authority, manifest);
    await f.admission.setRole(f.manager, 'broad', baseRole);
    return admission;
  };
  await expect(f.shares.stage(f.manager.ownerId, { manifest: f.manifest, digest: shareDigest(f.manifest), workspace_file_ids: [], artifact_file_ids: {} }, f.caller)).rejects.toMatchObject({ status: 409 });
  expect(await f.store.get(f.manager.ownerId, 'session_shares', f.manifest.operation_id)).toBeUndefined();
  expect(await f.store.get(f.manager.ownerId, 'sessions', f.manifest.session.id)).toBeUndefined();
});
