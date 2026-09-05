import type {
  AgentInput,
  PublishedArtifact,
  ArtifactReference,
  JsonValue,
  RunActorContext,
  RunCredentialSubjectContext,
  RunDestination,
  RunError,
  RunRequest,
  RunSource,
} from './contracts.js';
import type { IntegrationAccessRequest } from './capabilities.js';

export type ConversationExecutionPolicy = Omit<AgentInput, 'outputSchema'>;

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
  /** Trusted delegated policy principal, distinct from the mailbox/run owner. */
  capabilityOwnerId?: string;
  status: ConversationStatus;
  pendingCount: number;
  /** Bounded, denormalized label derived from the first user message. */
  title?: string;
  /** Bounded, denormalized preview of the newest user or assistant message. */
  lastMessagePreview?: string;
  /** Owner-controlled organization metadata; these never influence execution authority. */
  pinnedAt?: string;
  hiddenAt?: string;
  readAt?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: number;
  source: RunSource;
  destination: RunDestination;
  actor: RunActorContext;
  credentialSubject: RunCredentialSubjectContext;
  /** Trusted policy selected by ingress/orchestration, never copied from webhook content. */
  executionPolicy?: ConversationExecutionPolicy;
  /** Owner-scoped connection selectors selected by trusted ingress/orchestration. */
  integrationPolicy?: IntegrationAccessRequest;
  activeTurnId?: string;
  lease?: ConversationLease;
  latestProgress?: ConversationProgress;
  /** Durable transcript used when a suspended MicroVM is no longer resumable. */
  context?: ArtifactReference;
  /** Durable manifest for files published into the conversation workspace. */
  artifacts?: ArtifactReference;
  /** Best-effort warm continuation; correctness never depends on this reference. */
  session?: ConversationSession;
}

export type ConversationSearchKind = 'message' | 'file';

/**
 * Bounded, encrypted DynamoDB search posting. Full prompt/result bodies remain
 * in S3; this contains only the token and a short owner-visible snippet.
 */
export interface ConversationSearchRecord {
  version: '1';
  itemType: 'search';
  ownerId: string;
  conversationId: string;
  entryId: string;
  token: string;
  kind: ConversationSearchKind;
  snippet: string;
  occurredAt: string;
  expiresAt: number;
  role?: 'user' | 'assistant';
  artifactId?: string;
}

export interface ConversationTranscriptRecord {
  version: '1';
  itemType: 'transcript';
  conversationId: string;
  entryId: string;
  role: 'user' | 'assistant';
  /** Immutable S3 body. User entries contain ConversationMessageContent; assistant entries are text. */
  contentKind: 'message' | 'text' | 'turn';
  content: ArtifactReference;
  occurredAt: string;
  expiresAt: number;
  messageId?: string;
}

export interface ConversationTranscriptMessage {
  interactions?: Array<{role: 'user' | 'assistant'; content: string; receivedAt?: string}>;
  role: 'user' | 'assistant';
  content: string;
  messageId?: string;
  receivedAt?: string;
  /** Stable opaque content IDs; storage coordinates never cross the API boundary. */
  attachmentIds?: string[];
  /** Optional durable reply edge to another public transcript message. */
  replyToMessageId?: string;
  reactions?: ConversationMessageReaction[];
}

export interface ConversationTranscriptPage {
  messages: ConversationTranscriptMessage[];
  nextToken?: string;
}

export interface ConversationMessageContent {
  text: string;
  /** Canonical caller/provider request used to reserve this message's public Run. */
  request?: RunRequest;
  /** Private durable files. Public projections expose only their opaque IDs. */
  attachments?: PublishedArtifact[];
  replyToMessageId?: string;
  metadata?: { [key: string]: JsonValue };
}

export const CONVERSATION_REACTION_EMOJIS = ['👍', '❤️', '🎉', '👀'] as const;
export type ConversationReactionEmoji = (typeof CONVERSATION_REACTION_EMOJIS)[number];

export interface ConversationReactionRecord {
  version: '1';
  itemType: 'reaction';
  conversationId: string;
  messageId: string;
  emoji: ConversationReactionEmoji;
  ownerId: string;
  createdAt: string;
  expiresAt: number;
}

export interface ConversationMessageReaction {
  emoji: ConversationReactionEmoji;
  count: number;
  reacted: boolean;
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
  /** Present when a queued Run is the recovery source for a missing mailbox write. */
  runId?: string;
  ownerId?: string;
}

export interface ConversationEventPayload {
  version: '1';
  type: ConversationEventType;
  data?: JsonValue;
}
