import { AgentsApiError } from '../domain/agents-api-validation.js';
import { sameWorkspaceExecution, type WorkspaceCheckpoint, type WorkspaceCompatibility, type WorkspaceExecution, type SnapshotLease } from '../domain/workspace-checkpoint.js';
import type { StoredEnvironment } from './environment-service.js';
import { canonicalJson } from '../domain/json.js';

export function handoffConflict(message = 'The workspace handoff changed concurrently.'): never {
  throw new AgentsApiError(409, message, 'conflict');
}

function hosted(value: StoredEnvironment): void {
  if (value.retired || value.environment.type !== 'openai_hosted' || ['failed', 'expired'].includes(value.status)) handoffConflict('The managed environment is unavailable.');
}

function authority(value: StoredEnvironment, execution: WorkspaceExecution): void {
  hosted(value);
  if (value.runId !== execution.runId || value.executionGeneration !== execution.generation || !execution.generation) handoffConflict('Managed environment execution authority changed.');
}

export function planHandoffBegin(value: StoredEnvironment, source: WorkspaceExecution, id: string, now: number, expiresAt: number): StoredEnvironment {
  authority(value, source);
  if (!id || !value.sandboxId || !Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + 300) handoffConflict('Invalid workspace handoff lease.');
  const current = value.handoff;
  if (current?.phase === 'quiescing' && current.id === id && sameWorkspaceExecution(current.source, source) && current.expiresAt > now) return value;
  if (current && current.phase !== 'consumed') handoffConflict('The workspace already has a handoff transition.');
  return { ...value, handoff: { phase: 'quiescing', id, source, expiresAt }, status: 'disconnected', connectedUntil: 0 };
}

export function planCheckpointWrite(value: StoredEnvironment, checkpoint: WorkspaceCheckpoint, now: number): StoredEnvironment {
  authority(value, checkpoint.source);
  const handoff = value.handoff;
  if (handoff?.phase === 'committed' && canonicalJson(handoff.checkpoint) === canonicalJson(checkpoint)) return value;
  if (handoff?.phase !== 'quiescing' || handoff.id !== checkpoint.id || !sameWorkspaceExecution(handoff.source, checkpoint.source) || handoff.expiresAt <= now) handoffConflict();
  if (checkpoint.sandboxId !== value.sandboxId || !checkpoint.rootThreadId || checkpoint.reason !== 'hibernate'
    || !/^[a-f0-9]{64}$/.test(checkpoint.setupDigest) || !/^[a-f0-9]{64}$/.test(checkpoint.policyDigest)
    || !Number.isSafeInteger(checkpoint.createdAt) || checkpoint.createdAt > now || checkpoint.createdAt < 0) handoffConflict('Invalid workspace checkpoint.');
  return { ...value, handoff: { phase: 'committed', checkpoint }, status: 'disconnected', connectedUntil: 0 };
}

export function planCheckpointAdoption(value: StoredEnvironment, checkpointId: string, successor: WorkspaceExecution, attemptId: string, compatibility: WorkspaceCompatibility, now: number): StoredEnvironment {
  hosted(value);
  if (!successor.runId || !successor.generation || !attemptId) handoffConflict('Invalid successor execution.');
  const handoff = value.handoff;
  if (handoff?.phase !== 'committed' && handoff?.phase !== 'consumed') handoffConflict('No committed workspace checkpoint.');
  const checkpoint = handoff.checkpoint;
  if (checkpoint.id !== checkpointId || checkpoint.sandboxId !== value.sandboxId || checkpoint.sandboxId !== compatibility.sandboxId
    || checkpoint.setupDigest !== compatibility.setupDigest || checkpoint.policyDigest !== compatibility.policyDigest) handoffConflict('Workspace checkpoint is incompatible.');
  if (handoff.phase === 'consumed') {
    if (handoff.attemptId === attemptId && sameWorkspaceExecution(handoff.successor, successor)) { authority(value, successor); return value; }
    handoffConflict('Workspace checkpoint was already consumed.');
  }
  authority(value, checkpoint.source);
  if (value.pendingRunId && value.pendingRunId !== successor.runId) handoffConflict('A different replacement owns workspace admission.');
  if (successor.runId === checkpoint.source.runId || successor.generation === checkpoint.source.generation) handoffConflict('A checkpoint requires a new execution.');
  if (handoff.snapshotLease && handoff.snapshotLease.expiresAt > now) handoffConflict('The workspace is being copied.');
  const { pendingRunId: _pending, ...claimed } = value;
  return { ...claimed, runId: successor.runId, executionGeneration: successor.generation, status: 'pending', connectedUntil: 0,
    handoff: { phase: 'consumed', checkpoint, successor, attemptId } };
}

/** Lease expiry alone never proves that the old writer has stopped. Keep a durable tombstone. */
export function planHandoffAbort(value: StoredEnvironment, source: WorkspaceExecution, id: string): StoredEnvironment {
  authority(value, source);
  const handoff = value.handoff;
  if (handoff?.phase === 'aborted' && handoff.id === id && sameWorkspaceExecution(handoff.source, source)) return value;
  if (handoff?.phase !== 'quiescing' || handoff.id !== id || !sameWorkspaceExecution(handoff.source, source)) handoffConflict();
  return { ...value, handoff: { phase: 'aborted', id, source }, status: 'disconnected', connectedUntil: 0 };
}

export function planSnapshotLease(value: StoredEnvironment, checkpointId: string, lease: SnapshotLease, now: number): StoredEnvironment {
  hosted(value);
  const handoff = value.handoff;
  if (handoff?.phase !== 'committed' || handoff.checkpoint.id !== checkpointId) handoffConflict('No committed source checkpoint.');
  if (!lease.id || !Number.isSafeInteger(lease.expiresAt) || lease.expiresAt <= now || lease.expiresAt > now + 300) handoffConflict('Invalid snapshot lease.');
  if (handoff.snapshotLease?.id === lease.id) {
    if (handoff.snapshotLease.expiresAt <= now || handoff.snapshotLease.expiresAt !== lease.expiresAt) handoffConflict('Snapshot lease cannot be renewed or reused.');
    return value;
  }
  if (handoff.snapshotLease && handoff.snapshotLease.expiresAt > now) handoffConflict('The workspace is already being copied.');
  return { ...value, handoff: { ...handoff, snapshotLease: lease } };
}

export function planSnapshotRelease(value: StoredEnvironment, checkpointId: string, leaseId: string, now: number): StoredEnvironment {
  hosted(value);
  const handoff = value.handoff;
  if (handoff?.phase !== 'committed' || handoff.checkpoint.id !== checkpointId || handoff.snapshotLease?.id !== leaseId || handoff.snapshotLease.expiresAt <= now) handoffConflict('Snapshot lease is no longer held.');
  const { snapshotLease: _lease, ...released } = handoff;
  return { ...value, handoff: released };
}
