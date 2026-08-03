import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { createAwsClients, CachedSecretReader } from '../adapters/aws-runtime.js';
import { normalizeGitHubWebhook } from '../channels/normalize.js';
import { verifyGitHubSignature } from '../channels/signatures.js';
import { errorResponse, getRunService, header, parseJson, rawBody, response, secretValue } from './runtime.js';

const secrets = new CachedSecretReader(createAwsClients().secrets);

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const body = rawBody(event);
    const secretArn = required('GITHUB_WEBHOOK_SECRET_ARN');
    const secret = secretValue(await secrets.get(secretArn), ['secret', 'webhook_secret']);
    if (!verifyGitHubSignature(body, header(event.headers, 'x-hub-signature-256'), secret)) {
      return response(401, { error: { code: 'invalid_signature', message: 'invalid GitHub signature' } });
    }
    const eventName = header(event.headers, 'x-github-event');
    const deliveryId = header(event.headers, 'x-github-delivery');
    if (!eventName || !deliveryId) {
      return response(400, { error: { code: 'missing_headers', message: 'missing GitHub event headers' } });
    }
    const normalized = normalizeGitHubWebhook(
      eventName,
      deliveryId,
      parseJson(body),
      process.env.GITHUB_CLONE_TOKEN_SECRET_ARN ?? process.env.GITHUB_TOKEN_SECRET_ARN,
      process.env.GITHUB_COMMENT_TRIGGER ?? '@indubitably',
    );
    if (!normalized) return response(202, { accepted: false, ignored: true });
    const run = await getRunService().submit(normalized.ownerId, normalized.request, {
      idempotencyKey: normalized.idempotencyKey,
      traceId: deliveryId,
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
