import { createHash } from 'node:crypto';
import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { createAwsClients, CachedSecretReader } from '../adapters/aws-runtime.js';
import { normalizeGitLabWebhook } from '../channels/normalize.js';
import { verifyGitLabStandardSignature, verifyGitLabToken } from '../channels/signatures.js';
import { errorResponse, getRunService, header, parseJson, rawBody, response, secretValue } from './runtime.js';

const secrets = new CachedSecretReader(createAwsClients().secrets);

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const body = rawBody(event);
    const secretArn = required('GITLAB_WEBHOOK_SECRET_ARN');
    const secret = secretValue(await secrets.get(secretArn), ['signing_token', 'token', 'secret', 'webhook_secret']);
    const standardSignature = header(event.headers, 'webhook-signature');
    const authenticated = standardSignature
      ? verifyGitLabStandardSignature(
          body,
          header(event.headers, 'webhook-id'),
          header(event.headers, 'webhook-timestamp'),
          standardSignature,
          secret,
        )
      : verifyGitLabToken(header(event.headers, 'x-gitlab-token'), secret);
    if (!authenticated) {
      return response(401, { error: { code: 'invalid_signature', message: 'invalid GitLab webhook authentication' } });
    }
    const eventName = header(event.headers, 'x-gitlab-event');
    if (!eventName) {
      return response(400, { error: { code: 'missing_headers', message: 'missing GitLab event header' } });
    }
    const deliveryId =
      header(event.headers, 'webhook-id') ??
      header(event.headers, 'idempotency-key') ??
      header(event.headers, 'x-gitlab-webhook-uuid') ??
      header(event.headers, 'x-request-id') ??
      createHash('sha256').update(body).digest('hex');
    const normalized = normalizeGitLabWebhook(
      eventName,
      deliveryId,
      parseJson(body),
      process.env.GITLAB_CLONE_TOKEN_SECRET_ARN ?? process.env.GITLAB_TOKEN_SECRET_ARN,
      process.env.GITLAB_COMMENT_TRIGGER ?? '@indubitably',
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
