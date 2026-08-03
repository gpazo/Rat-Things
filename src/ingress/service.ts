import type { ProviderKind } from '../identity/context.js';
import type { RuntimePluginRegistry } from '../plugins/registry.js';
import type { RunSubmissionPort, WebhookRequest, WebhookResponse } from './types.js';

export class WebhookIngressService {
  public constructor(
    private readonly plugins: RuntimePluginRegistry,
    private readonly runs: RunSubmissionPort,
  ) {}

  public async receive(provider: ProviderKind, request: WebhookRequest): Promise<WebhookResponse> {
    const adapter = this.plugins.ingressFor(provider);
    const decision = await adapter.receive(request);
    if (decision.kind === 'response') return decision.response;
    const trustedRequest = { ...decision.work.request, source: decision.work.context.source };
    const run = await this.runs.submit(
      decision.work.context.owner.id,
      trustedRequest,
      {
        ...decision.work.submit,
        provenance: {
          actor: decision.work.context.actor,
          credentialSubject: decision.work.context.credentialSubject,
        },
      },
    );
    return adapter.acknowledge(run, decision.work);
  }
}
