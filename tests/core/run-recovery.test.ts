import { describe, expect, it } from 'vitest';
import { recoveryMessageForRun } from '../../src/core/run-recovery.js';
import type { RunRecord } from '../../src/domain/contracts.js';

describe('private execution recovery', () => {
  it('uses supplied time, including zero, and keeps Session wake-ups on the execution queue', () => {
    const current = Object.freeze(run({ agentsSession: { sessionId: 'sess_1', turnId: 'turn_1', launch: run().input } }));
    expect(recoveryMessageForRun(current, 0)).toEqual({ version: '1', runId: 'run-1', traceId: 'reconcile:run-1:0' });
    expect(recoveryMessageForRun(run(), 42)).toEqual({ version: '1', runId: 'run-1', traceId: 'reconcile:run-1:42' });
  });

  it('never requeues retained conversation records, whether prepared or not', () => {
    const retired = { ...run(), conversation: { conversationId: 'old' } };
    expect(recoveryMessageForRun(retired, 42)).toBeUndefined();
    const prepared = { ...retired, executionInput: run().input };
    expect(recoveryMessageForRun(prepared, 42)).toBeUndefined();
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
