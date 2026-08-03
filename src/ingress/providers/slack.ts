import { normalizeSlackEvent } from '../../channels/normalize.js';
import { header, verifySlackSignature } from '../../channels/signatures.js';
import type { CredentialBroker } from '../../credentials/broker.js';
import { parseWebhookJson } from '../json.js';
import type { IngressDecision, IngressWork, WebhookIngressAdapter, WebhookRequest, WebhookResponse } from '../types.js';
import { jsonResponse, normalizedWork } from './shared.js';

export interface SlackIngressOptions {
  signingSecretArn?: string | undefined;
}

export class SlackIngressAdapter implements WebhookIngressAdapter {
  public readonly provider = 'slack' as const;

  public constructor(
    private readonly credentials: CredentialBroker,
    private readonly options: SlackIngressOptions,
  ) {}

  public async receive(request: WebhookRequest): Promise<IngressDecision> {
    const secret = await this.credentials.read(this.options.signingSecretArn, ['secret', 'signing_secret']);
    if (!verifySlackSignature(
      request.body,
      header(request.headers, 'x-slack-request-timestamp'),
      header(request.headers, 'x-slack-signature'),
      secret,
    )) {
      return { kind: 'response', response: jsonResponse(401, error('invalid_signature', 'invalid Slack signature')) };
    }
    const payload = parseWebhookJson(request.body);
    if (isUrlVerification(payload)) {
      return { kind: 'response', response: jsonResponse(200, { challenge: payload.challenge }) };
    }
    const normalized = normalizeSlackEvent(payload);
    if (!normalized) return { kind: 'response', response: jsonResponse(202, { accepted: false, ignored: true }) };
    return { kind: 'run', work: normalizedWork(normalized, normalized.idempotencyKey) };
  }

  public acknowledge(run: { runId: string }, _work: IngressWork): WebhookResponse {
    return jsonResponse(202, { accepted: true, runId: run.runId });
  }
}

function isUrlVerification(value: unknown): value is { type: 'url_verification'; challenge?: unknown } {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    (value as Record<string, unknown>).type === 'url_verification');
}

function error(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}
