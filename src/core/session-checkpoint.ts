import type { ArtifactReference } from '../domain/contracts.js';
import type { SessionRuntimeState } from './session-runtime-planning.js';

/** An acknowledged idle history boundary and a frozen workspace, never a process snapshot. */
export interface SessionCheckpoint {
  version: 1;
  id: string;
  ownerId: string;
  sessionId: string;
  runId: string;
  generation: string;
  createdAt: number;
  journalRevision: number;
  snapshot: SessionRuntimeState;
  archive: ArtifactReference;
  archiveBytes: number;
  recovery: 'history';
}
