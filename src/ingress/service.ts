import type { ProviderKind } from '../identity/context.js';
import type { RuntimePluginRegistry } from '../plugins/registry.js';
import type { SessionIngressPort, SourceSessionResolver, WebhookRequest, WebhookResponse } from './types.js';
import { classifyEvent } from '../core/event-filter-planning.js';
import type { EventCandidateService } from '../core/event-candidate-service.js';
import { threadForSource } from './thread.js';

export class WebhookIngressService {
  public constructor(private readonly plugins: RuntimePluginRegistry, private readonly sessions: SessionIngressPort, private readonly sources: SourceSessionResolver,
    private readonly candidates?: Pick<EventCandidateService, 'enqueue' | 'recordExplicit' | 'receipt'>) {}

  public async receive(provider: ProviderKind, request: WebhookRequest): Promise<WebhookResponse> {
    const adapter = this.plugins.ingressFor(provider);
    const decision = await adapter.receive(request);
    if (decision.kind === 'response') return decision.response;
    const { work } = decision;
    const binding = await this.sources.resolve(work.context.source);
    if (!binding) return { statusCode: 202, body: { accepted: false, reason: 'source_not_bound' } };
    const threadId = threadForSource(work.context.source, binding.threadScope) ?? work.threadId;
    const event = work.event ?? { mentioned: true, actorId: work.context.actor.id };
    const input = {
      ...work.input, source: work.context.source, actor: work.context.actor, credentialSubject: work.context.credentialSubject,
    };
    if (!event.mentioned) {
      const previous = await this.candidates?.receipt(binding.ownerId, binding.bindingId, threadId, input);
      if (previous) return candidateReceiptResponse(previous);
    }
    const subscribed = await this.sessions.hasActiveSubscription?.(binding.ownerId, binding.bindingId, threadId) ?? false;
    const classification = classifyEvent(event, binding.eventPolicy, subscribed);
    if (classification === 'drop') {
      if (event.mentioned) {
        const previous = await this.candidates?.receipt(binding.ownerId, binding.bindingId, threadId, input);
        if (previous) return candidateReceiptResponse(previous);
      }
      return { statusCode: 202, body: { accepted: false, reason: 'event_policy' } };
    }
    if (classification === 'candidate') {
      if (!this.candidates || !binding.eventPolicy) return { statusCode: 202, body: { accepted: false, reason: 'candidate_filter_disabled' } };
      const receipt = await this.candidates.enqueue(binding.ownerId, binding.bindingId, threadId, binding, input, binding.eventPolicy);
      if (receipt.retry) return pendingExplicitReceiptResponse();
      if (receipt.duplicate) return { statusCode: 202, body: { accepted: true, duplicate: true } };
      return { statusCode: 202, body: { accepted: true, ...receipt } };
    }
    if (event.mentioned) await this.candidates?.recordExplicit(binding.ownerId, binding.bindingId, threadId, input.id);
    const session = await this.sessions.accept(binding.ownerId, binding.bindingId, threadId, binding, input);
    return adapter.acknowledge(session, work);
  }
}

function candidateReceiptResponse(receipt: { candidateId: string; duplicate?: true; retry?: true }): WebhookResponse {
  if (receipt.retry) return pendingExplicitReceiptResponse();
  return receipt.duplicate
    ? { statusCode: 202, body: { accepted: true, duplicate: true } }
    : { statusCode: 202, body: { accepted: true, candidateId: receipt.candidateId } };
}

function pendingExplicitReceiptResponse(): WebhookResponse {
  return { statusCode: 503, body: { accepted: false, reason: 'explicit_occurrence_pending' } };
}
