import type {
  ArtifactReference, RunProvenance, RunRecord, RunRequest,
} from '../domain/contracts.js';
import { canonicalJson as stableJson, sha256Hex as sha256 } from '../domain/json.js';
import { validateCapabilityOwner } from '../domain/run-bindings.js';
import { ValidationError } from '../domain/validation.js';
import { ConflictError, ForbiddenError } from './errors.js';

export interface SubmitOptions {
  idempotencyKey?: string;
  traceId?: string;
  provenance?: RunProvenance;
  /** Trusted delegated policy principal, distinct from the run owner. */
  capabilityOwnerId?: string;
  agentsSession?: RunRecord['agentsSession'];
}

export function runInputKey(ownerId: string, runId: string, hash: string): string {
  const ownerHash = sha256(ownerId).slice(0, 32);
  return `owners/${ownerHash}/runs/${runId}/input-${hash}.json`;
}

/** Record construction uses already stored input and supplied time; it performs no operations. */
export function createQueuedRun({
  ownerId, runId, request, requestHash, input, submit, now, retentionSeconds,
}: {
  ownerId: string;
  runId: string;
  request: RunRequest;
  requestHash: string;
  input: ArtifactReference;
  submit: SubmitOptions;
  now: Date;
  retentionSeconds: number;
}): RunRecord {
  const iso = now.toISOString();
  return {
    runId,
    ownerId,
    ...(submit.capabilityOwnerId
      ? { capabilityOwnerId: validateCapabilityOwner(submit.capabilityOwnerId) }
      : {}),
    ownerCreated: `${ownerId}#${iso}#${runId}`,
    status: 'queued',
    createdAt: iso,
    updatedAt: iso,
    expiresAt: Math.floor(now.getTime() / 1_000) + retentionSeconds,
    requestHash,
    input,
    sourceKind: request.source?.kind ?? 'api',
    ...(submit.provenance ? { provenance: submit.provenance } : {}),
    ...(submit.agentsSession ? { agentsSession: submit.agentsSession } : {}),
  };
}

/** Reuse is decided from accepted identity, including bindings, before any retry wake-up. */
export function assertSameSubmission(record: RunRecord, requestHash: string, submit: SubmitOptions): RunRecord {
  const same = assertSameRequest(record, requestHash);
  if (stableJson(same.agentsSession ?? null) !== stableJson(submit.agentsSession ?? null)) throw new ConflictError('Agents session launch binding changed on retry');
  return same;
}

export function deterministicRunId(ownerId: string, key: string): string {
  const hex = sha256(`${ownerId}\u0000${key}`).slice(0, 32).split('');
  hex[12] = '5';
  const variant = Number.parseInt(hex[16] ?? '0', 16);
  hex[16] = ((variant & 0x3) | 0x8).toString(16);
  const joined = hex.join('');
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}

export function validateIdempotencyKey(value: string): string {
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(value)) {
    throw new ValidationError('Idempotency-Key must be 1-200 safe ASCII characters');
  }
  return value;
}

function assertSameRequest(record: RunRecord, requestHash: string): RunRecord {
  if (record.requestHash !== requestHash) {
    throw new ConflictError('the idempotency key was already used with a different request');
  }
  return record;
}

export function assertOwner(record: RunRecord, ownerId: string): void {
  if (record.ownerId !== ownerId) throw new ForbiddenError('run belongs to another owner');
}

export function validateOwner(ownerId: string): void {
  if (!ownerId.trim()) throw new ForbiddenError('an authenticated owner is required');
  if (Buffer.byteLength(ownerId, 'utf8') > 1_024) {
    throw new ForbiddenError('owner identity is too large');
  }
}
