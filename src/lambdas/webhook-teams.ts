import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { createAwsClients, CachedSecretReader } from '../adapters/aws-runtime.js';
import { normalizeTeamsWebhook } from '../channels/normalize.js';
import { verifyTeamsSignature } from '../channels/signatures.js';
import { errorResponse, getRunService, header, parseJson, rawBody, response, secretValue } from './runtime.js';

const secrets = new CachedSecretReader(createAwsClients().secrets);

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const body = rawBody(event);
    const secretArn = required('TEAMS_OUTGOING_WEBHOOK_SECRET_ARN');
    const secret = secretValue(await secrets.get(secretArn), ['secret', 'hmac_secret']);
    if (!verifyTeamsSignature(body, header(event.headers, 'authorization'), secret)) {
      return response(401, { error: { code: 'invalid_signature', message: 'invalid Teams signature' } });
    }
    const normalized = normalizeTeamsWebhook(parseJson(body));
    if (!normalized) return response(400, { error: { code: 'invalid_activity', message: 'unsupported Teams activity' } });
    const traceId = normalized.request.source?.kind === 'teams'
      ? normalized.request.source.activityId
      : undefined;
    const run = await getRunService().submit(normalized.ownerId, normalized.request, {
      idempotencyKey: normalized.idempotencyKey,
      ...(traceId ? { traceId } : {}),
    });
    // Teams outgoing webhooks require a synchronous response within five seconds. Completion is
    // delivered asynchronously by the notifier through a configured Teams Workflow URL.
    return response(200, { type: 'message', text: `Queued agent run ${run.runId}.` });
  } catch (error) {
    return errorResponse(error);
  }
};

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}
