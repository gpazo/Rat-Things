import type {
  ConversationEventRecord,
  ConversationLease,
  ConversationMessageRecord,
  ConversationRecord,
  ConversationReactionEmoji,
  ConversationReactionRecord,
  ConversationSearchRecord,
  ConversationTranscriptRecord,
  ConversationTurnRecord,
  ConversationWakeMessage,
} from '../domain/conversations.js';

export interface ConversationQueue {
  enqueue(message: ConversationWakeMessage): Promise<void>;
}

export interface AppendConversationMessageResult {
  status: 'appended' | 'duplicate';
  conversation: ConversationRecord;
  message: ConversationMessageRecord;
}

export type AcquireConversationLeaseResult =
  | { status: 'acquired'; conversation: ConversationRecord; lease: ConversationLease }
  | { status: 'active'; conversation: ConversationRecord }
  | { status: 'no_work'; conversation?: ConversationRecord };

export interface PendingMessageOptions {
  delivery?: ConversationMessageRecord['delivery'];
  limit?: number;
}

export interface ListConversationsResult {
  items: ConversationRecord[];
  nextToken?: string;
}

export type ConversationVisibility = 'visible' | 'hidden' | 'all';

export interface ConversationSearchHit {
  conversation: ConversationRecord;
  matches: ConversationSearchRecord[];
}

export interface ListConversationTranscriptResult {
  /** Newest-first storage page. Public projection reverses each page for reading order. */
  items: ConversationTranscriptRecord[];
  nextToken?: string;
}

export interface ConversationStore {
  getConversation(conversationId: string): Promise<ConversationRecord | undefined>;
  getConversationByPublicId(publicId: string): Promise<ConversationRecord | undefined>;
  list(
    ownerId: string,
    limit: number,
    nextToken?: string,
    visibility?: ConversationVisibility,
  ): Promise<ListConversationsResult>;
  updateOrganization(input: {
    conversationId: string;
    ownerId: string;
    pinned?: boolean;
    hidden?: boolean;
    read?: boolean;
    now: string;
  }): Promise<ConversationRecord>;
  search(ownerId: string, tokens: string[], limit: number): Promise<ConversationSearchHit[]>;
  getMessage(
    conversationId: string,
    messageId: string,
  ): Promise<ConversationMessageRecord | undefined>;
  appendMessage(input: {
    conversation: ConversationRecord;
    message: ConversationMessageRecord;
    transcript: ConversationTranscriptRecord;
    event: ConversationEventRecord;
    search: ConversationSearchRecord[];
  }): Promise<AppendConversationMessageResult>;
  updateArtifacts(input: {
    conversationId: string;
    artifacts: ConversationRecord['artifacts'];
    expectedToken: string;
    updatedAt: string;
  }): Promise<ConversationRecord>;
  setReaction(input: {
    conversationId: string;
    ownerId: string;
    messageId: string;
    emoji: ConversationReactionEmoji;
    reacted: boolean;
    createdAt: string;
    expiresAt: number;
  }): Promise<void>;
  listReactions(
    conversationId: string,
    ownerId: string,
    messageIds: string[],
  ): Promise<ConversationReactionRecord[]>;
  listPending(
    conversationId: string,
    options?: PendingMessageOptions,
  ): Promise<ConversationMessageRecord[]>;
  acquireLease(input: {
    conversationId: string;
    lease: ConversationLease;
    now: string;
  }): Promise<AcquireConversationLeaseResult>;
  checkIn(input: {
    conversationId: string;
    lease: ConversationLease;
    expectedToken: string;
    now: string;
  }): Promise<ConversationRecord>;
  releaseLease(input: {
    conversationId: string;
    expectedToken: string;
    updatedAt: string;
  }): Promise<ConversationRecord>;
  beginTurn(input: {
    turn: ConversationTurnRecord;
    event: ConversationEventRecord;
    leaseToken: string;
  }): Promise<ConversationTurnRecord>;
  attachRun(input: {
    conversationId: string;
    turnId: string;
    runId: string;
    event: ConversationEventRecord;
    leaseToken: string;
    updatedAt: string;
  }): Promise<ConversationTurnRecord>;
  scheduleRun(input: {
    conversationId: string;
    turnId: string;
    runId: string;
    messageIds: string[];
    runEvent: ConversationEventRecord;
    consumeEvent: ConversationEventRecord;
    leaseToken: string;
    updatedAt: string;
  }): Promise<ConversationTurnRecord>;
  resumeTurn(input: {
    conversationId: string;
    turnId: string;
    event: ConversationEventRecord;
    leaseToken: string;
    updatedAt: string;
  }): Promise<ConversationTurnRecord>;
  checkpointTurn(input: {
    conversationId: string;
    turnId: string;
    checkpoint: ConversationTurnRecord['checkpoint'];
    resumeReason: NonNullable<ConversationTurnRecord['resumeReason']>;
    event: ConversationEventRecord;
    leaseToken: string;
    updatedAt: string;
  }): Promise<ConversationTurnRecord>;
  reportProgress(input: {
    conversationId: string;
    turnId: string;
    progress: NonNullable<ConversationRecord['latestProgress']>;
    event: ConversationEventRecord;
    leaseToken: string;
  }): Promise<ConversationRecord>;
  consumeMessages(input: {
    conversationId: string;
    messageIds: string[];
    event: ConversationEventRecord;
    leaseToken: string;
    consumedAt: string;
  }): Promise<ConversationRecord>;
  completeTurn(input: {
    conversationId: string;
    turnId: string;
    result?: ConversationTurnRecord['result'];
    context?: ConversationRecord['context'];
    artifacts?: ConversationRecord['artifacts'];
    session?: ConversationRecord['session'];
    transcript?: ConversationTranscriptRecord;
    lastMessagePreview?: string;
    search?: ConversationSearchRecord[];
    event: ConversationEventRecord;
    leaseToken: string;
    completedAt: string;
  }): Promise<ConversationTurnRecord>;
  failTurn(input: {
    conversationId: string;
    turnId: string;
    error: NonNullable<ConversationTurnRecord['error']>;
    context?: ConversationRecord['context'];
    transcript?: ConversationTranscriptRecord;
    artifacts?: ConversationRecord['artifacts'];
    session?: ConversationRecord['session'];
    clearSession?: boolean;
    event: ConversationEventRecord;
    leaseToken: string;
    failedAt: string;
  }): Promise<ConversationTurnRecord>;
  getTurn(conversationId: string, turnId: string): Promise<ConversationTurnRecord | undefined>;
  listTranscript(
    conversationId: string,
    limit: number,
    nextToken?: string,
  ): Promise<ListConversationTranscriptResult>;
  listEvents(conversationId: string, limit?: number): Promise<ConversationEventRecord[]>;
}

export class ConversationConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ConversationConflictError';
  }
}

export class ConversationLeaseError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ConversationLeaseError';
  }
}

export class ConversationStateError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ConversationStateError';
  }
}
