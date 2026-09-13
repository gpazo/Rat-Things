import { createHmac, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createAwsClients, CachedSecretReader, S3ArtifactStore } from '../../src/adapters/aws-runtime.js';
import { DynamoAgentsStore } from '../../src/adapters/dynamo-agents-store.js';
import { DynamoIntegrationStore } from '../../src/adapters/dynamo-integration-store.js';
import { AgentService } from '../../src/core/agent-service.js';
import { SessionService } from '../../src/core/session-service.js';
import { SessionIntegrationService } from '../../src/core/session-integration-service.js';
import { ScheduleService } from '../../src/core/schedule-service.js';
import type { SessionExecution, SessionTurnObservation } from '../../src/core/session-ports.js';
import type { SessionIntegrationState } from '../../src/domain/session-integrations.js';
import { CredentialBroker } from '../../src/credentials/broker.js';
import { WebhookIngressService } from '../../src/ingress/service.js';
import { GitHubIngressAdapter } from '../../src/ingress/providers/github.js';
import { GitLabIngressAdapter } from '../../src/ingress/providers/gitlab.js';
import { TeamsIngressAdapter } from '../../src/ingress/providers/teams.js';
import { RuntimePluginRegistry } from '../../src/plugins/registry.js';
import { StoredSourceSessionResolver } from '../../src/plugins/source-policies.js';

const integration = process.env.LOCALSTACK_E2E === 'true' ? describe : describe.skip;
async function fixture() {
  const clients = createAwsClients();
  const ownerId = `local:${randomUUID()}`;
  const artifacts = new S3ArtifactStore(clients.s3, required('DEFINITION_BUCKET'));
  const store = new DynamoAgentsStore(clients.dynamodb, required('AGENTS_TABLE_NAME'), artifacts);
  const integrationStore = new DynamoIntegrationStore(clients.dynamodb, required('INTEGRATIONS_TABLE_NAME'));
  const credentials = new CredentialBroker(new CachedSecretReader(clients.secrets));
  const agents = new AgentService({ store });
  const agent = await agents.create(ownerId, { model: 'local-protocol-fixture' });
  const observations = new Map<string, SessionTurnObservation>();
  const execution: SessionExecution = {
    prepare: async (_owner, _id, env) => { if (env.type !== 'none') throw new Error('Fixture uses no execution environment'); return env; },
    start: async (_owner, _session, binding) => { observations.set(binding.turn.id, { turn: { ...binding.turn, status: 'completed', completed_at: 2 }, requiredActions: [] }); },
    steer: async () => {}, cancel: async () => {}, toolResult: async () => {},
    observe: async (_owner, _session, turn) => observations.get(turn.id) ?? { turn, requiredActions: [] },
    items: async (_owner, _session, turnId) => [{ id: `out_${turnId}`, turn_id: turnId, type: 'message', status: 'completed', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Local durable answer', annotations: [] }] }],
    artifacts: async () => [], artifactContent: async () => new ReadableStream(),
  };
  const sessions = new SessionService({ store, agents, execution });
  const delivery = { deliver: vi.fn(async () => {}) };
  const submissions = new SessionIntegrationService({ store, sessions, delivery });
  const resolver = new StoredSourceSessionResolver(integrationStore);
  return { clients, store, integrationStore, credentials, sessions, submissions, resolver, agent, ownerId, delivery };
}

integration('LocalStack durable provider Sessions and schedules', () => {
  it.each(['github', 'gitlab'] as const)('persists signed %s occurrences once under the binding owner', async (provider) => {
    const f = await fixture();
    const eventId = randomUUID();
    const repository = `local-fixtures/${eventId}`;
    await f.integrationStore.putSourceBinding({ version: '1', bindingId: eventId, ownerId: f.ownerId, sourceKind: provider, selector: provider === 'github' ? { repository } : { projectId: eventId }, agentId: f.agent.id, environment: { type: 'openai_hosted' } });
    const adapter = provider === 'github' ? new GitHubIngressAdapter(f.credentials, { webhookSecretArn: required('GITHUB_WEBHOOK_SECRET_ARN'), commentTrigger: '@rat-things' }) : new GitLabIngressAdapter(f.credentials, { webhookSecretArn: required('GITLAB_WEBHOOK_SECRET_ARN'), commentTrigger: '@rat-things' });
    const registry = new RuntimePluginRegistry([{ manifest: { name: provider, version: '1', description: 'Signed fixture', provider }, ingress: adapter }]);
    const ingress = new WebhookIngressService(registry, f.submissions, f.resolver);
    const body = JSON.stringify(provider === 'github' ? { action: 'opened', number: 17, repository: { full_name: repository, clone_url: `https://github.com/${repository}.git` }, pull_request: { title: 'Review', head: { sha: '0123456789abcdef0123456789abcdef01234567' } } } : { object_kind: 'merge_request', project: { id: eventId, path_with_namespace: repository, git_http_url: `https://gitlab.com/${repository}.git` }, object_attributes: { iid: 17, action: 'open', title: 'Review', last_commit: { id: '0123456789abcdef0123456789abcdef01234567' } } });
    const headers = provider === 'github' ? { 'x-github-event': 'pull_request', 'x-github-delivery': eventId, 'x-hub-signature-256': `sha256=${createHmac('sha256', required('GITHUB_WEBHOOK_SIGNING_SECRET')).update(body).digest('hex')}` } : { 'x-gitlab-event': 'Merge Request Hook', 'x-gitlab-webhook-uuid': eventId, 'x-gitlab-token': required('GITLAB_WEBHOOK_SIGNING_TOKEN') };
    const request = { body, headers };
    const first = await ingress.receive(provider, request);
    expect(first.statusCode).toBe(202);
    expect(await ingress.receive(provider, request)).toEqual(first);
    const { sessionId } = first.body as { sessionId: string };
    expect(sessionId).toMatch(/^sess_/);
    const saved = await f.store.get<SessionIntegrationState>(f.ownerId, 'session_integrations', sessionId);
    expect(saved?.value.inputs).toHaveLength(1);
    expect(saved?.value.inputs[0]?.source.kind).toBe(provider);
    expect(await f.store.get('another-owner', 'session_integrations', sessionId)).toBeUndefined();
    expect((await ingress.receive(provider, { body: 'invalid json', headers: {} })).statusCode).toBe(401);
  });

  it('continues a signed Teams thread and delivers each saved root Turn', async () => {
    const f = await fixture();
    const tenant = randomUUID();
    await f.integrationStore.putSourceBinding({ version: '1', bindingId: tenant, ownerId: f.ownerId, sourceKind: 'teams', selector: { tenantId: tenant }, agentId: f.agent.id, environment: { type: 'none' } });
    const adapter = new TeamsIngressAdapter(f.credentials, { webhookSecretArn: required('TEAMS_OUTGOING_WEBHOOK_SECRET_ARN') });
    const ingress = new WebhookIngressService(new RuntimePluginRegistry([{ manifest: { name: 'teams', version: '1', description: 'Teams fixture', provider: 'teams' }, ingress: adapter }]), f.submissions, f.resolver);
    for (const id of ['first', 'second']) {
      const body = JSON.stringify({ id, text: `Question ${id}`, from: { id: 'user' }, conversation: { id: 'thread' }, channelData: { tenant: { id: tenant } } });
      const authorization = `HMAC ${createHmac('sha256', Buffer.from(required('TEAMS_SIGNING_SECRET'), 'base64')).update(body).digest('base64')}`;
      const accepted = await ingress.receive('teams', { body, headers: { authorization } });
      expect(accepted.statusCode).toBe(200);
      const saved = (await f.store.list<SessionIntegrationState>(f.ownerId, 'session_integrations', { limit: 100 })).data[0]!;
      await f.submissions.submitPending(f.ownerId, saved.id);
      await f.sessions.dispatch(f.ownerId, saved.id);
      await f.sessions.completeReadyTurns(f.ownerId, saved.id);
      await f.submissions.deliverReady(f.ownerId, saved.id);
    }
    const saved = (await f.sessions.list(f.ownerId)).data;
    expect(saved).toHaveLength(1);
    expect((await f.sessions.turns(f.ownerId, saved[0]!.id)).data).toHaveLength(2);
    expect(f.delivery.deliver).toHaveBeenCalledWith(expect.objectContaining({ sessionId: saved[0]!.id, turn: expect.objectContaining({ status: 'completed' }) }));
  });

  it('reserves schedule occurrences durably and fences stale generations', async () => {
    const f = await fixture();
    const service = new ScheduleService({ store: f.store, sessions: f.sessions, integrations: f.submissions, scheduler: { upsert: async () => {}, remove: async () => {} }, validateTarget: async () => {} });
    const schedule = await service.create(f.ownerId, { agentId: f.agent.id, environment: { type: 'none' }, name: 'Check', input: 'Check {{scheduled_at}}', expression: 'rate(5 minutes)' });
    const occurrence = { ownerId: f.ownerId, scheduleId: schedule.id, generation: schedule.generation, scheduledAt: '2026-09-12T10:00:00Z' };
    const first = await service.invoke(occurrence);
    expect(await service.invoke(occurrence)).toEqual(first);
    await service.status(f.ownerId, schedule.id, 'paused');
    expect(await service.invoke({ ...occurrence, scheduledAt: '2026-09-12T10:05:00Z' })).toEqual({ accepted: false, reason: 'stale_schedule' });
  });
});
function required(name: string): string { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; }
