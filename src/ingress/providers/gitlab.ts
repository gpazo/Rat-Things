import { createHash } from 'node:crypto';
import { normalizeGitLabWebhook } from '../../channels/normalize.js';
import { header, verifyGitLabStandardSignature, verifyGitLabToken } from '../../channels/signatures.js';
import type { CredentialBroker } from '../../credentials/broker.js';
import { parseWebhookJson } from '../json.js';
import type { IngressDecision, IngressWork, WebhookIngressAdapter, WebhookRequest, WebhookResponse } from '../types.js';
import { jsonResponse, normalizedWork } from './shared.js';

export interface GitLabIngressOptions {
  webhookSecretArn?: string | undefined;
  cloneTokenSecretArn?: string | undefined;
  commentTrigger: string;
}

export class GitLabIngressAdapter implements WebhookIngressAdapter {
  public readonly provider = 'gitlab' as const;

  public constructor(
    private readonly credentials: CredentialBroker,
    private readonly options: GitLabIngressOptions,
  ) {}

  public async receive(request: WebhookRequest): Promise<IngressDecision> {
    const secret = await this.credentials.read(
      this.options.webhookSecretArn,
      ['signing_token', 'token', 'secret', 'webhook_secret'],
    );
    const standardSignature = header(request.headers, 'webhook-signature');
    const authenticated = standardSignature
      ? verifyGitLabStandardSignature(
          request.body,
          header(request.headers, 'webhook-id'),
          header(request.headers, 'webhook-timestamp'),
          standardSignature,
          secret,
        )
      : verifyGitLabToken(header(request.headers, 'x-gitlab-token'), secret);
    if (!authenticated) {
      return {
        kind: 'response',
        response: jsonResponse(401, error('invalid_signature', 'invalid GitLab webhook authentication')),
      };
    }
    const eventName = header(request.headers, 'x-gitlab-event');
    if (!eventName) {
      return { kind: 'response', response: jsonResponse(400, error('missing_headers', 'missing GitLab event header')) };
    }
    const deliveryId =
      header(request.headers, 'webhook-id') ??
      header(request.headers, 'idempotency-key') ??
      header(request.headers, 'x-gitlab-webhook-uuid') ??
      header(request.headers, 'x-request-id') ??
      createHash('sha256').update(request.body).digest('hex');
    const normalized = normalizeGitLabWebhook(
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
