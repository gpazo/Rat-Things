import type { RunRecord, RunRequest, RunSource } from '../domain/contracts.js';
import type { IngressContext, ProviderKind } from '../identity/context.js';
import type { RunSubmissionOptions } from '../core/run-submission-service.js';

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
  submit: RunSubmissionOptions;
  /** Trusted owner whose source binding delegated capabilities to this work. */
  policyOwnerId?: string;
}

export type IngressDecision =
  | { kind: 'run'; work: IngressWork }
  | { kind: 'response'; response: WebhookResponse };

export interface WebhookIngressAdapter {
  readonly provider: ProviderKind;
  receive(request: WebhookRequest): Promise<IngressDecision>;
  acknowledge(run: RunRecord, work: IngressWork): WebhookResponse;
}

export interface RunSubmissionPort {
  submit(ownerId: string, request: unknown, options?: RunSubmissionOptions): Promise<RunRecord>;
}

export interface SourcePolicyResolver {
  apply(ownerId: string, request: RunRequest, source: RunSource): Promise<{
    request: RunRequest;
    policyOwnerId?: string;
  }>;
}
