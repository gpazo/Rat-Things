import { describe, expect, it, vi } from 'vitest';
import type {
  ExecutionLivenessObservation,
  ExecutionReference,
  RunError,
  RunRecord,
} from '../../src/domain/contracts.js';
import {
  ActiveRunReconciler,
  type ActiveRunReconcilerOptions,
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

function fixture(inspection: ExecutionInspection, overrides: Partial<ActiveRunReconcilerOptions> = {}) {
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
      ...overrides,
    }),
    store,
    inspector,
    executions,
    observation: () => observation,
    failed: () => failed,
  };
}

describe('active Run reconciliation', () => {
  describe.each(['dispatching', 'running', 'cancelling'] as const)('%s Run', (status) => {
    it.each([
      { kind: 'active', working: 'active', cancelling: 'stop-requested' },
      { kind: 'inactive', working: 'failed', cancelling: 'stop-requested' },
      { kind: 'terminal', working: 'failed', cancelling: 'cancelled' },
      { kind: 'absent', working: 'failed', cancelling: 'cancelled' },
      { kind: 'conflict', working: 'deferred', cancelling: 'deferred' },
      { kind: 'unknown', working: 'deferred', cancelling: 'deferred' },
    ] as const)('preserves recovery behavior for a $kind inspection', async ({ kind, working, cancelling }) => {
      const inspection = kind === 'active' ? { kind } : { kind, reason: kind };
      const test = fixture(inspection);
      const expected = status === 'cancelling' ? cancelling : working;

      await expect(test.reconciler.reconcile(run(status))).resolves.toBe(expected);
      expect(test.inspector.inspect).toHaveBeenCalledWith('run-1', execution);
      expect(test.store.failExecution).toHaveBeenCalledTimes(expected === 'failed' ? 1 : 0);
      expect(test.store.cancelExecution).toHaveBeenCalledTimes(expected === 'cancelled' ? 1 : 0);
      expect(test.executions.stop).toHaveBeenCalledTimes(expected === 'stop-requested' ? 1 : 0);
      expect(test.store.recordLivenessInspection).toHaveBeenCalledTimes(
        expected === 'active' || expected === 'deferred' ? 1 : 0,
      );
      if (expected === 'active' || expected === 'deferred') {
        expect(test.store.recordLivenessInspection).toHaveBeenCalledWith(
          'run-1', execution, run(status).heartbeatAt, expect.objectContaining({ outcome: kind }),
        );
      }
    });
  });

  it.each(['running', 'cancelling'] as const)(
    'resets uncertainty on a changed inspection and fences quarantine for a %s Run',
    async (status) => {
      const current = run(status);
      current.liveness = {
        checkedAt: '2026-08-24T20:04:00.000Z', outcome: 'conflict', consecutiveUncertain: 2,
      };
      const test = fixture({ kind: 'unknown', reason: 'control plane\nunavailable' });
      await expect(test.reconciler.reconcile(current)).resolves.toBe('deferred');
      expect(test.observation()).toEqual({
        checkedAt: '2026-08-24T20:05:00.000Z',
        outcome: 'unknown',
        consecutiveUncertain: 1,
        reason: 'control plane unavailable',
      });

      current.liveness = { ...current.liveness, outcome: 'unknown' };
      test.store.recordLivenessInspection.mockResolvedValueOnce(false);
      await expect(test.reconciler.reconcile(current)).resolves.toBe('raced');
      await expect(test.reconciler.reconcile(current)).resolves.toBe('quarantined');
      expect(test.observation()).toMatchObject({
        consecutiveUncertain: 3, quarantinedAt: '2026-08-24T20:05:00.000Z',
      });
      current.liveness = test.observation()!;
      test.inspector.inspect.mockClear();
      await expect(test.reconciler.reconcile(current)).resolves.toBe('quarantined');
      expect(test.inspector.inspect).not.toHaveBeenCalled();
      expect(test.store.failExecution).not.toHaveBeenCalled();
      expect(test.store.cancelExecution).not.toHaveBeenCalled();
      expect(test.executions.stop).not.toHaveBeenCalled();
    },
  );

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

  it('inspects before reading time, then persists the exact execution and heartbeat evidence', async () => {
    const events: string[] = [];
    const current = run();
    const test = fixture({ kind: 'unknown', reason: 'uncertain' }, {
      now: () => { events.push('clock'); return new Date('2026-08-24T20:05:00.000Z'); },
    });
    test.inspector.inspect.mockImplementation(async () => { events.push('inspect'); return { kind: 'unknown', reason: 'uncertain' }; });
    test.store.recordLivenessInspection.mockImplementation(async () => { events.push('record'); return true; });
    await expect(test.reconciler.reconcile(current)).resolves.toBe('deferred');
    expect(events).toEqual(['inspect', 'clock', 'record']);
    expect(test.store.recordLivenessInspection).toHaveBeenCalledWith(current.runId, execution, current.heartbeatAt, expect.any(Object));
  });

  it.each([
    { status: 'running', inspection: { kind: 'terminal', reason: 'gone' } },
    { status: 'cancelling', inspection: { kind: 'active' } },
    { status: 'cancelling', inspection: { kind: 'absent', reason: 'gone' } },
  ] as const)('does not read time for $status with a $inspection.kind inspection', async ({ status, inspection }) => {
    const now = vi.fn(() => { throw new Error('clock must not be read'); });
    const test = fixture(inspection, { now });
    await test.reconciler.reconcile(run(status));
    expect(now).not.toHaveBeenCalled();
  });

  it('propagates inspection and observation failures without attempting worker termination', async () => {
    const now = vi.fn(() => new Date('2026-08-24T20:05:00.000Z'));
    const test = fixture({ kind: 'conflict', reason: 'identity mismatch' }, { now });
    const failure = new Error('inspection unavailable');
    test.inspector.inspect.mockRejectedValueOnce(failure);
    await expect(test.reconciler.reconcile(run('cancelling'))).rejects.toBe(failure);
    expect(now).not.toHaveBeenCalled();
    const writeFailure = new Error('observation unavailable');
    test.store.recordLivenessInspection.mockRejectedValueOnce(writeFailure);
    await expect(test.reconciler.reconcile(run('cancelling'))).rejects.toBe(writeFailure);
    expect(test.executions.stop).not.toHaveBeenCalled();
    expect(test.store.cancelExecution).not.toHaveBeenCalled();
    expect(test.store.failExecution).not.toHaveBeenCalled();
  });

  it('propagates stop failure without prematurely finalizing cancellation', async () => {
    const test = fixture({ kind: 'active' });
    const failure = new Error('stop unavailable');
    test.executions.stop.mockRejectedValueOnce(failure);
    await expect(test.reconciler.reconcile(run('cancelling'))).rejects.toBe(failure);
    expect(test.store.cancelExecution).not.toHaveBeenCalled();
    expect(test.store.failExecution).not.toHaveBeenCalled();
  });
});
