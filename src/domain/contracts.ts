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
export type ExecutionBackend = 'ecs' | 'microvm';
export type AgentDriverName = 'codex' | 'claude-code' | 'mock';
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

export interface ExecutionReference {
  backend: ExecutionBackend;
  id: string;
  startedAt?: string;
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
