import type { ExecutionController } from '../core/ports.js';
import type {
  ExecutionLivenessObservation,
  ExecutionReference,
  RunError,
  RunRecord,
} from '../domain/contracts.js';

export type ExecutionInspection =
  | { kind: 'active' }
  | { kind: 'inactive'; reason: string }
  | { kind: 'terminal'; reason: string }
  | { kind: 'absent'; reason: string }
  | { kind: 'conflict'; reason: string }
  | { kind: 'unknown'; reason: string };

export interface ExecutionInspector {
  inspect(runId: string, execution: ExecutionReference): Promise<ExecutionInspection>;
}

export interface ExecutionReconciliationStore {
  failExecution(
    runId: string,
    execution: ExecutionReference,
    expectedHeartbeatAt: string,
    error: RunError,
  ): Promise<boolean>;
  cancelExecution(runId: string, execution: ExecutionReference): Promise<boolean>;
  recordLivenessInspection(
    runId: string,
    execution: ExecutionReference,
    expectedHeartbeatAt: string,
    observation: ExecutionLivenessObservation,
  ): Promise<boolean>;
}

export type ExecutionReconciliationOutcome =
  | 'active'
  | 'failed'
  | 'cancelled'
  | 'stop-requested'
  | 'deferred'
  | 'quarantined'
  | 'raced'
  | 'legacy';

export interface ActiveRunReconcilerOptions {
  store: ExecutionReconciliationStore;
  inspector: ExecutionInspector;
  executions: ExecutionController;
  now?: () => Date;
  quarantineAfter?: number;
}

/**
 * Repairs stale attached Runs without ever replaying their semantic operation.
 * Every mutation is fenced by backend ID, worker generation, and heartbeat.
 */
export class ActiveRunReconciler {
  public constructor(private readonly options: ActiveRunReconcilerOptions) {}

  public async reconcile(run: RunRecord): Promise<ExecutionReconciliationOutcome> {
    const { execution, heartbeatAt } = run;
    if (!execution || execution.id === 'pending' || !execution.generation || !heartbeatAt) {
      return 'legacy';
    }
    if (!['dispatching', 'running', 'cancelling'].includes(run.status)) return 'raced';
    if (run.liveness?.quarantinedAt) return 'quarantined';

    const inspection = await this.options.inspector.inspect(run.runId, execution);
    // Uncertain identity never authorizes failure or termination, including
    // during cancellation. Both paths retain the same fenced evidence.
    if (inspection.kind === 'conflict' || inspection.kind === 'unknown') {
      const prior = run.liveness?.outcome === inspection.kind
        ? run.liveness.consecutiveUncertain
        : 0;
      const consecutiveUncertain = prior + 1;
      const checkedAt = this.now();
      const quarantineAfter = Math.max(1, this.options.quarantineAfter ?? 3);
      const observation: ExecutionLivenessObservation = {
        checkedAt,
        outcome: inspection.kind,
        consecutiveUncertain,
        reason: boundedReason(inspection.reason),
        ...(consecutiveUncertain >= quarantineAfter ? { quarantinedAt: checkedAt } : {}),
      };
      const retained = await this.options.store.recordLivenessInspection(
        run.runId,
        execution,
        heartbeatAt,
        observation,
      );
      if (!retained) return 'raced';
      return observation.quarantinedAt ? 'quarantined' : 'deferred';
    }

    if (run.status === 'cancelling') {
      if (inspection.kind === 'terminal' || inspection.kind === 'absent') {
        return await this.options.store.cancelExecution(run.runId, execution) ? 'cancelled' : 'raced';
      }
      await this.options.executions.stop(execution, 'reconciler finalized a stale cancellation');
      return 'stop-requested';
    }

    if (inspection.kind === 'active') {
      const retained = await this.options.store.recordLivenessInspection(
        run.runId,
        execution,
        heartbeatAt,
        {
          checkedAt: this.now(),
          outcome: 'active',
          consecutiveUncertain: 0,
        },
      );
      return retained ? 'active' : 'raced';
    }

    const failed = await this.options.store.failExecution(
      run.runId,
      execution,
      heartbeatAt,
      {
        code: 'execution_lost',
        message: boundedReason(inspection.reason),
        retryable: true,
      },
    );
    return failed ? 'failed' : 'raced';
  }

  private now(): string {
    return (this.options.now ?? (() => new Date()))().toISOString();
  }
}

function boundedReason(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').slice(0, 1_000);
}
