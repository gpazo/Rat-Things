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
    const decision = reconciliationDecision(run, inspection);
    switch (decision.kind) {
      case 'observe': {
        const observation = livenessObservation(decision, this.now(), this.options.quarantineAfter);
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
