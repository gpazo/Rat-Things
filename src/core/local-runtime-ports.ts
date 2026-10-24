import type { LocalRuntimeStatus } from '../domain/local-runtime.js';
import type { SessionLaunch } from '../domain/session-execution.js';
import type { PortableFile } from '../domain/workspace-transfer.js';
import type { LocalWorkspaceIntent } from '../domain/local-workspace.js';

export interface LocalWorkerConfiguration {
  ownerId: string;
  sessionId: string;
  environmentId: string;
  executorKey: string;
  harnessKey: string;
  publicURL: string;
  launch: SessionLaunch;
  workspace: LocalWorkspaceIntent;
}

export interface LocalStartRequest {
  workspace: LocalWorkspaceIntent;
  worker: Omit<LocalWorkerConfiguration, 'publicURL' | 'workspace'>;
}

export interface LocalRuntime {
  status(): Promise<LocalRuntimeStatus>;
  setup(): Promise<LocalRuntimeStatus>;
  start(request: LocalStartRequest, commitWorkspaceClaim: () => Promise<void>): Promise<string>;
  admitTurn(sessionId: string): Promise<void>;
  stop(sessionId: string): Promise<void>;
  running(sessionId: string): Promise<boolean>;
  snapshot(sessionId: string): Promise<PortableFile[]>;
  close(): Promise<void>;
}
