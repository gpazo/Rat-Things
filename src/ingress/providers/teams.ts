import { normalizeTeamsWebhook } from '../../channels/normalize.js';
import { header, verifyTeamsSignature } from '../../channels/signatures.js';
import type { CredentialBroker } from '../../credentials/broker.js';
import { parseWebhookJson } from '../json.js';
import type { IngressDecision, IngressWork, WebhookIngressAdapter, WebhookRequest, WebhookResponse } from '../types.js';
import { jsonResponse, normalizedWork } from './shared.js';

export interface TeamsIngressOptions {
  webhookSecretArn?: string | undefined;
}

export class TeamsIngressAdapter implements WebhookIngressAdapter {
  public readonly provider = 'teams' as const;

  public constructor(
    private readonly credentials: CredentialBroker,
    private readonly options: TeamsIngressOptions,
  ) {}

  public async receive(request: WebhookRequest): Promise<IngressDecision> {
    const secret = await this.credentials.read(this.options.webhookSecretArn, ['secret', 'hmac_secret']);
    if (!verifyTeamsSignature(request.body, header(request.headers, 'authorization'), secret)) {
      return { kind: 'response', response: jsonResponse(401, error('invalid_signature', 'invalid Teams signature')) };
    }
    const normalized = normalizeTeamsWebhook(parseWebhookJson(request.body));
    if (!normalized) {
      return { kind: 'response', response: jsonResponse(400, error('invalid_activity', 'unsupported Teams activity')) };
    }
    const source = normalized.request.source;
    const traceId = source?.kind === 'teams' ? source.activityId : normalized.idempotencyKey;
    return { kind: 'run', work: normalizedWork(normalized, traceId) };
  }

  public acknowledge(run: { runId: string }, _work: IngressWork): WebhookResponse {
    return jsonResponse(200, {
      type: 'message',
      text: `Rat Things request received. I'll reply when run ${run.runId} finishes.`,
    });
  }
}

function error(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}
