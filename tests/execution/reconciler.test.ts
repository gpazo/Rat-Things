import { describe, expect, it, vi } from 'vitest';
import type {
  ExecutionLivenessObservation,
  ExecutionReference,
  RunError,
  RunRecord,
} from '../../src/domain/contracts.js';
import {
  ActiveRunReconciler,
  type ExecutionInspection,
} from '../../src/execution/reconciler.js';

const execution: ExecutionReference = {
  backend: 'microvm',
  id: 'microvm-1',
  generation: 'a'.repeat(64),
};

function run(status: RunRecord['status'] = 'running'): RunRecord {
  return {
    runId: 'run-1',
    ownerId: 'owner-1',
    ownerCreated: 'owner-1#2026-08-24T20:00:00.000Z#run-1',
    status,
    createdAt: '2026-08-24T20:00:00.000Z',
    updatedAt: '2026-08-24T20:00:01.000Z',
    heartbeatAt: '2026-08-24T20:00:02.000Z',
    expiresAt: 2_000_000_000,
    requestHash: 'b'.repeat(64),
    input: { bucket: 'artifacts', key: 'input.json', sha256: 'c'.repeat(64) },
    sourceKind: 'api',
    execution,
  };
}

function fixture(inspection: ExecutionInspection) {
  let observation: ExecutionLivenessObservation | undefined;
  let failed: RunError | undefined;
  const store = {
    failExecution: vi.fn(async (
      _runId: string,
      _execution: ExecutionReference,
      _heartbeatAt: string,
      error: RunError,
    ) => {
      failed = error;
      return true;
    }),
    cancelExecution: vi.fn().mockResolvedValue(true),
    recordLivenessInspection: vi.fn(async (
      _runId: string,
      _execution: ExecutionReference,
      _heartbeatAt: string,
      value: ExecutionLivenessObservation,
    ) => {
      observation = value;
      return true;
    }),
  };
  const inspector = { inspect: vi.fn().mockResolvedValue(inspection) };
  const executions = { stop: vi.fn().mockResolvedValue(undefined) };
  return {
    reconciler: new ActiveRunReconciler({
      store,
      inspector,
      executions,
      now: () => new Date('2026-08-24T20:05:00.000Z'),
      quarantineAfter: 3,
    }),
    store,
    inspector,
    executions,
    observation: () => observation,
    failed: () => failed,
  };
}

describe('active Run reconciliation', () => {
  it('retains a stale heartbeat when the exact root-supervised worker is active', async () => {
    const test = fixture({ kind: 'active' });
    await expect(test.reconciler.reconcile(run())).resolves.toBe('active');
    expect(test.store.failExecution).not.toHaveBeenCalled();
    expect(test.observation()).toEqual({
      checkedAt: '2026-08-24T20:05:00.000Z',
      outcome: 'active',
      consecutiveUncertain: 0,
    });
  });

  it('fails a dead attachment with a retryable infrastructure error and never restarts it', async () => {
    const test = fixture({ kind: 'terminal', reason: 'the attached MicroVM is terminated' });
    await expect(test.reconciler.reconcile(run())).resolves.toBe('failed');
    expect(test.failed()).toEqual({
      code: 'execution_lost',
      message: 'the attached MicroVM is terminated',
      retryable: true,
    });
    expect(test.executions.stop).not.toHaveBeenCalled();
  });

  it('does not mutate a successor when the observed heartbeat raced', async () => {
    const test = fixture({ kind: 'terminal', reason: 'terminated' });
    test.store.failExecution.mockResolvedValueOnce(false);
    await expect(test.reconciler.reconcile(run())).resolves.toBe('raced');
  });

  it('quarantines repeated identity conflicts without failing or terminating either identity', async () => {
    const third = run();
    third.liveness = {
      checkedAt: '2026-08-24T20:04:00.000Z',
      outcome: 'conflict',
      consecutiveUncertain: 2,
      reason: 'identity mismatch',
    };
    const test = fixture({ kind: 'conflict', reason: 'identity mismatch' });
    await expect(test.reconciler.reconcile(third)).resolves.toBe('quarantined');
    expect(test.observation()).toMatchObject({
      outcome: 'conflict',
      consecutiveUncertain: 3,
      quarantinedAt: '2026-08-24T20:05:00.000Z',
    });
    expect(test.store.failExecution).not.toHaveBeenCalled();
    expect(test.executions.stop).not.toHaveBeenCalled();
  });

  it('terminates only an exactly verified active cancellation and finalizes it once terminal', async () => {
    const active = fixture({ kind: 'active' });
    await expect(active.reconciler.reconcile(run('cancelling'))).resolves.toBe('stop-requested');
    expect(active.executions.stop).toHaveBeenCalledWith(
      execution,
      'reconciler finalized a stale cancellation',
    );

    const terminal = fixture({ kind: 'absent', reason: 'not found' });
    await expect(terminal.reconciler.reconcile(run('cancelling'))).resolves.toBe('cancelled');
    expect(terminal.store.cancelExecution).toHaveBeenCalledWith('run-1', execution);
  });

  it('leaves pre-fencing attachments untouched for explicit migration or operator repair', async () => {
    const legacy = run();
    legacy.execution = { backend: 'microvm', id: 'microvm-legacy' };
    const test = fixture({ kind: 'terminal', reason: 'terminated' });
    await expect(test.reconciler.reconcile(legacy)).resolves.toBe('legacy');
    expect(test.inspector.inspect).not.toHaveBeenCalled();
  });
});
