import type {
  AgentInput,
  ArtifactReference,
  JsonValue,
  RunActorContext,
  RunCredentialSubjectContext,
  RunDestination,
  RunError,
  RunSource,
} from './contracts.js';

export type ConversationExecutionPolicy = Pick<
  AgentInput,
  'driver' | 'model' | 'sandbox' | 'reasoningEffort'
>;

export const CONVERSATION_STATUSES = [
  'idle',
  'pending',
  'running',
  'awaiting_resume',
  'failed',
] as const;

export const CONVERSATION_TURN_STATUSES = [
  'running',
  'awaiting_resume',
  'completed',
  'failed',
  'abandoned',
] as const;

export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];
export type ConversationTurnStatus = (typeof CONVERSATION_TURN_STATUSES)[number];
export type ConversationDelivery = 'interrupt' | 'defer';
export type ConversationResumeReason = 'timeout' | 'auth' | 'yield' | 'retry';

export interface ConversationLease {
  token: string;
  acquiredAt: string;
  checkedInAt: string;
  expiresAt: string;
}

export interface ConversationProgress {
  eventId: string;
  text: string;
  reportedAt: string;
}

export interface ConversationSession {
  backend: 'microvm';
  id: string;
  state: 'running' | 'suspended' | 'unknown';
  updatedAt: string;
  /** Lambda MicroVMs cannot exist beyond eight hours from initial launch. */
  expiresAt?: string;
  agentThreadId?: string;
}

export interface ConversationRecord {
  version: '1';
  itemType: 'conversation';
  conversationId: string;
  ownerId: string;
  status: ConversationStatus;
  pendingCount: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: number;
  source: RunSource;
  destination: RunDestination;
  actor: RunActorContext;
  credentialSubject: RunCredentialSubjectContext;
  /** Trusted policy selected by ingress/orchestration, never copied from webhook content. */
  executionPolicy?: ConversationExecutionPolicy;
  activeTurnId?: string;
  lease?: ConversationLease;
  latestProgress?: ConversationProgress;
  /** Durable transcript used when a suspended MicroVM is no longer resumable. */
  context?: ArtifactReference;
  /** Best-effort warm continuation; correctness never depends on this reference. */
  session?: ConversationSession;
}

export interface ConversationMessageContent {
  text: string;
  attachments?: ArtifactReference[];
  metadata?: { [key: string]: JsonValue };
}

export interface ConversationMessageRecord {
  version: '1';
  itemType: 'message';
  conversationId: string;
  messageId: string;
  delivery: ConversationDelivery;
  state: 'pending' | 'consumed' | 'dead_letter';
  actor: RunActorContext;
  credentialSubject: RunCredentialSubjectContext;
  source: RunSource;
  destination: RunDestination;
  content: ArtifactReference;
  contentHash: string;
  attemptCount: number;
  createdAt: string;
  receivedAt: string;
  expiresAt: number;
  consumedAt?: string;
  /** Durable binding to the turn and run that consumed this message. */
  turnId?: string;
  runId?: string;
}

export interface ConversationTurnRecord {
  version: '1';
  itemType: 'turn';
  conversationId: string;
  turnId: string;
  state: ConversationTurnStatus;
  slice: number;
  startedAt: string;
  updatedAt: string;
  expiresAt: number;
  runId?: string;
  checkpoint?: ArtifactReference;
  resumeReason?: ConversationResumeReason;
  resumedFromSlice?: number;
  result?: ArtifactReference;
  error?: RunError;
  completedAt?: string;
}

export const CONVERSATION_EVENT_TYPES = [
  'message_received',
  'turn_started',
  'turn_resumed',
  'progress_reported',
  'turn_checkpointed',
  'turn_completed',
  'turn_failed',
  'messages_consumed',
  'run_scheduled',
] as const;

export type ConversationEventType = (typeof CONVERSATION_EVENT_TYPES)[number];

export interface ConversationEventRecord {
  version: '1';
  itemType: 'event';
  conversationId: string;
  eventId: string;
  type: ConversationEventType;
  occurredAt: string;
  payload: ArtifactReference;
  expiresAt: number;
  turnId?: string;
  messageId?: string;
  preview?: string;
}

export interface ConversationCheckpoint {
  version: '1';
  messages: JsonValue[];
  metadata?: { [key: string]: JsonValue };
}

export interface ConversationWakeMessage {
  version: '1';
  conversationId: string;
  traceId: string;
}

export interface ConversationEventPayload {
  version: '1';
  type: ConversationEventType;
  data?: JsonValue;
}
