export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export const RUN_STATUSES = [
  'queued',
  'dispatching',
  'running',
  'cancelling',
  'succeeded',
  'failed',
  'cancelled',
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];
export type ExecutionBackend = 'microvm';
export type AgentDriverName = 'codex' | 'mock';
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type RepositoryProvider = 'github' | 'gitlab' | 'generic';

export interface RepositoryInput {
  provider: RepositoryProvider;
  url: string;
  ref?: string;
  baseRef?: string;
  installationId?: string;
  credentialSecretArn?: string;
}

export interface AgentInput {
  driver?: AgentDriverName;
  model?: string;
  sandbox?: SandboxMode;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
  outputSchema?: { [key: string]: JsonValue };
}

export interface ExecutionInput {
  backend?: ExecutionBackend;
  timeoutSeconds?: number;
}

export interface ApiSource {
  kind: 'api';
  requestId?: string;
}

export interface GitHubSource {
  kind: 'github';
  deliveryId: string;
  event: string;
  repository: string;
  issueNumber?: number;
  installationId?: string;
}

export interface GitLabSource {
  kind: 'gitlab';
  event: string;
  projectId: string;
  mergeRequestIid?: number;
}

export interface TeamsSource {
  kind: 'teams';
  tenantId?: string;
  teamId?: string;
  channelId?: string;
  conversationId: string;
  activityId: string;
  senderId?: string;
}

export interface SlackSource {
  kind: 'slack';
  teamId?: string;
  channelId: string;
  threadTs?: string;
  eventId: string;
  userId?: string;
}

export type RunSource = ApiSource | GitHubSource | GitLabSource | TeamsSource | SlackSource;

export interface RunActorContext {
  kind: 'human' | 'system';
  id: string;
  provider: RunSource['kind'];
}

export interface RunCredentialSubjectContext {
  kind: 'runtime' | 'actor';
  id: string;
}

export interface RunProvenance {
  actor: RunActorContext;
  credentialSubject: RunCredentialSubjectContext;
}

export interface RunDestination {
  kind: 'source' | 'teams' | 'slack' | 'none';
  route?: string;
}

export interface RunRequest {
  version: '1';
  prompt: string;
  repository?: RepositoryInput;
  agent?: AgentInput;
  execution?: ExecutionInput;
  source?: RunSource;
  destinations?: RunDestination[];
  metadata?: { [key: string]: JsonValue };
  parentRunId?: string;
}

export interface ArtifactReference {
  bucket: string;
  key: string;
  sha256: string;
}

/** A user-visible file published by an agent run. */
export interface PublishedArtifact {
  /** Stable for a relative artifact path within a conversation. */
  id: string;
  /** Relative path below .rat-things/artifacts in the agent workspace. */
  path: string;
  mediaType: string;
  bytes: number;
  createdAt: string;
  sourceRunId: string;
  file: ArtifactReference;
}

export interface ArtifactCatalog {
  version: '1';
  files: PublishedArtifact[];
}

export interface ExecutionReference {
  backend: ExecutionBackend;
  id: string;
  startedAt?: string;
}

/**
 * Trusted control-plane metadata attached by the conversation coordinator.
 * This is deliberately stored on the run record instead of the public
 * RunRequest so callers cannot select another conversation's MicroVM.
 */
export interface ConversationRunBinding {
  conversationId: string;
  turnId: string;
  slice: number;
  preferredMicrovmId?: string;
  agentThreadId?: string;
  /** S3 batch containing only the messages consumed by this slice. */
  continuation?: ArtifactReference;
  /** Trusted catalog used to restore durable files into a replacement MicroVM. */
  artifacts?: ArtifactReference;
}

export interface RunError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface RunResult {
  output: ArtifactReference;
  preview: string;
  exitCode: number;
  durationMs: number;
  agentThreadId?: string;
  usage?: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    reasoningOutputTokens?: number;
  };
  events?: ArtifactReference;
  workspacePatch?: ArtifactReference;
  /** Complete current file catalog; an empty array represents deliberate deletion. */
  artifacts?: PublishedArtifact[];
}

export interface RunRecord {
  runId: string;
  ownerId: string;
  ownerCreated: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt: number;
  requestHash: string;
  input: ArtifactReference;
  sourceKind: RunSource['kind'];
  provenance?: RunProvenance;
  conversation?: ConversationRunBinding;
  execution?: ExecutionReference;
  result?: RunResult;
  error?: RunError;
  cancelRequestedAt?: string;
}

export interface RunQueueMessage {
  version: '1';
  runId: string;
  traceId: string;
}

export interface RunStateEvent {
  version: '1';
  runId: string;
  ownerId: string;
  status: RunStatus;
  sourceKind: RunSource['kind'];
  occurredAt: string;
  resultPreview?: string;
  error?: RunError;
}

export interface ListRunsResult {
  items: RunRecord[];
  nextToken?: string;
}
