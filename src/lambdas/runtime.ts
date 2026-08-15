import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import {
  ConversationConflictError,
  ConversationLeaseError,
  ConversationStateError,
} from '../conversation/types.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../core/run-service.js';
import { PublicationError } from '../domain/publications.js';
import { ValidationError } from '../domain/validation.js';
export { getRunService } from '../app/composition.js';

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
    error instanceof ConversationConflictError ||
    error instanceof ConversationLeaseError ||
    error instanceof ConversationStateError ||
    error instanceof PublicationError ||
    error instanceof NotFoundError ||
    error instanceof ForbiddenError;
  const statusCode =
    error instanceof ValidationError
      ? 400
      : error instanceof PublicationError
        ? error.code === 'not_found'
          ? 404
          : error.code === 'storage'
            ? 500
            : 400
      : error instanceof ConflictError
        ? 409
        : error instanceof ConversationConflictError || error instanceof ConversationLeaseError
          ? 409
          : error instanceof ConversationStateError
            ? 400
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

function stringClaim(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function errorCode(error: unknown): string {
  if (error instanceof ValidationError) return 'invalid_request';
  if (error instanceof PublicationError) return error.code;
  if (error instanceof ConflictError) return 'conflict';
  if (error instanceof ConversationConflictError || error instanceof ConversationLeaseError) {
    return 'conflict';
  }
  if (error instanceof ConversationStateError) return 'invalid_request';
  if (error instanceof NotFoundError) return 'not_found';
  if (error instanceof ForbiddenError) return 'forbidden';
  return 'internal_error';
}

function safeError(error: unknown): Record<string, string> {
  return error instanceof Error
    ? { name: error.name, message: error.message.slice(0, 1_000) }
    : { name: 'Error', message: String(error).slice(0, 1_000) };
}
