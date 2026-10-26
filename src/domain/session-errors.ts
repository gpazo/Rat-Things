import type { Turn } from './agents-api.js';

type TurnError = NonNullable<Turn['error']>;
const messages: Record<TurnError['code'], string> = {
  context_length_exceeded: 'The request exceeds the model context window.',
  session_budget_exceeded: 'The Session has reached its usage budget.',
  usage_limit_exceeded: 'The model provider usage limit has been reached.',
  credit_balance_exhausted: 'The model provider has no API credits remaining.',
  rate_limit_exceeded: 'The request exceeds the available model rate limit.',
  server_overloaded: 'The model service is temporarily overloaded.',
  cyber_policy: 'The request was rejected by a safety policy.',
  connection_failed: 'The request could not connect to the model service.',
  server_error: 'The model service encountered an unexpected error.',
  authentication_error: 'The model credentials are invalid or lack access.',
  invalid_request: 'The request contains invalid input or configuration.',
  resource_not_found: 'The requested model or resource is unavailable.',
  sandbox_error: 'The request could not complete in its execution environment.',
  executor_version_incompatible: 'The executor must be upgraded before it can run this Turn.',
  active_turn_not_steerable: 'The active Turn cannot accept additional input.',
  request_timeout: 'The request timed out before the model service responded.',
  internal_error: 'The agent could not complete this turn.',
};
const nativeCodes: Record<string, TurnError['code']> = {
  contextWindowExceeded: 'context_length_exceeded', sessionBudgetExceeded: 'session_budget_exceeded',
  usageLimitExceeded: 'usage_limit_exceeded',
  rateLimitExceeded: 'rate_limit_exceeded', serverOverloaded: 'server_overloaded', flexUnavailable: 'server_overloaded',
  cyberPolicy: 'cyber_policy', misalignmentPolicyViolation: 'cyber_policy',
  internalServerError: 'server_error', unauthorized: 'authentication_error', badRequest: 'invalid_request',
  sandboxError: 'sandbox_error',
  activeTurnNotSteerable: 'active_turn_not_steerable',
};

/** Preserve official typed failures without inferring precision from private diagnostics. */
export function sessionTurnError(value: unknown, previous?: TurnError | null): TurnError {
  const error = record(value) ? value : {};
  const info = error.codexErrorInfo;
  const variant = typeof info === 'string' ? info : record(info) && Object.keys(info).length === 1 ? Object.keys(info)[0] : undefined;
  const details = record(info) && variant && record(info[variant]) ? info[variant] : undefined;
  const status = details?.httpStatusCode;
  const publicCode = typeof error.code === 'string' && Object.hasOwn(messages, error.code) ? error.code as TurnError['code'] : undefined;
  const nativeCode = variant && Object.hasOwn(nativeCodes, variant) ? nativeCodes[variant] : undefined;
  const transportCode = variant && ['httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected', 'responseTooManyFailedAttempts'].includes(variant)
    ? nativeHttpError(status)
    : undefined;
  const code = publicCode ?? nativeCode ?? transportCode ?? previous?.code ?? 'internal_error';
  return { code, message: messages[code] };
}

function nativeHttpError(status: unknown): TurnError['code'] {
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 400 || status > 599) return 'connection_failed';
  if (status === 401 || status === 403) return 'authentication_error';
  // Payment Required cannot distinguish credits, billing setup or another policy.
  if (status === 402) return 'internal_error';
  if (status === 404) return 'resource_not_found';
  if (status === 408 || status === 504) return 'request_timeout';
  if (status === 429) return 'rate_limit_exceeded';
  if (status === 503) return 'server_overloaded';
  return status >= 500 ? 'server_error' : 'invalid_request';
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
