import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { createAwsClients, CachedSecretReader } from '../adapters/aws-runtime.js';
import { normalizeSlackEvent } from '../channels/normalize.js';
import { verifySlackSignature } from '../channels/signatures.js';
import { errorResponse, getRunService, header, parseJson, rawBody, response, secretValue } from './runtime.js';

const secrets = new CachedSecretReader(createAwsClients().secrets);

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const body = rawBody(event);
    const secretArn = required('SLACK_SIGNING_SECRET_ARN');
    const secret = secretValue(await secrets.get(secretArn), ['secret', 'signing_secret']);
    if (!verifySlackSignature(
      body,
      header(event.headers, 'x-slack-request-timestamp'),
      header(event.headers, 'x-slack-signature'),
      secret,
    )) {
      return response(401, { error: { code: 'invalid_signature', message: 'invalid Slack signature' } });
    }
    const payload = parseJson(body);
    if (payload && typeof payload === 'object' && !Array.isArray(payload) && (payload as Record<string, unknown>).type === 'url_verification') {
      return response(200, { challenge: (payload as Record<string, unknown>).challenge });
    }
    const normalized = normalizeSlackEvent(payload);
    if (!normalized) return response(202, { accepted: false, ignored: true });
    const run = await getRunService().submit(normalized.ownerId, normalized.request, {
      idempotencyKey: normalized.idempotencyKey,
      traceId: normalized.idempotencyKey,
    });
    return response(202, { accepted: true, runId: run.runId });
  } catch (error) {
    return errorResponse(error);
  }
};

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}
