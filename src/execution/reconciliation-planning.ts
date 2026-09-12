import type { ExecutionLivenessObservation, ExecutionReference, RunError, RunRecord } from '../domain/contracts.js';

export type ExecutionInspection =
  | { kind: 'active' }
  | { kind: 'inactive'; reason: string }
  | { kind: 'terminal'; reason: string }
  | { kind: 'absent'; reason: string }
  | { kind: 'conflict'; reason: string }
  | { kind: 'unknown'; reason: string };

export type ExecutionReconciliationOutcome =
  | 'active'
  | 'failed'
  | 'cancelled'
  | 'stop-requested'
  | 'deferred'
  | 'quarantined'
  | 'raced'
  | 'legacy';

export type ReconciliationTarget =
  | { kind: 'skip'; outcome: 'legacy' | 'raced' | 'quarantined' }
  | { kind: 'inspect'; execution: ExecutionReference; heartbeatAt: string };

export type LivenessDecision =
  | { kind: 'observe'; outcome: 'active'; consecutiveUncertain: 0 }
  | { kind: 'observe'; outcome: 'conflict' | 'unknown'; consecutiveUncertain: number; reason: string };

export type ReconciliationDecision =
  | LivenessDecision
  | { kind: 'cancel' }
  | { kind: 'stop'; reason: string }
  | { kind: 'fail'; error: RunError };

/** Capture the attachment and heartbeat used by conditional repair operations. */
export function reconciliationTarget(run: RunRecord): ReconciliationTarget {
  const { execution, heartbeatAt } = run;
  if (!execution || execution.id === 'pending' || !execution.generation || !heartbeatAt) {
    return { kind: 'skip', outcome: 'legacy' };
  }
  if (!['dispatching', 'running', 'cancelling'].includes(run.status)) return { kind: 'skip', outcome: 'raced' };
  if (run.liveness?.quarantinedAt) return { kind: 'skip', outcome: 'quarantined' };
  return { kind: 'inspect', execution, heartbeatAt };
}

/** Uncertain identity permits recording evidence, never failure or termination. */
export function reconciliationDecision(
  run: Pick<RunRecord, 'status' | 'liveness'>,
  inspection: ExecutionInspection,
): ReconciliationDecision {
  if (inspection.kind === 'conflict' || inspection.kind === 'unknown') {
    const prior = run.liveness?.outcome === inspection.kind ? run.liveness.consecutiveUncertain : 0;
    return { kind: 'observe', outcome: inspection.kind, consecutiveUncertain: prior + 1, reason: inspection.reason };
  }
  if (run.status === 'cancelling') {
    return inspection.kind === 'terminal' || inspection.kind === 'absent'
      ? { kind: 'cancel' }
      : { kind: 'stop', reason: 'reconciler finalized a stale cancellation' };
  }
  if (inspection.kind === 'active') return { kind: 'observe', outcome: 'active', consecutiveUncertain: 0 };
  return { kind: 'fail', error: { code: 'execution_lost', message: boundedReason(inspection.reason), retryable: true } };
}

/** Time is supplied only for an observation; stopping and finalization do not need a clock. */
export function livenessObservation(
  decision: LivenessDecision,
  checkedAt: string,
  quarantineAfter?: number,
): ExecutionLivenessObservation {
  if (decision.outcome === 'active') return { checkedAt, outcome: 'active', consecutiveUncertain: 0 };
  const threshold = Math.max(1, quarantineAfter ?? 3);
  return {
    checkedAt,
    outcome: decision.outcome,
    consecutiveUncertain: decision.consecutiveUncertain,
    reason: boundedReason(decision.reason),
    ...(decision.consecutiveUncertain >= threshold ? { quarantinedAt: checkedAt } : {}),
  };
}

function boundedReason(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').slice(0, 1_000);
}
