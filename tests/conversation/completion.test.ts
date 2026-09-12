import { describe, expect, it } from 'vitest';
import { completionDecision, sessionForRun } from '../../src/conversation/completion.js';
import { conversation, freeze, run, timestamp, toolCall } from './fixtures.js';

describe('conversation completion decisions', () => {
  it.each(['succeeded', 'cancelled'] as const)('completes a %s Run with saved output and settled tools', (status) => {
    const record = freeze(run({ status, agentToolCalls: [toolCall({ status: 'succeeded' })] }));
    expect(completionDecision(record)).toEqual({ kind: 'complete', runStatus: status, result: record.result });
  });

  it.each(['succeeded', 'cancelled', 'failed'] as const)('treats interrupted tools as an unknown outcome even when a %s Run saved output', (status) => {
    const call = toolCall();
    const record = freeze(run({ status, agentToolCalls: [toolCall({ status: 'succeeded', requestId: 'settled-call' }), call] }));
    expect(completionDecision(record)).toMatchObject({
      kind: 'fail', runStatus: status === 'cancelled' ? 'cancelled' : 'failed', interrupted: [call],
    });
    expect(record.agentToolCalls).toHaveLength(2);
  });

  it('retains supplied errors, and distinguishes cancellation without output from successful completion', () => {
    const error = { code: 'execution_lost', message: '', retryable: false };
    expect(completionDecision(run({ status: 'failed', error }))).toMatchObject({ kind: 'fail', error });
    const { result: _result, ...cancelled } = run({ status: 'cancelled' });
    expect(completionDecision(cancelled)).toEqual({
      kind: 'fail', runStatus: 'cancelled', interrupted: [],
      error: { code: 'agent_cancelled', message: 'conversation slice cancelled', retryable: false },
    });
  });

  it('retains an existing session expiry and derives a replacement expiry from execution start', () => {
    const record = freeze(run());
    const existing = freeze(conversation());
    const now = new Date('2026-08-03T12:10:00.000Z');
    expect(sessionForRun(record, existing, now, 'thread-2')).toEqual({
      backend: 'microvm', id: 'microvm-1', state: 'suspended', updatedAt: now.toISOString(),
      expiresAt: '2026-08-03T20:00:00.000Z', agentThreadId: 'thread-2',
    });
    expect(sessionForRun({ ...record, execution: { backend: 'microvm', id: 'microvm-2', startedAt: timestamp } }, existing, now))
      .toMatchObject({ id: 'microvm-2', expiresAt: '2026-08-03T20:00:00.000Z' });
    expect(sessionForRun({ ...record, execution: { backend: 'microvm', id: 'microvm-2' } }, existing, now).expiresAt)
      .toBe('2026-08-03T20:10:00.000Z');
  });
});
