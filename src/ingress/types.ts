import type { RunSource } from '../domain/contracts.js';
import type { SessionIntegrationInput, SessionIntegrationTarget } from '../domain/session-integrations.js';
import type { IngressContext, ProviderKind } from '../identity/context.js';

export interface WebhookRequest { body: string; headers: Record<string, string | undefined> }
export interface WebhookResponse { statusCode: number; body: unknown }
export interface IngressWork {
  context: IngressContext;
  input: SessionIntegrationInput;
  threadId: string;
}
export type IngressDecision = { kind: 'session'; work: IngressWork } | { kind: 'response'; response: WebhookResponse };
export interface WebhookIngressAdapter {
  readonly provider: ProviderKind;
  receive(request: WebhookRequest): Promise<IngressDecision>;
  acknowledge(session: { sessionId: string }, work: IngressWork): WebhookResponse;
}
export interface SessionIngressPort {
  accept(ownerId: string, bindingId: string, threadId: string, target: SessionIntegrationTarget, input: SessionIntegrationInput): Promise<{ sessionId: string }>;
}
export interface SourceSessionResolver {
  resolve(source: RunSource): Promise<(SessionIntegrationTarget & { bindingId: string; ownerId: string }) | undefined>;
}
