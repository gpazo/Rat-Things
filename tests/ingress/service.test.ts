import { describe, expect, it, vi } from 'vitest';
import { providerIngressContext } from '../../src/identity/context.js';
import { WebhookIngressService } from '../../src/ingress/service.js';
import { RuntimePluginRegistry } from '../../src/plugins/registry.js';

const source = { kind: 'github' as const, deliveryId: 'delivery-1', event: 'pull_request', repository: 'acme/runtime', issueNumber: 7 };
function fixture(bound = true, candidate = false) {
  const context = providerIngressContext({ ownerId: 'github:installation-1', actorId: 'github:installation-1', actorKind: 'system', source });
  const accept = vi.fn().mockResolvedValue({ sessionId: 'sess_1' });
  const acknowledge = vi.fn().mockReturnValue({ statusCode: 202, body: { sessionId: 'sess_1' } });
  const registry = new RuntimePluginRegistry([{ manifest: { name: 'github', version: '1', description: 'test GitHub plugin', provider: 'github' }, ingress: {
    provider: 'github', receive: vi.fn().mockResolvedValue({ kind: 'session', work: { context, threadId: 'delivery-1', event: { mentioned: !candidate, actorId: context.actor.id }, input: { id: 'github:delivery-1', text: 'review this change', source: { kind: 'api', requestId: 'untrusted' }, actor: { kind: 'human', id: 'untrusted' } } } }), acknowledge,
  } }]);
  const binding = { ownerId: 'operator', bindingId: 'binding-1', agentId: 'agent_1', environment: { type: 'none' as const }, ...(candidate ? { eventPolicy: { mode: 'candidate' as const, semantic: { policies: ['Unresolved failures'], maxCandidatesPerHour: 10 } } } : {}) };
  const resolve = vi.fn().mockResolvedValue(bound ? binding : undefined);
  const candidates = { enqueue: vi.fn().mockResolvedValue({ candidateId: 'candidate_one' }), recordExplicit: vi.fn().mockResolvedValue(undefined) };
  const hasActiveSubscription = vi.fn().mockResolvedValue(false);
  return { service: new WebhookIngressService(registry, { accept, hasActiveSubscription }, { resolve }, candidates), accept, resolve, binding, context, candidates, hasActiveSubscription };
}
describe('webhook Session ingress', () => {
  it('acknowledges a durable candidate without submitting a Session or waiting for inference', async () => {
    const f = fixture(true, true);
    expect(await f.service.receive('github', { body: '{}', headers: {} })).toEqual({ statusCode: 202, body: { accepted: true, candidateId: 'candidate_one' } });
    expect(f.candidates.enqueue).toHaveBeenCalledOnce();
    expect(f.accept).not.toHaveBeenCalled();
  });
  it('bypasses the semantic filter for an active subscription', async () => {
    const f = fixture(true, true);
    f.hasActiveSubscription.mockResolvedValue(true);
    await f.service.receive('github', { body: '{}', headers: {} });
    expect(f.accept).toHaveBeenCalledOnce();
    expect(f.candidates.enqueue).not.toHaveBeenCalled();
  });
  it('uses the operator-owned binding while preserving trusted provider attribution', async () => {
    const f = fixture();
    expect(await f.service.receive('github', { body: '{}', headers: {} })).toEqual({ statusCode: 202, body: { sessionId: 'sess_1' } });
    expect(f.resolve).toHaveBeenCalledWith(source);
    expect(f.accept).toHaveBeenCalledWith('operator', 'binding-1', JSON.stringify(['github', 'acme/runtime', 7]), f.binding, expect.objectContaining({ source, actor: f.context.actor, credentialSubject: f.context.credentialSubject }));
  });
  it('acknowledges unbound events without choosing a default Agent', async () => {
    const f = fixture(false);
    expect(await f.service.receive('github', { body: '{}', headers: {} })).toEqual({ statusCode: 202, body: { accepted: false, reason: 'source_not_bound' } });
    expect(f.accept).not.toHaveBeenCalled();
  });
});
