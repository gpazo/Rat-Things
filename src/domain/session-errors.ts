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
  usageLimitExceeded: 'usage_limit_exceeded', creditBalanceExhausted: 'credit_balance_exhausted',
  rateLimitExceeded: 'rate_limit_exceeded', serverOverloaded: 'server_overloaded',
  requestTimeout: 'request_timeout',
  cyberPolicy: 'cyber_policy', misalignmentPolicyViolation: 'cyber_policy',
  internalServerError: 'server_error', unauthorized: 'authentication_error', badRequest: 'invalid_request',
  sandboxError: 'sandbox_error', executorVersionIncompatible: 'executor_version_incompatible',
  activeTurnNotSteerable: 'active_turn_not_steerable',
};

/** Preserve typed failures without exposing provider bodies, headers or host diagnostics. */
export function sessionTurnError(value: unknown, previous?: TurnError | null): TurnError {
  const error = record(value) ? value : {};
  const info = error.codexErrorInfo;
  const variant = typeof info === 'string' ? info : record(info) ? Object.keys(info)[0] : undefined;
  const details = record(info) && variant && record(info[variant]) ? info[variant] : undefined;
  const status = details?.httpStatusCode;
  const publicCode = typeof error.code === 'string' && Object.hasOwn(messages, error.code) ? error.code as TurnError['code'] : undefined;
  const nativeCode = variant && Object.hasOwn(nativeCodes, variant) ? nativeCodes[variant] : undefined;
  const transportCode = variant && ['httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected', 'responseTooManyFailedAttempts'].includes(variant)
    ? status === 401 || status === 403 ? 'authentication_error' : status === 404 ? 'resource_not_found'
      : status === 408 || status === 504 ? 'request_timeout' : status === 429 ? 'rate_limit_exceeded'
      : status === 503 ? 'server_overloaded' : typeof status === 'number' && status >= 500 ? 'server_error'
      : typeof status === 'number' && status >= 400 ? 'invalid_request' : 'connection_failed'
    : undefined;
  const code = publicCode ?? nativeCode ?? transportCode;
  return code ? { code, message: messages[code] } : previous ?? { code: 'internal_error', message: messages.internal_error };
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
