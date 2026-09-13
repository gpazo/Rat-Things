import type { ProviderKind } from '../identity/context.js';
import type { RuntimePluginRegistry } from '../plugins/registry.js';
import type { SessionIngressPort, SourceSessionResolver, WebhookRequest, WebhookResponse } from './types.js';

export class WebhookIngressService {
  public constructor(private readonly plugins: RuntimePluginRegistry, private readonly sessions: SessionIngressPort, private readonly sources: SourceSessionResolver) {}

  public async receive(provider: ProviderKind, request: WebhookRequest): Promise<WebhookResponse> {
    const adapter = this.plugins.ingressFor(provider);
    const decision = await adapter.receive(request);
    if (decision.kind === 'response') return decision.response;
    const { work } = decision;
    const binding = await this.sources.resolve(work.context.source);
    if (!binding) return { statusCode: 202, body: { accepted: false, reason: 'source_not_bound' } };
    // The authenticated operator owns this Agent binding; the provider supplies attribution only.
    const session = await this.sessions.accept(binding.ownerId, binding.bindingId, work.threadId, binding, {
      ...work.input, source: work.context.source, actor: work.context.actor, credentialSubject: work.context.credentialSubject,
    });
    return adapter.acknowledge(session, work);
  }
}
