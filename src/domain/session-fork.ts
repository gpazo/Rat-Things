import type { AgentSessionItem } from './agents-api.js';
import type { WorkspaceCheckpoint, SnapshotLease } from './workspace-checkpoint.js';

export interface SessionFork {
  piContextId?: string;
  sourceSessionId: string;
  sourceEnvironmentId: string;
  checkpoint: WorkspaceCheckpoint;
  lease: SnapshotLease;
  storageKey: string;
  createdAt: number;
  /** Private recovery context, stored in encrypted resource content, never public Items. */
  history: AgentSessionItem[];
}
