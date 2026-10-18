import type { SessionLaunch } from './session-execution.js';
import { canonicalJson, sha256Hex } from './json.js';

export interface WorkspaceExecution { runId: string; generation: string }
export interface WorkspaceCompatibility { sandboxId: string; setupDigest: string; policyDigest: string }

/** A single-use permit for a mutable root whose writers have all stopped. */
export interface WorkspaceCheckpoint extends WorkspaceCompatibility {
  id: string;
  piContextId?: string;
  source: WorkspaceExecution;
  rootThreadId: string;
  lastRootTurnId: string | null;
  lastNativeTurnId: string | null;
  reason: 'hibernate';
  /** Resolved host execution envelope; absent only on pre-activation foundation fixtures. */
  authorityDigest?: string;
  createdAt: number;
}

export interface SnapshotLease { id: string; expiresAt: number }
export type WorkspaceHandoff =
  | { phase: 'quiescing'; id: string; source: WorkspaceExecution; expiresAt: number }
  | { phase: 'committed'; checkpoint: WorkspaceCheckpoint; snapshotLease?: SnapshotLease }
  | { phase: 'consumed'; checkpoint: WorkspaceCheckpoint; successor: WorkspaceExecution; attemptId: string }
  | { phase: 'aborted'; id: string; source: WorkspaceExecution };

/** Independently owned immutable content, never a permit for the mutable source root. */
export interface ForkSnapshot extends Omit<WorkspaceCompatibility, 'sandboxId' | 'policyDigest'> {
  id: string;
  sourceSessionId: string;
  sourceCheckpointId: string;
  sourcePolicyDigest: string;
  storageKey: string;
  rootThreadId: string;
  lastRootTurnId: string | null;
  lastNativeTurnId: string | null;
  sizeBytes: number;
  createdAt: number;
}

/** Setup compatibility excludes policy; policy remains a separate, conservative equality check. */
export function workspaceDigests(launch: Pick<SessionLaunch, 'hostedConfiguration' | 'hostedFiles' | 'hostedSkills' | 'environment' | 'environmentCredentials' | 'mcp' | 'runtime'>) {
  const { network: _network, ...setup } = launch.hostedConfiguration ?? {};
  return {
    setupDigest: sha256Hex(canonicalJson({ setup, files: launch.hostedFiles ?? [], skills: launch.hostedSkills ?? [] })),
    policyDigest: sha256Hex(canonicalJson({ environment: launch.environment, network: launch.hostedConfiguration?.network, credentials: launch.environmentCredentials, mcp: launch.mcp, ...(launch.runtime?.kind === 'pi' ? { runtime: launch.runtime } : {}) })),
  };
}

export function sameWorkspaceExecution(left: WorkspaceExecution, right: WorkspaceExecution): boolean {
  return Boolean(left.runId && left.generation) && left.runId === right.runId && left.generation === right.generation;
}

/** Copies from abandoned leases cannot overwrite a later snapshot's content. */
export function forkSnapshotStorageKey(ownerId: string, sessionId: string, checkpointId: string, leaseId: string): string {
  return `fork-snapshots/${sha256Hex(canonicalJson([ownerId, sessionId, checkpointId, leaseId]))}`;
}
