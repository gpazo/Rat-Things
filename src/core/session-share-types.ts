import type { Agent, AgentSession, AgentSessionItem, EnvironmentParam, SessionArtifact } from '../domain/agents-api.js';
import type { ConfigurationRevision } from '../domain/configuration-history.js';
import type { RuntimePin } from '../domain/session-runtime.js';
import type { SessionInputReceipt } from './session-activity.js';
import type { SessionSubagentSnapshot, SessionTurnBinding } from './session-ports.js';

export interface SessionShareManifest {
  version: 1;
  operation_id: string;
  release_hash: string;
  session: AgentSession;
  source_agent?: Agent;
  runtime: RuntimePin;
  turns: Array<Omit<SessionTurnBinding, 'savedArtifacts' | 'cancelRequested'>>;
  subagents: Array<Omit<SessionSubagentSnapshot, 'artifacts'>>;
  imported_history: AgentSessionItem[];
  inputs: SessionInputReceipt[];
  artifacts: Array<{ artifact: SessionArtifact; sha256: string }>;
  deleted_artifacts: string[];
  admission: { admitted: ConfigurationRevision; current: ConfigurationRevision; workload?: unknown };
  environment: EnvironmentParam;
  workspace: { sha256: string; files: number; bytes: number; parts: Array<{ sha256: string; bytes: number }> };
}
export interface ShareStageRequest {
  manifest: SessionShareManifest;
  digest: string;
  workspace_file_ids: string[];
  artifact_file_ids: Record<string, string>;
}
export interface ShareStatus {
  id: string;
  session_id: string;
  digest: string;
  status: 'staged' | 'activating' | 'active' | 'aborted';
}
