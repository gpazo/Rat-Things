import { describe, expect, it } from 'vitest';
import { recoveryWakeForQueuedRun } from '../../src/core/run-recovery.js';
import type { RunRecord } from '../../src/domain/contracts.js';

describe('queued Run recovery routing', () => {
  it('wakes the thread coordinator until trusted execution input is attached', () => {
    expect(recoveryWakeForQueuedRun(run({
      conversation: { conversationId: 'thread-owner-main', messageId: 'message-1' },
    }), 42)).toEqual({
      kind: 'thread',
      message: {
        version: '1',
        conversationId: 'thread-owner-main',
        traceId: 'reconcile:run-1:42',
        runId: 'run-1',
        ownerId: 'owner-1',
      },
    });
  });

  it('wakes execution for one-shot and fully prepared threaded Runs', () => {
    expect(recoveryWakeForQueuedRun(run(), 42).kind).toBe('run');
    expect(recoveryWakeForQueuedRun(run({
      conversation: {
        conversationId: 'thread-owner-main',
        messageId: 'message-1',
        turnId: 'turn-1',
        slice: 0,
      },
      executionInput: { bucket: 'artifacts', key: 'execution.json', sha256: 'b'.repeat(64) },
    }), 42).kind).toBe('run');
  });
});

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: 'run-1',
    ownerId: 'owner-1',
    ownerCreated: 'owner-1#2026-08-23T00:00:00.000Z#run-1',
    status: 'queued',
    createdAt: '2026-08-23T00:00:00.000Z',
    updatedAt: '2026-08-23T00:00:00.000Z',
    expiresAt: 1,
    requestHash: 'a'.repeat(64),
    input: { bucket: 'artifacts', key: 'input.json', sha256: 'a'.repeat(64) },
    sourceKind: 'api',
    ...overrides,
  };
}
