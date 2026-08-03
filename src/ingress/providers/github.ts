import { normalizeGitHubWebhook } from '../../channels/normalize.js';
import { header, verifyGitHubSignature } from '../../channels/signatures.js';
import type { CredentialBroker } from '../../credentials/broker.js';
import { parseWebhookJson } from '../json.js';
import type { IngressDecision, IngressWork, WebhookIngressAdapter, WebhookRequest, WebhookResponse } from '../types.js';
import { jsonResponse, normalizedWork } from './shared.js';

export interface GitHubIngressOptions {
  webhookSecretArn?: string | undefined;
  cloneTokenSecretArn?: string | undefined;
  commentTrigger: string;
}

export class GitHubIngressAdapter implements WebhookIngressAdapter {
  public readonly provider = 'github' as const;

  public constructor(
    private readonly credentials: CredentialBroker,
    private readonly options: GitHubIngressOptions,
  ) {}

  public async receive(request: WebhookRequest): Promise<IngressDecision> {
    const secret = await this.credentials.read(this.options.webhookSecretArn, ['secret', 'webhook_secret']);
    if (!verifyGitHubSignature(request.body, header(request.headers, 'x-hub-signature-256'), secret)) {
      return { kind: 'response', response: jsonResponse(401, error('invalid_signature', 'invalid GitHub signature')) };
    }
    const eventName = header(request.headers, 'x-github-event');
    const deliveryId = header(request.headers, 'x-github-delivery');
    if (!eventName || !deliveryId) {
      return { kind: 'response', response: jsonResponse(400, error('missing_headers', 'missing GitHub event headers')) };
    }
    const normalized = normalizeGitHubWebhook(
      eventName,
      deliveryId,
      parseWebhookJson(request.body),
      this.options.cloneTokenSecretArn,
      this.options.commentTrigger,
    );
    if (!normalized) return { kind: 'response', response: jsonResponse(202, { accepted: false, ignored: true }) };
    return { kind: 'run', work: normalizedWork(normalized, deliveryId) };
  }

  public acknowledge(run: { runId: string }, _work: IngressWork): WebhookResponse {
    return jsonResponse(202, { accepted: true, runId: run.runId });
  }
}

function error(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}
