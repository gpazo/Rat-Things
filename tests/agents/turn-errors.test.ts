import { expect, it } from 'vitest';
import { sessionTurnError } from '../../src/domain/session-errors.js';
import { bindSessionTurn, initialSessionRuntime, reduceSessionRuntime } from '../../src/core/session-runtime-planning.js';

it.each([
  ['contextWindowExceeded', 'context_length_exceeded'], ['sessionBudgetExceeded', 'session_budget_exceeded'],
  ['usageLimitExceeded', 'usage_limit_exceeded'], ['creditBalanceExhausted', 'credit_balance_exhausted'],
  ['rateLimitExceeded', 'rate_limit_exceeded'], ['serverOverloaded', 'server_overloaded'], ['cyberPolicy', 'cyber_policy'],
  ['misalignmentPolicyViolation', 'cyber_policy'], ['internalServerError', 'server_error'], ['unauthorized', 'authentication_error'],
  ['badRequest', 'invalid_request'], ['sandboxError', 'sandbox_error'], ['requestTimeout', 'request_timeout'],
  ['executorVersionIncompatible', 'executor_version_incompatible'], ['unknown', 'internal_error'],
])('projects typed native %s as %s without its private diagnostics', (native, expected) => {
  const result = sessionTurnError({ codexErrorInfo: native, message: 'PRIVATE', additionalDetails: 'PRIVATE' });
  expect(result.code).toBe(expected);
  expect(JSON.stringify(result)).not.toContain('PRIVATE');
});

it.each([[401, 'authentication_error'], [403, 'authentication_error'], [404, 'resource_not_found'], [408, 'request_timeout'],
  [429, 'rate_limit_exceeded'], [500, 'server_error'], [503, 'server_overloaded'], [504, 'request_timeout'], [422, 'invalid_request'], [null, 'connection_failed']])('maps typed HTTP status %s to %s', (status, expected) => {
  expect(sessionTurnError({ codexErrorInfo: { responseStreamConnectionFailed: { httpStatusCode: status } }, message: 'PRIVATE' }).code).toBe(expected);
});

it('ignores retry notifications and retains a specific failure through a sparse terminal notification', () => {
  const state = bindSessionTurn(initialSessionRuntime('session', 'agent', 'root'), 'native', { id: 'turn', object: 'agent.session.turn', session_id: 'session', agent_id: 'agent', subagent_id: null,
    status: 'in_progress', created_at: 1, started_at: 1, completed_at: null, error: null, usage: null });
  const event = { method: 'error', observedAt: 2, params: { threadId: 'root', turnId: 'native', error: { codexErrorInfo: 'creditBalanceExhausted', message: 'PRIVATE' } } };
  expect(reduceSessionRuntime(state, { ...event, params: { ...event.params, willRetry: true } })).toEqual(state);
  const failed = reduceSessionRuntime(state, event);
  const completed = reduceSessionRuntime(failed, { method: 'turn/completed', observedAt: 3, params: { threadId: 'root', turn: { id: 'native', status: 'failed', error: null } } });
  expect(completed.turns[0]?.turn.error?.code).toBe('credit_balance_exhausted');
  expect(JSON.stringify(completed)).not.toContain('PRIVATE');
});
