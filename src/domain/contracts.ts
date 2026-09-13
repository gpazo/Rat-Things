import type {
  AgentCapabilityRequest,
  AgentPersonality,
  IntegrationAccessRequest,
  ReasoningSummary,
} from './capabilities.js';
import type { AgentToolCallRecord } from './interaction.js';

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
export type ExecutionBackend = 'microvm' | 'ec2';
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
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'ultra';
  reasoningSummary?: ReasoningSummary;
  personality?: AgentPersonality;
  capabilities?: AgentCapabilityRequest;
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
  integrations?: IntegrationAccessRequest;
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
  /** Stable for a relative path in a private Run artifact catalog. */
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
  /** Immutable worker generation; absent only on records created before liveness fencing. */
  generation?: string;
  startedAt?: string;
}

export type ExecutionLivenessOutcome = 'active' | 'conflict' | 'unknown';

/** Internal repair evidence. This is intentionally absent from public Run projections. */
export interface ExecutionLivenessObservation {
  checkedAt: string;
  outcome: ExecutionLivenessOutcome;
  consecutiveUncertain: number;
  reason?: string;
  quarantinedAt?: string;
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
  /** Trusted owner of delegated capability/connection policy; never caller-selected in RunRequest. */
  capabilityOwnerId?: string;
  ownerCreated: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt: number;
  requestHash: string;
  /** Original caller/provider input. It is immutable and drives idempotency. */
  input: ArtifactReference;
  sourceKind: RunSource['kind'];
  provenance?: RunProvenance;
  /** Trusted Agents API binding. The launch configuration is stored in encrypted S3. */
  agentsSession?: { sessionId: string; turnId: string; launch: ArtifactReference };
  execution?: ExecutionReference;
  /** Indexed independently from semantic updatedAt so heartbeats do not resemble state changes. */
  heartbeatAt?: string;
  liveness?: ExecutionLivenessObservation;
  /** Internal bounded dynamic-tool ledger; omitted from public Run projections. */
  agentToolCalls?: AgentToolCallRecord[];
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
