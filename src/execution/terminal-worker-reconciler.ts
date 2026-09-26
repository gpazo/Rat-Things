import type { ExecutionReference, RunRecord } from '../domain/contracts.js';
import { isTerminal } from '../domain/state.js';
import { sameExecution } from '../core/execution-command-planning.js';

export interface DedicatedWorker { runId: string; execution: ExecutionReference }
export interface DedicatedWorkerInventory {
  workers(): AsyncIterable<DedicatedWorker>;
  stop(worker: DedicatedWorker): Promise<void>;
}

/** Terminal Runs cannot reopen. Never retire missing, active or mismatched authority. */
export function terminalWorkerReady(worker: DedicatedWorker, run: RunRecord | undefined, cutoff: number): boolean {
  const completedAt = run ? Date.parse(run.updatedAt) : NaN;
  return Boolean(run?.agentsSession && run.execution && isTerminal(run.status)
    && worker.execution.backend === 'ec2' && worker.execution.generation
    && sameExecution(worker, { runId: run.runId, execution: run.execution })
    && Number.isFinite(completedAt) && completedAt <= cutoff);
}

/** Retire leaked dedicated compute independently of the guest or its mounted filesystem. */
export class TerminalWorkerReconciler {
  public constructor(private readonly options: {
    inventory: DedicatedWorkerInventory;
    getRun(id: string): Promise<RunRecord | undefined>;
    now(): number;
    graceMs: number;
  }) {}

  public async reconcile(): Promise<number> {
    if (!Number.isFinite(this.options.graceMs) || this.options.graceMs < 0) throw new Error('Invalid retirement grace period');
    const cutoff = this.options.now() - this.options.graceMs;
    let retired = 0;
    for await (const worker of this.options.inventory.workers()) {
      const run = await this.options.getRun(worker.runId);
      if (!terminalWorkerReady(worker, run, cutoff)) continue;
      await this.options.inventory.stop(worker);
      retired++;
    }
    return retired;
  }
}
