import type { ExecutionController } from '../core/ports.js';
import type {
  ExecutionLivenessObservation,
  ExecutionReference,
  RunError,
  RunRecord,
} from '../domain/contracts.js';
import {
  livenessObservation,
  reconciliationDecision,
  reconciliationTarget,
  type ExecutionInspection,
  type ExecutionReconciliationOutcome,
} from './reconciliation-planning.js';

export type { ExecutionInspection, ExecutionReconciliationOutcome } from './reconciliation-planning.js';

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

export interface ActiveRunReconcilerOptions {
  store: ExecutionReconciliationStore;
  inspector: ExecutionInspector;
  executions: ExecutionController;
  now?: () => Date;
  quarantineAfter?: number;
}

/**
 * Repairs stale attached Runs without ever replaying their semantic operation.
 * Conditional writes retain the inspected execution identity and, where required, heartbeat.
 */
export class ActiveRunReconciler {
  public constructor(private readonly options: ActiveRunReconcilerOptions) {}

  public async reconcile(run: RunRecord): Promise<ExecutionReconciliationOutcome> {
    const target = reconciliationTarget(run);
    if (target.kind === 'skip') return target.outcome;
    const { execution, heartbeatAt } = target;
    const inspection = await this.options.inspector.inspect(run.runId, execution);
    const checkedAt = inspection.kind === 'active' && run.status !== 'cancelling' ? this.now() : undefined;
    const decision = reconciliationDecision(run, inspection, checkedAt ? Date.parse(checkedAt) - Date.parse(heartbeatAt) : 0);
    switch (decision.kind) {
      case 'observe': {
        const observation = livenessObservation(decision, checkedAt ?? this.now(), this.options.quarantineAfter);
        const retained = await this.options.store.recordLivenessInspection(
          run.runId,
          execution,
          heartbeatAt,
          observation,
        );
        if (!retained) return 'raced';
        if (observation.outcome === 'active') return 'active';
        return observation.quarantinedAt ? 'quarantined' : 'deferred';
      }
      case 'cancel':
        return await this.options.store.cancelExecution(run.runId, execution) ? 'cancelled' : 'raced';
      case 'stop':
        await this.options.executions.stop(execution, decision.reason);
        return 'stop-requested';
      case 'expire': {
        const failed = await this.options.store.failExecution(run.runId, execution, heartbeatAt, decision.error);
        if (!failed) return 'raced';
        await this.options.executions.stop(execution, decision.error.message);
        return 'heartbeat-expired';
      }
      case 'fail': {
        const failed = await this.options.store.failExecution(run.runId, execution, heartbeatAt, decision.error);
        return failed ? 'failed' : 'raced';
      }
    }
  }

  private now(): string {
    return (this.options.now ?? (() => new Date()))().toISOString();
  }
}
