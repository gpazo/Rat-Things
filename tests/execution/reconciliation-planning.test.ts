import { describe, expect, it } from 'vitest';
import type { RunRecord } from '../../src/domain/contracts.js';
import {
  livenessObservation,
  reconciliationDecision,
  reconciliationTarget,
  type ExecutionInspection,
} from '../../src/execution/reconciliation-planning.js';
import { execution, freeze, run, timestamp } from './fixtures.js';

function attached(overrides: Partial<RunRecord> = {}): RunRecord {
  return run({ status: 'running', execution, heartbeatAt: '2026-08-24T20:00:02.000Z', ...overrides });
}

describe('reconciliation eligibility', () => {
  it('requires a complete attachment and heartbeat before considering status or quarantine', () => {
    const quarantined = { checkedAt: timestamp, outcome: 'unknown' as const, consecutiveUncertain: 3, quarantinedAt: timestamp };
    expect(reconciliationTarget(run({ status: 'failed', liveness: quarantined }))).toEqual({ kind: 'skip', outcome: 'legacy' });
    for (const reference of [
      { ...execution, id: 'pending' },
      { backend: 'microvm' as const, id: 'legacy' },
      { ...execution, generation: '' },
    ]) {
      expect(reconciliationTarget(attached({ execution: reference }))).toEqual({ kind: 'skip', outcome: 'legacy' });
    }
    const { heartbeatAt: _heartbeatAt, ...missingHeartbeat } = attached();
    expect(reconciliationTarget(missingHeartbeat)).toEqual({ kind: 'skip', outcome: 'legacy' });
    expect(reconciliationTarget(attached({ heartbeatAt: '' }))).toEqual({ kind: 'skip', outcome: 'legacy' });
  });

  it('checks current status before quarantine and preserves the exact inspected reference', () => {
    const current = freeze(attached());
    const target = reconciliationTarget(current);
    expect(target).toEqual({ kind: 'inspect', execution, heartbeatAt: current.heartbeatAt });
    if (target.kind !== 'inspect') throw new Error('expected inspectable attachment');
    expect(target.execution).toBe(current.execution);
    const liveness = { checkedAt: timestamp, outcome: 'conflict' as const, consecutiveUncertain: 3, quarantinedAt: timestamp };
    expect(reconciliationTarget(attached({ status: 'cancelled', liveness }))).toEqual({ kind: 'skip', outcome: 'raced' });
    expect(reconciliationTarget(attached({ liveness }))).toEqual({ kind: 'skip', outcome: 'quarantined' });
    expect(reconciliationTarget(attached({ liveness: { ...liveness, quarantinedAt: '' } })).kind).toBe('inspect');
  });
});

describe('reconciliation decisions', () => {
  it.each(['conflict', 'unknown'] as const)('only retains %s evidence during cancellation, even after repeated uncertainty', kind => {
    const current = freeze(attached({ status: 'cancelling', liveness: { checkedAt: timestamp, outcome: kind, consecutiveUncertain: 2 } }));
    const before = structuredClone(current);
    const decision = reconciliationDecision(current, freeze({ kind, reason: 'identity\r\nnot confirmed' }));
    expect(decision).toEqual({ kind: 'observe', outcome: kind, consecutiveUncertain: 3, reason: 'identity\r\nnot confirmed' });
    if (decision.kind !== 'observe') throw new Error('expected observation');
    expect(livenessObservation(freeze(decision), timestamp)).toEqual({
      checkedAt: timestamp, outcome: kind, consecutiveUncertain: 3, reason: 'identity not confirmed', quarantinedAt: timestamp,
    });
    expect(current).toEqual(before);
  });

  it('resets uncertainty when the inspection changes and clears it on an active worker', () => {
    const current = freeze(attached({ liveness: { checkedAt: timestamp, outcome: 'conflict', consecutiveUncertain: 50 } }));
    const changed = reconciliationDecision(current, { kind: 'unknown', reason: 'new uncertainty' });
    expect(changed).toMatchObject({ kind: 'observe', outcome: 'unknown', consecutiveUncertain: 1 });
    const active = reconciliationDecision(current, { kind: 'active' });
    expect(active).toEqual({ kind: 'observe', outcome: 'active', consecutiveUncertain: 0 });
    if (active.kind !== 'observe') throw new Error('expected observation');
    expect(livenessObservation(active, timestamp, 0)).toEqual({ checkedAt: timestamp, outcome: 'active', consecutiveUncertain: 0 });
  });

  it('distinguishes confirmed cancellation from an execution that still needs stopping', () => {
    const current = freeze(attached({ status: 'cancelling' }));
    for (const inspection of [{ kind: 'active' }, { kind: 'inactive', reason: 'no worker' }] satisfies ExecutionInspection[]) {
      expect(reconciliationDecision(current, inspection)).toEqual({ kind: 'stop', reason: 'reconciler finalized a stale cancellation' });
    }
    for (const inspection of [{ kind: 'terminal', reason: 'terminated' }, { kind: 'absent', reason: 'not found' }] satisfies ExecutionInspection[]) {
      expect(reconciliationDecision(current, inspection)).toEqual({ kind: 'cancel' });
    }
  });

  it.each(['inactive', 'terminal', 'absent'] as const)('records execution_lost for a working run with %s evidence', kind => {
    const reason = `  worker\r\n\n${'x'.repeat(1_100)}`;
    expect(reconciliationDecision(freeze(attached()), freeze({ kind, reason }))).toEqual({
      kind: 'fail', error: { code: 'execution_lost', message: `  worker ${'x'.repeat(991)}`, retryable: true },
    });
    expect(reconciliationDecision(attached(), { kind, reason: '' })).toMatchObject({ error: { message: '' } });
  });

  it('preserves the configured quarantine threshold, including zero and fractional values', () => {
    const decision = freeze({ kind: 'observe' as const, outcome: 'unknown' as const, consecutiveUncertain: 1, reason: '' });
    expect(livenessObservation(decision, timestamp)).not.toHaveProperty('quarantinedAt');
    expect(livenessObservation(decision, timestamp, 0).quarantinedAt).toBe(timestamp);
    expect(livenessObservation(decision, timestamp, -1).quarantinedAt).toBe(timestamp);
    expect(livenessObservation({ ...decision, consecutiveUncertain: 2 }, timestamp, 2.5)).not.toHaveProperty('quarantinedAt');
    expect(livenessObservation({ ...decision, consecutiveUncertain: 3 }, timestamp, 2.5).quarantinedAt).toBe(timestamp);
    expect(livenessObservation(decision, timestamp, Infinity)).not.toHaveProperty('quarantinedAt');
    expect(livenessObservation(decision, timestamp, NaN)).not.toHaveProperty('quarantinedAt');
  });
});
