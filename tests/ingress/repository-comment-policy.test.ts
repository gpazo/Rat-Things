import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { CredentialBroker } from '../../src/credentials/broker.js';
import type { SourceEventPolicy } from '../../src/domain/event-policy.js';
import { GitHubIngressAdapter } from '../../src/ingress/providers/github.js';
import { GitLabIngressAdapter } from '../../src/ingress/providers/gitlab.js';
import { WebhookIngressService } from '../../src/ingress/service.js';
import { RuntimePluginRegistry } from '../../src/plugins/registry.js';

const secret = 'repository-comment-webhook-secret';
type Provider = 'github' | 'gitlab';

describe('signed repository comment admission', () => {
  it.each(['github', 'gitlab'] as const)('%s denies a triggered comment even in an active subscription without an actor allowlist', async provider => {
    const f = fixture(provider, { mode: 'explicit' }, true);
    const response = await f.service.receive(provider, signedRequest(provider, commentBody(provider, true)));

    expect(response).toEqual({ statusCode: 202, body: { accepted: false, reason: 'event_policy' } });
    expect(f.accept).not.toHaveBeenCalled();
    expect(f.candidates.enqueue).not.toHaveBeenCalled();
  });

  it.each(['github', 'gitlab'] as const)('%s allows explicit and subscribed comments for the exact allowlisted actor', async provider => {
    const actorId = actor(provider);
    const explicit = fixture(provider, { mode: 'explicit', actors: { allow: [actorId] } }, false);
    expect(await explicit.service.receive(provider, signedRequest(provider, commentBody(provider, true)))).toMatchObject({ statusCode: 202, body: { accepted: true, sessionId: 'sess_1' } });
    expect(explicit.accept.mock.calls[0]?.[4]).toMatchObject({ actor: { id: actorId } });

    const continued = fixture(provider, { mode: 'explicit', actors: { allow: [actorId] } }, true);
    expect(await continued.service.receive(provider, signedRequest(provider, commentBody(provider, false)))).toMatchObject({ statusCode: 202, body: { accepted: true, sessionId: 'sess_1' } });
    expect(continued.accept).toHaveBeenCalledOnce();
  });

  it.each(['github', 'gitlab'] as const)('%s keeps deny precedence over an actor allowlist', async provider => {
    const actorId = actor(provider);
    const f = fixture(provider, { mode: 'explicit', actors: { allow: [actorId], deny: [actorId] } }, true);

    expect(await f.service.receive(provider, signedRequest(provider, commentBody(provider, true)))).toMatchObject({ statusCode: 202, body: { accepted: false, reason: 'event_policy' } });
    expect(f.accept).not.toHaveBeenCalled();
  });

  it.each(['github', 'gitlab'] as const)('%s requires the allowlist before candidate classification', async provider => {
    const candidatePolicy: SourceEventPolicy = { mode: 'candidate', semantic: { policies: ['Relevant comments'], maxCandidatesPerHour: 10 } };
    const denied = fixture(provider, candidatePolicy, false);
    expect(await denied.service.receive(provider, signedRequest(provider, commentBody(provider, false)))).toMatchObject({ statusCode: 202, body: { accepted: false, reason: 'event_policy' } });
    expect(denied.candidates.enqueue).not.toHaveBeenCalled();

    const allowed = fixture(provider, { ...candidatePolicy, actors: { allow: [actor(provider)] } }, false);
    expect(await allowed.service.receive(provider, signedRequest(provider, commentBody(provider, false)))).toMatchObject({ statusCode: 202, body: { accepted: true, candidateId: 'candidate_1' } });
    expect(allowed.candidates.enqueue).toHaveBeenCalledOnce();
  });

  it.each([
    ['github', false], ['github', true], ['gitlab', false], ['gitlab', true],
  ] as const)('%s %s lifecycle review keeps current admission without an actor policy', async (provider, bot) => {
    const f = fixture(provider, undefined, false);
    const response = await f.service.receive(provider, signedRequest(provider, lifecycleBody(provider, bot)));

    expect(response).toMatchObject({ statusCode: 202, body: { accepted: true, sessionId: 'sess_1' } });
    expect(f.accept.mock.calls[0]?.[4]).toMatchObject({ actor: { kind: bot ? 'system' : 'human' } });
  });
});

function fixture(provider: Provider, eventPolicy: SourceEventPolicy | undefined, subscribed: boolean) {
  const credentials = new CredentialBroker({ get: async () => secret });
  const adapter = provider === 'github'
    ? new GitHubIngressAdapter(credentials, { webhookSecretArn: 'test-secret', commentTrigger: '@agent' })
    : new GitLabIngressAdapter(credentials, { webhookSecretArn: 'test-secret', commentTrigger: '@agent' });
  const registry = new RuntimePluginRegistry([{
    manifest: { name: `${provider}-test`, version: '1', description: 'Signed repository comment test', provider },
    ingress: adapter,
  }]);
  const accept = vi.fn(async () => ({ sessionId: 'sess_1' }));
  const candidates = {
    receipt: vi.fn(async () => undefined),
    enqueue: vi.fn(async () => ({ candidateId: 'candidate_1' })),
    recordExplicit: vi.fn(async () => {}),
  };
  const binding = { ownerId: 'operator', bindingId: 'binding_1', agentId: 'agent_1', environment: { type: 'none' as const }, ...(eventPolicy ? { eventPolicy } : {}) };
  const service = new WebhookIngressService(registry, {
    accept,
    hasActiveSubscription: async () => subscribed,
  }, { resolve: async () => binding }, candidates);
  return { service, accept, candidates };
}

function signedRequest(provider: Provider, payload: Record<string, unknown>) {
  const body = JSON.stringify(payload);
  if (provider === 'github') {
    const delivery = 'github-delivery';
    return { body, headers: { 'x-github-event': String(payload.eventName ?? 'issue_comment'), 'x-github-delivery': delivery,
      'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` } };
  }
  return { body, headers: { 'x-gitlab-event': String(payload.eventName ?? 'Note Hook'), 'x-gitlab-webhook-uuid': 'gitlab-delivery', 'x-gitlab-token': secret } };
}

function commentBody(provider: Provider, triggered: boolean): Record<string, unknown> {
  const text = `${triggered ? '@agent ' : ''}Please inspect the failing request.`;
  return provider === 'github'
    ? { action: 'created', repository: { full_name: 'acme/widgets', clone_url: 'https://github.com/acme/widgets.git' },
      issue: { number: 7, pull_request: { url: 'https://api.github.test/pulls/7' } },
      comment: { body: text, user: { login: 'commenter', type: 'User' } } }
    : { object_kind: 'note', project: { id: 81, path_with_namespace: 'acme/widgets', git_http_url: 'https://gitlab.com/acme/widgets.git' },
      object_attributes: { action: 'create', note: text }, merge_request: { iid: 7, last_commit: { id: 'abc123' } }, user: { id: 17, bot: false } };
}

function lifecycleBody(provider: Provider, bot: boolean): Record<string, unknown> {
  return provider === 'github'
    ? { eventName: 'pull_request', action: 'opened', number: 7, repository: { full_name: 'acme/widgets', clone_url: 'https://github.com/acme/widgets.git' },
      sender: { login: bot ? 'dependabot[bot]' : 'octocat', type: bot ? 'Bot' : 'User' },
      pull_request: { title: 'Update dependency', user: { login: bot ? 'dependabot[bot]' : 'octocat' }, head: { sha: 'abc123' } } }
    : { eventName: 'Merge Request Hook', object_kind: 'merge_request', project: { id: 81, path_with_namespace: 'acme/widgets', git_http_url: 'https://gitlab.com/acme/widgets.git' },
      object_attributes: { action: 'open', iid: 7, last_commit: { id: 'abc123' } }, user: { id: 17, bot } };
}

function actor(provider: Provider): string { return provider === 'github' ? 'github:commenter' : 'gitlab:17'; }
