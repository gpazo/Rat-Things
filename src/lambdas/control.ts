import type { APIGatewayProxyEventV2, APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createAwsClients } from '../adapters/aws-runtime.js';
import { requiredEnv } from '../adapters/executors.js';
import { apiConversationId } from '../app/conversation-submission.js';
import {
  getConversationService,
  getConversationSubmissionService,
} from '../app/composition.js';
import { ConflictError, NotFoundError } from '../core/run-service.js';
import type { AgentInput, ArtifactReference, RunRecord } from '../domain/contracts.js';
import type { ConversationRecord } from '../domain/conversations.js';
import { isRecord, parseRunRequest, ValidationError } from '../domain/validation.js';
import { apiIngressContext } from '../identity/context.js';
import { errorResponse, getRunService, header, jsonBody, principal, response } from './runtime.js';

const artifactClient = createAwsClients().s3;

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const method = event.requestContext.http.method;
    const path = event.rawPath;
    if (method === 'GET' && path === '/health') {
      return response(200, { status: 'ok', service: 'indubitably-agent-runtime' });
    }

    const context = apiIngressContext(principal(event));
    const ownerId = context.owner.id;
    const service = getRunService(true);
    const conversationKey = conversationPathParameter(event, 'conversationId');
    const messageId = conversationPathParameter(event, 'messageId', 200);
    if (
      method === 'POST' &&
      conversationKey &&
      routeMatches(
        event,
        'POST /v1/conversations/{conversationId}/messages',
        `/v1/conversations/${conversationKey}/messages`,
      )
    ) {
      const request = apiConversationRequestBody(jsonBody(event));
      const idempotencyKey = requiredIdempotencyKey(header(event.headers, 'idempotency-key'));
      const receipt = await getConversationSubmissionService().submitApi({
        conversationKey,
        messageId: idempotencyKey,
        prompt: request.prompt,
        context,
        traceId: event.requestContext.requestId,
        executionPolicy: {
          ...request.agent,
          sandbox: request.agent?.sandbox ?? 'read-only',
        },
      });
      return response(receipt.status === 'appended' ? 202 : 200, receipt, {
        location: `/v1/conversations/${conversationKey}/messages/${receipt.messageId}`,
      });
    }
    if (
      method === 'GET' &&
      conversationKey &&
      messageId &&
      routeMatches(
        event,
        'GET /v1/conversations/{conversationId}/messages/{messageId}',
        `/v1/conversations/${conversationKey}/messages/${messageId}`,
      )
    ) {
      return response(200, await conversationMessageStatus(
        ownerId,
        conversationKey,
        messageId,
      ));
    }
    if (method === 'POST' && path === '/v1/runs') {
      const body = jsonBody(event);
      const trustedBody = apiRequestBody(body, context.source);
      const idempotencyKey = header(event.headers, 'idempotency-key');
      const run = await service.submit(ownerId, trustedBody, {
        ...(idempotencyKey ? { idempotencyKey } : {}),
        traceId: event.requestContext.requestId,
        provenance: {
          actor: context.actor,
          credentialSubject: context.credentialSubject,
        },
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

export function apiRequestBody(body: unknown, source: { kind: 'api' } = { kind: 'api' }): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  return {
    ...(body as Record<string, unknown>),
    // API Gateway request IDs are per-attempt transport metadata. They remain
    // in the queue trace, not the canonical request used for idempotency.
    source,
  };
}

export interface ApiConversationMessageRequest {
  version: '1';
  prompt: string;
  agent?: Pick<AgentInput, 'driver' | 'model' | 'sandbox' | 'reasoningEffort'>;
}

export interface ApiConversationMessageStatus {
  conversationId: string;
  messageId: string;
  state: 'pending' | 'consumed' | 'dead_letter';
  delivery: 'interrupt' | 'defer';
  createdAt: string;
  consumedAt?: string;
  conversation: Pick<
    ConversationRecord,
    'status' | 'pendingCount' | 'createdAt' | 'updatedAt' | 'latestProgress' | 'session'
  >;
  run?: RunRecord;
}

export function apiConversationRequestBody(body: unknown): ApiConversationMessageRequest {
  if (!isRecord(body)) throw new ValidationError('request must be an object');
  const unknown = Object.keys(body).filter((key) => !['version', 'prompt', 'agent'].includes(key));
  if (unknown.length > 0) throw new ValidationError(`request contains unknown field ${unknown[0]}`);
  const parsed = parseRunRequest(body, {
    allowedSandboxModes: (process.env.ALLOWED_SANDBOX_MODES ?? 'read-only,workspace-write')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean) as NonNullable<AgentInput['sandbox']>[],
  });
  if (parsed.agent?.outputSchema) {
    throw new ValidationError('agent.outputSchema is not supported for durable conversations');
  }
  return {
    version: '1',
    prompt: parsed.prompt,
    ...(parsed.agent ? { agent: parsed.agent } : {}),
  };
}

async function conversationMessageStatus(
  ownerId: string,
  conversationKey: string,
  messageId: string,
): Promise<ApiConversationMessageStatus> {
  const runtimeConversationId = apiConversationId(ownerId, conversationKey);
  const conversations = getConversationService();
  const [conversation, message] = await Promise.all([
    conversations.get(runtimeConversationId),
    conversations.getMessage(runtimeConversationId, messageId),
  ]);
  if (!conversation || conversation.ownerId !== ownerId || !message) {
    throw new NotFoundError('conversation message not found');
  }
  const run = message.runId
    ? await getRunService(true).get(ownerId, message.runId)
    : undefined;
  return {
    conversationId: conversationKey,
    messageId,
    state: message.state,
    delivery: message.delivery,
    createdAt: message.createdAt,
    ...(message.consumedAt ? { consumedAt: message.consumedAt } : {}),
    conversation: {
      status: conversation.status,
      pendingCount: conversation.pendingCount,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      ...(conversation.latestProgress ? { latestProgress: conversation.latestProgress } : {}),
      ...(conversation.session ? { session: conversation.session } : {}),
    },
    ...(run ? { run } : {}),
  };
}

function pathParameter(event: APIGatewayProxyEventV2, name: string): string | undefined {
  const value = event.pathParameters?.[name];
  return value && /^[A-Za-z0-9-]{1,128}$/.test(value) ? value : undefined;
}

function conversationPathParameter(
  event: APIGatewayProxyEventV2,
  name: string,
  maximum = 128,
): string | undefined {
  const value = event.pathParameters?.[name];
  return value && value.length <= maximum && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
    ? value
    : undefined;
}

function routeMatches(
  event: APIGatewayProxyEventV2,
  routeKey: string,
  decodedPath: string,
): boolean {
  return event.routeKey === routeKey || decodeURIComponent(event.rawPath) === decodedPath;
}

function requiredIdempotencyKey(value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9._:-]{1,200}$/.test(value)) {
    throw new ValidationError('Idempotency-Key must be 1-200 safe ASCII characters');
  }
  return value;
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
