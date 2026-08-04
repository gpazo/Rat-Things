import type { RunRecord, RunRequest } from '../domain/contracts.js';
import type { IngressContext, ProviderKind } from '../identity/context.js';
import type { SubmitOptions } from '../core/run-service.js';

export interface WebhookRequest {
  body: string;
  headers: Record<string, string | undefined>;
}

export interface WebhookResponse {
  statusCode: number;
  body: unknown;
}

export interface IngressWork {
  context: IngressContext;
  request: RunRequest;
  submit: SubmitOptions;
}

export type IngressDecision =
  | { kind: 'run'; work: IngressWork }
  | { kind: 'response'; response: WebhookResponse };

export interface WebhookIngressAdapter {
  readonly provider: ProviderKind;
  receive(request: WebhookRequest): Promise<IngressDecision>;
  acknowledge(run: RunRecord, work: IngressWork): WebhookResponse;
  acknowledgeConversation?(
    receipt: { conversationId: string; messageId: string },
    work: IngressWork,
  ): WebhookResponse;
}

export interface RunSubmissionPort {
  submit(ownerId: string, request: unknown, options?: SubmitOptions): Promise<RunRecord>;
}

export interface ConversationSubmissionPort {
  submit(work: IngressWork): Promise<{ conversationId: string; messageId: string }>;
}
