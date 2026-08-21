import type { ProviderKind } from '../identity/context.js';
import type { RuntimePluginRegistry } from '../plugins/registry.js';
import type {
  ConversationSubmissionPort,
  RunSubmissionPort,
  WebhookRequest,
  WebhookResponse,
  SourcePolicyResolver,
} from './types.js';

export class WebhookIngressService {
  public constructor(
    private readonly plugins: RuntimePluginRegistry,
    private readonly runs: RunSubmissionPort,
    private readonly conversations?: ConversationSubmissionPort,
    private readonly sourcePolicies?: SourcePolicyResolver,
  ) {}

  public async receive(provider: ProviderKind, request: WebhookRequest): Promise<WebhookResponse> {
    const adapter = this.plugins.ingressFor(provider);
    const decision = await adapter.receive(request);
    if (decision.kind === 'response') return decision.response;
    const sourcePolicy = this.sourcePolicies
      ? await this.sourcePolicies.apply(
          decision.work.context.owner.id,
          decision.work.request,
          decision.work.context.source,
        )
      : { request: decision.work.request };
    const work = {
      ...decision.work,
      request: sourcePolicy.request,
      ...(sourcePolicy.policyOwnerId ? { policyOwnerId: sourcePolicy.policyOwnerId } : {}),
    };
    if (provider === 'teams' && this.conversations && adapter.acknowledgeConversation) {
      const receipt = await this.conversations.submit(work);
      return adapter.acknowledgeConversation(receipt, work);
    }
    const trustedRequest = { ...work.request, source: work.context.source };
    const run = await this.runs.submit(
      work.context.owner.id,
      trustedRequest,
      {
        ...work.submit,
        provenance: {
          actor: work.context.actor,
          credentialSubject: work.context.credentialSubject,
        },
        ...(work.policyOwnerId ? { capabilityOwnerId: work.policyOwnerId } : {}),
      },
    );
    return adapter.acknowledge(run, work);
  }
}
