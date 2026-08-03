import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { DynamoRunStore, S3ArtifactStore, SqsRunQueue, createAwsClients } from '../adapters/aws-runtime.js';
import { createExecutorRegistryFromEnv, requiredEnv } from '../adapters/executors.js';
import { ConflictError, ForbiddenError, NotFoundError, RunService } from '../core/run-service.js';
import type { ExecutionController } from '../core/ports.js';
import type { SandboxMode } from '../domain/contracts.js';
import { ValidationError } from '../domain/validation.js';

let submissionService: RunService | undefined;
let controlService: RunService | undefined;

const noExecutions: ExecutionController = {
  stop: async () => {
    throw new Error('execution control is not available in this Lambda');
  },
};

export function getRunService(enableExecutionControl = false): RunService {
  if (enableExecutionControl && controlService) return controlService;
  if (!enableExecutionControl && submissionService) return submissionService;
  const clients = createAwsClients();
  const service = new RunService({
    store: new DynamoRunStore(clients.dynamodb, requiredEnv('RUNS_TABLE_NAME')),
    artifacts: new S3ArtifactStore(clients.s3, requiredEnv('ARTIFACT_BUCKET')),
    queue: new SqsRunQueue(clients.sqs, requiredEnv('RUN_QUEUE_URL')),
    executions: enableExecutionControl ? createExecutorRegistryFromEnv() : noExecutions,
    allowedRepositoryHosts: csv(process.env.ALLOWED_REPOSITORY_HOSTS ?? 'github.com,gitlab.com'),
    allowedSandboxModes: sandboxModes(process.env.ALLOWED_SANDBOX_MODES ?? 'read-only,workspace-write'),
    retentionSeconds: Number(process.env.RUN_RETENTION_SECONDS ?? 2_592_000),
  });
  if (enableExecutionControl) controlService = service;
  else submissionService = service;
  return service;
}

export function rawBody(event: APIGatewayProxyEventV2): string {
  const body = event.body ?? '';
  return event.isBase64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
}

export function jsonBody(event: APIGatewayProxyEventV2): unknown {
  const body = rawBody(event);
  if (!body) throw new ValidationError('request body is required');
  return parseJson(body);
}

export function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new ValidationError('request body must be valid JSON');
  }
}

export function principal(event: APIGatewayProxyEventV2): string {
  const authorizer = (event.requestContext as {
    authorizer?: {
      iam?: { userArn?: string; callerId?: string };
      jwt?: { claims?: Record<string, unknown> };
    };
  }).authorizer;
  const iam = authorizer?.iam;
  const jwt = authorizer?.jwt?.claims;
  const value = iam?.userArn ?? iam?.callerId ?? stringClaim(jwt?.sub);
  if (value) return `api:${value}`;
  if (process.env.ALLOW_OWNER_HEADER === 'true') {
    const local = header(event.headers, 'x-runtime-owner');
    if (local) return `local:${local}`;
  }
  throw new ForbiddenError('request has no authenticated principal');
}

export function response(
  statusCode: number,
  value: unknown,
  extraHeaders: Record<string, string> = {},
): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      'x-content-type-options': 'nosniff',
      ...extraHeaders,
    },
    body: JSON.stringify(value),
  };
}

export function errorResponse(error: unknown): APIGatewayProxyStructuredResultV2 {
  const requestError =
    error instanceof ValidationError ||
    error instanceof ConflictError ||
    error instanceof NotFoundError ||
    error instanceof ForbiddenError;
  const statusCode =
    error instanceof ValidationError
      ? 400
      : error instanceof ConflictError
        ? 409
        : error instanceof NotFoundError
          ? 404
          : error instanceof ForbiddenError
            ? 403
            : 500;
  const message = requestError && error instanceof Error ? error.message : 'internal server error';
  if (!requestError) {
    console.error(JSON.stringify({ level: 'error', message: 'request failed', error: safeError(error) }));
  }
  return response(statusCode, { error: { code: errorCode(error), message } });
}

export function header(headers: Record<string, string | undefined>, name: string): string | undefined {
  const target = name.toLowerCase();
  return Object.entries(headers).find(([key]) => key.toLowerCase() === target)?.[1];
}

export function secretValue(raw: string, keys: string[]): string {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const key of keys) {
        const value = (parsed as Record<string, unknown>)[key];
        if (typeof value === 'string' && value) return value;
      }
    }
  } catch {
    // Raw secret strings are valid.
  }
  return raw;
}

function csv(value: string): string[] {
  return value.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
}

function sandboxModes(value: string): SandboxMode[] {
  const modes = csv(value);
  if (modes.length === 0 || modes.some((mode) => !['read-only', 'workspace-write', 'danger-full-access'].includes(mode))) {
    throw new Error('ALLOWED_SANDBOX_MODES contains an invalid value');
  }
  return modes as SandboxMode[];
}

function stringClaim(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function errorCode(error: unknown): string {
  if (error instanceof ValidationError) return 'invalid_request';
  if (error instanceof ConflictError) return 'conflict';
  if (error instanceof NotFoundError) return 'not_found';
  if (error instanceof ForbiddenError) return 'forbidden';
  return 'internal_error';
}

function safeError(error: unknown): Record<string, string> {
  return error instanceof Error
    ? { name: error.name, message: error.message.slice(0, 1_000) }
    : { name: 'Error', message: String(error).slice(0, 1_000) };
}
