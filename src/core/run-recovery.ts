import type { RunQueueMessage, RunRecord } from '../domain/contracts.js';
import { isRetiredRun } from '../domain/run-bindings.js';

/** Computes a private execution wake-up from stored identity and supplied time. */
export function recoveryMessageForRun(run: RunRecord, now: number): RunQueueMessage | undefined {
  if (isRetiredRun(run)) return undefined;
  return { version: '1', runId: run.runId, traceId: `reconcile:${run.runId}:${now}` };
}
