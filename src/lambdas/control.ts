import type { APIGatewayProxyEventV2, APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createAwsClients } from '../adapters/aws-runtime.js';
import { requiredEnv } from '../adapters/executors.js';
import { ConflictError } from '../core/run-service.js';
import type { ArtifactReference, RunRecord } from '../domain/contracts.js';
import { errorResponse, getRunService, header, jsonBody, principal, response } from './runtime.js';

const artifactClient = createAwsClients().s3;

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const method = event.requestContext.http.method;
    const path = event.rawPath;
    if (method === 'GET' && path === '/health') {
      return response(200, { status: 'ok', service: 'indubitably-agent-runtime' });
    }

    const ownerId = principal(event);
    const service = getRunService(true);
    if (method === 'POST' && path === '/v1/runs') {
      const body = jsonBody(event);
      const trustedBody = apiRequestBody(body);
      const idempotencyKey = header(event.headers, 'idempotency-key');
      const run = await service.submit(ownerId, trustedBody, {
        ...(idempotencyKey ? { idempotencyKey } : {}),
        traceId: event.requestContext.requestId,
      });
      return response(202, publicRun(run), { location: `/v1/runs/${run.runId}` });
    }
    if (method === 'GET' && path === '/v1/runs') {
      const limit = parseLimit(event.queryStringParameters?.limit);
      const result = await service.list(ownerId, limit, event.queryStringParameters?.nextToken);
      return response(200, { ...result, items: result.items.map(publicRun) });
    }
    const runId = pathParameter(event, 'runId');
    if (method === 'GET' && runId && path === `/v1/runs/${runId}`) {
      return response(200, publicRun(await service.get(ownerId, runId)));
    }
    const artifactName = pathParameter(event, 'artifact');
    if (method === 'GET' && runId && artifactName && path === `/v1/runs/${runId}/artifacts/${artifactName}`) {
      const run = await service.get(ownerId, runId);
      const artifact = artifactFor(run, artifactName);
      if (!artifact) throw new ConflictError(`artifact ${artifactName} is not available`);
      if (artifact.bucket !== requiredEnv('ARTIFACT_BUCKET')) {
        throw new Error('run contains an artifact outside the runtime bucket');
      }
      const expiresIn = Math.max(60, Math.min(900, Number(process.env.ARTIFACT_URL_TTL_SECONDS ?? 300)));
      const url = await getSignedUrl(
        artifactClient,
        new GetObjectCommand({ Bucket: artifact.bucket, Key: artifact.key }),
        { expiresIn },
      );
      return response(200, {
        name: artifactName,
        url,
        sha256: artifact.sha256,
        expiresAt: new Date(Date.now() + expiresIn * 1_000).toISOString(),
      });
    }
    if (method === 'POST' && runId && path === `/v1/runs/${runId}/cancel`) {
      return response(202, publicRun(await service.cancel(ownerId, runId)));
    }
    return response(404, { error: { code: 'not_found', message: 'route not found' } });
  } catch (error) {
    return errorResponse(error);
  }
};

export function apiRequestBody(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  return {
    ...(body as Record<string, unknown>),
    // API Gateway request IDs are per-attempt transport metadata. They remain
    // in the queue trace, not the canonical request used for idempotency.
    source: { kind: 'api' },
  };
}

function pathParameter(event: APIGatewayProxyEventV2, name: string): string | undefined {
  const value = event.pathParameters?.[name];
  return value && /^[A-Za-z0-9-]{1,128}$/.test(value) ? value : undefined;
}

function parseLimit(value: string | undefined): number {
  if (!value) return 25;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 25;
}

function publicRun(run: RunRecord): RunRecord {
  return run;
}

function artifactFor(run: RunRecord, name: string): ArtifactReference | undefined {
  if (name === 'input') return run.input;
  if (name === 'output') return run.result?.output;
  if (name === 'events') return run.result?.events;
  if (name === 'patch') return run.result?.workspacePatch;
  return undefined;
}
