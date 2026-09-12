import { describe, expect, it } from 'vitest';
import { RUN_STATUSES } from '../../src/domain/contracts.js';
import { dispatchAdmission, executorStartFailure } from '../../src/execution/dispatch-planning.js';
import { parseRunQueueMessage } from '../../src/execution/dispatcher.js';
import { execution, freeze, run } from './fixtures.js';

describe('dispatch admission', () => {
  it('admits queued runs and retries of running or dispatching runs without an attached handle', () => {
    expect(dispatchAdmission(undefined)).toEqual({ kind: 'ignore' });
    for (const status of RUN_STATUSES) {
      const eligible = ['queued', 'dispatching', 'running'].includes(status);
      expect(dispatchAdmission(run({ status })).kind).toBe(eligible ? 'dispatch' : 'ignore');
      expect(dispatchAdmission(run({ status, execution: { ...execution, id: 'pending' } })).kind).toBe(eligible ? 'dispatch' : 'ignore');
      expect(dispatchAdmission(run({ status, execution })).kind).toBe(status === 'queued' ? 'dispatch' : 'ignore');
    }
  });

  it('keeps original input for one-shot work and requires prepared input for a conversation', () => {
    const current = freeze(run());
    expect(dispatchAdmission(current)).toEqual({ kind: 'dispatch', run: current, input: current.input });
    const threaded = freeze({ ...current, conversation: { conversationId: 'conversation-1' } });
    expect(dispatchAdmission(threaded)).toEqual({ kind: 'ignore' });
    const prepared = freeze({ ...threaded, executionInput: { ...current.input, key: 'prepared.json' } });
    const admission = dispatchAdmission(prepared);
    expect(admission).toEqual({ kind: 'dispatch', run: prepared, input: prepared.executionInput });
    if (admission.kind !== 'dispatch') throw new Error('expected prepared input');
    expect(admission.run).toBe(prepared);
    expect(admission.input).toBe(prepared.executionInput);
    expect(current).not.toHaveProperty('executionInput');
  });

  it('preserves queue parsing behavior for empty identifiers, extra fields, and malformed input', () => {
    expect(parseRunQueueMessage('{"version":"1","runId":"","traceId":"","extra":false}')).toEqual({
      version: '1', runId: '', traceId: '', extra: false,
    });
    expect(() => parseRunQueueMessage('{')).toThrow(SyntaxError);
    expect(() => parseRunQueueMessage('{"version":"2","runId":"run-1","traceId":"trace-1"}')).toThrow('invalid run queue message');
  });
});

describe('executor start failure classification', () => {
  it.each(['ThrottlingException', 'ServiceUnavailableException', 'TooManyRequestsException'])('retries %s without persisting a terminal error', name => {
    expect(executorStartFailure(Object.assign(new Error('transient'), { name }))).toEqual({ kind: 'retry' });
  });

  it('retries deserialization failures and only the idempotent creation conflict', () => {
    expect(executorStartFailure(new SyntaxError('HTML is not valid JSON. Deserialization error'))).toEqual({ kind: 'retry' });
    expect(executorStartFailure(Object.assign(new Error('Creation in progress for this clientToken'), { name: 'ConflictException' })))
      .toEqual({ kind: 'retry' });
    expect(executorStartFailure(Object.assign(new Error('Creation in progress'), { name: 'ConflictException' })).kind).toBe('fail');
    expect(executorStartFailure(new Error('Creation in progress for this clientToken')).kind).toBe('fail');
    expect(executorStartFailure({ name: 'ThrottlingException', message: 'plain object' }).kind).toBe('fail');
  });

  it('uses SDK HTTP status sources in nullish precedence order without coercion', () => {
    for (const error of [
      { $metadata: { httpStatusCode: 429 } },
      { $response: { statusCode: 503 } },
      { $response: { status: 500 } },
      { $metadata: { httpStatusCode: null }, $response: { statusCode: 502 } },
    ]) expect(executorStartFailure(freeze(error))).toEqual({ kind: 'retry' });
    for (const error of [
      { $metadata: { httpStatusCode: 0 }, $response: { statusCode: 503 } },
      { $metadata: { httpStatusCode: '503' }, $response: { statusCode: 503 } },
      { $response: { statusCode: 400, status: 503 } },
      { $response: { statusCode: '429' } },
    ]) expect(executorStartFailure(freeze(error)).kind).toBe('fail');
  });

  it('bounds classification and stored messages at the original limit without trimming or flattening them', () => {
    const message = ` \n${'x'.repeat(1_100)}`;
    expect(executorStartFailure(new Error(message))).toEqual({
      kind: 'fail', error: { code: 'executor_start_failed', message: message.slice(0, 1_000), retryable: false },
    });
    expect(executorStartFailure(new Error(`${'x'.repeat(1_000)} is not valid JSON. Deserialization error`)).kind).toBe('fail');
    expect(executorStartFailure(new Error(''))).toMatchObject({ error: { message: '' } });
    expect(executorStartFailure(false)).toMatchObject({ error: { message: 'false' } });
    expect(executorStartFailure(0)).toMatchObject({ error: { message: '0' } });
    expect(executorStartFailure(null)).toMatchObject({ error: { message: 'null' } });
  });

  it('preserves conversion counts and conversion failures for non-Error throwables', () => {
    let conversions = 0;
    const error = { toString: () => `conversion-${++conversions}` };
    expect(executorStartFailure(error)).toMatchObject({ error: { message: 'conversion-2' } });
    expect(conversions).toBe(2);
    const failure = new Error('conversion failed');
    expect(() => executorStartFailure({ toString: () => { throw failure; } })).toThrow(failure);
  });
});
