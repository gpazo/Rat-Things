import { createHash } from 'node:crypto';
import type { RunRecord } from '../domain/contracts.js';

/**
 * Stable identity for the one execution generation admitted for a semantic Run.
 *
 * Run starts are idempotent and Rat deliberately does not restart a semantic Run
 * after an attached execution is lost. Deriving the token from trusted immutable
 * record fields therefore keeps retries stable while giving workers and repair
 * paths an identity that is independent from the backend's reusable VM handle.
 */
export function executionGeneration(run: Pick<RunRecord, 'runId' | 'requestHash'>): string {
  return createHash('sha256')
    .update('rat-things/execution-generation/v1\0')
    .update(run.runId)
    .update('\0')
    .update(run.requestHash)
    .digest('hex');
}
