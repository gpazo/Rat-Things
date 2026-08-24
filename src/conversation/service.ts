import { createHash, randomUUID } from 'node:crypto';
import type { ArtifactStore, Clock } from '../core/ports.js';
import { validateArtifactCatalog } from '../domain/artifacts.js';
import type {
  ArtifactCatalog,
  ArtifactReference,
  RunActorContext,
  RunCredentialSubjectContext,
  RunDestination,
  RunError,
  RunSource,
} from '../domain/contracts.js';
import type { IntegrationAccessRequest } from '../domain/capabilities.js';
import type {
  ConversationCheckpoint,
  ConversationDelivery,
  ConversationExecutionPolicy,
  ConversationEventRecord,
  ConversationEventType,
  ConversationMessageContent,
  ConversationMessageRecord,
  ConversationRecord,
  ConversationResumeReason,
  ConversationSession,
  ConversationTurnRecord,
} from '../domain/conversations.js';
import { parseRunRequest } from '../domain/validation.js';
import {
  ConversationLeaseError,
  ConversationStateError,
  type ConversationStore,
  type PendingMessageOptions,
} from './types.js';

const DEFAULT_RETENTION_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_LEASE_SECONDS = 90;
const MAX_TEXT_BYTES = 100_000;
const MAX_METADATA_BYTES = 32_000;
const MAX_PROGRESS_BYTES = 4_000;
const MAX_CONSUME_BATCH = 20;

export interface ConversationIds {
  random(): string;
}

export interface ConversationServiceOptions {
  store: ConversationStore;
  artifacts: ArtifactStore;
  retentionSeconds?: number;
  leaseSeconds?: number;
  clock?: Clock;
  ids?: ConversationIds;
}

export interface AppendConversationMessageInput {
  conversationId: string;
  ownerId: string;
  capabilityOwnerId?: string;
  messageId: string;
  /** Public Run reserved for this exact mailbox item before coordination. */
  runId?: string;
  delivery: ConversationDelivery;
  content: ConversationMessageContent;
  source: RunSource;
  destination: RunDestination;
  actor: RunActorContext;
  credentialSubject: RunCredentialSubjectContext;
  executionPolicy?: ConversationExecutionPolicy;
  integrationPolicy?: IntegrationAccessRequest;
  receivedAt?: string;
}

export class ConversationService {
  private readonly retentionSeconds: number;
  private readonly leaseSeconds: number;
  private readonly clock: Clock;
  private readonly ids: ConversationIds;

  public constructor(private readonly options: ConversationServiceOptions) {
    this.retentionSeconds = options.retentionSeconds ?? DEFAULT_RETENTION_SECONDS;
    this.leaseSeconds = options.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
    this.clock = options.clock ?? { now: () => new Date() };
    this.ids = options.ids ?? { random: () => randomUUID() };
  }

  public async appendMessage(input: AppendConversationMessageInput) {
    requiredId(input.conversationId, 'conversationId', 512);
    requiredId(input.ownerId, 'ownerId', 1_024);
    if (input.capabilityOwnerId) requiredId(input.capabilityOwnerId, 'capabilityOwnerId', 1_024);
    requiredId(input.messageId, 'messageId', 512);
    if (input.runId) requiredId(input.runId, 'runId', 128);
    validateMessageContent(input.content);
    if (input.delivery !== 'interrupt' && input.delivery !== 'defer') {
      throw new ConversationStateError('delivery must be interrupt or defer');
    }

    const now = this.clock.now();
    const createdAt = now.toISOString();
    const receivedAt = input.receivedAt ?? createdAt;
    assertIsoDate(receivedAt, 'receivedAt');
    const expiresAt = expiry(now, this.retentionSeconds);
    const ownerHash = digest(input.ownerId).slice(0, 32);
    const conversationHash = digest(input.conversationId).slice(0, 32);
    const messageHash = digest(input.messageId).slice(0, 32);
    const encoded = canonicalJson(input.content);
    const contentHash = digest(encoded);
    const content = await this.options.artifacts.putBytes(
      `owners/${ownerHash}/conversations/${conversationHash}/messages/${messageHash}-${contentHash}.json`,
      Buffer.from(encoded),
      'application/json',
    );
    const executionPolicy = input.executionPolicy
      ? validateExecutionPolicy(input.executionPolicy)
      : undefined;
    const integrationPolicy = input.integrationPolicy
      ? validateIntegrationPolicy(input.integrationPolicy)
      : undefined;
    const conversation: ConversationRecord = {
      version: '1',
      itemType: 'conversation',
      conversationId: input.conversationId,
      ownerId: input.ownerId,
      ...(input.capabilityOwnerId ? { capabilityOwnerId: input.capabilityOwnerId } : {}),
      status: 'pending',
      pendingCount: 1,
      createdAt,
      updatedAt: createdAt,
      expiresAt,
      source: input.source,
      destination: input.destination,
      actor: input.actor,
      credentialSubject: input.credentialSubject,
      ...(executionPolicy ? { executionPolicy } : {}),
      ...(integrationPolicy ? { integrationPolicy } : {}),
    };
    const message: ConversationMessageRecord = {
      version: '1',
      itemType: 'message',
      conversationId: input.conversationId,
      messageId: input.messageId,
      delivery: input.delivery,
      state: 'pending',
      actor: input.actor,
      credentialSubject: input.credentialSubject,
      source: input.source,
      destination: input.destination,
      content,
      contentHash,
      attemptCount: 0,
      createdAt,
      receivedAt,
      expiresAt,
      ...(input.runId ? { runId: input.runId } : {}),
    };
    const event: ConversationEventRecord = {
      version: '1',
      itemType: 'event',
      conversationId: input.conversationId,
      eventId: `message-${messageHash}`,
      type: 'message_received',
      occurredAt: createdAt,
      payload: content,
      expiresAt,
      messageId: input.messageId,
      preview: preview(input.content.text),
    };
    return this.options.store.appendMessage({ conversation, message, event });
  }

  public get(conversationId: string): Promise<ConversationRecord | undefined> {
    requiredId(conversationId, 'conversationId', 512);
    return this.options.store.getConversation(conversationId);
  }

  public getMessage(conversationId: string, messageId: string) {
    requiredId(conversationId, 'conversationId', 512);
    requiredId(messageId, 'messageId', 512);
    return this.options.store.getMessage(conversationId, messageId);
  }

  public async acquireLease(conversationId: string) {
    requiredId(conversationId, 'conversationId', 512);
    const now = this.clock.now();
    const lease = {
      token: this.ids.random(),
      acquiredAt: now.toISOString(),
      checkedInAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.leaseSeconds * 1_000).toISOString(),
    };
    return this.options.store.acquireLease({
      conversationId,
      lease,
      now: now.toISOString(),
    });
  }

  public async checkIn(conversationId: string, leaseToken: string) {
    const current = await this.requireLease(conversationId, leaseToken);
    const now = this.clock.now();
    const lease = {
      ...current.lease,
      checkedInAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.leaseSeconds * 1_000).toISOString(),
    };
    return this.options.store.checkIn({
      conversationId,
      lease,
      expectedToken: leaseToken,
      now: now.toISOString(),
    });
  }

  public async releaseLease(conversationId: string, leaseToken: string) {
    await this.requireLease(conversationId, leaseToken);
    return this.options.store.releaseLease({
      conversationId,
      expectedToken: leaseToken,
      updatedAt: this.clock.now().toISOString(),
    });
  }

  public async pending(
    conversationId: string,
    leaseToken: string,
    options: PendingMessageOptions = {},
  ) {
    await this.requireLease(conversationId, leaseToken);
    return this.options.store.listPending(conversationId, {
      ...options,
      limit: Math.max(1, Math.min(100, Math.floor(options.limit ?? 25))),
    });
  }

  public async beginTurn(input: {
    conversationId: string;
    leaseToken: string;
    runId?: string;
  }): Promise<ConversationTurnRecord> {
    const conversation = await this.requireLease(input.conversationId, input.leaseToken);
    if (conversation.activeTurnId) {
      throw new ConversationStateError(`conversation already has active turn ${conversation.activeTurnId}`);
    }
    const now = this.clock.now();
    const occurredAt = now.toISOString();
    const turnId = this.ids.random();
    const turn: ConversationTurnRecord = {
      version: '1',
      itemType: 'turn',
      conversationId: input.conversationId,
      turnId,
      state: 'running',
      slice: 0,
      startedAt: occurredAt,
      updatedAt: occurredAt,
      expiresAt: expiry(now, this.retentionSeconds),
      ...(input.runId ? { runId: input.runId } : {}),
    };
    const event = await this.event({
      conversation,
      type: 'turn_started',
      occurredAt,
      turnId,
      data: { turnId, slice: 0, ...(input.runId ? { runId: input.runId } : {}) },
    });
    return this.options.store.beginTurn({ turn, event, leaseToken: input.leaseToken });
  }

  public async attachRun(input: {
    conversationId: string;
    turnId: string;
    runId: string;
    leaseToken: string;
  }): Promise<ConversationTurnRecord> {
    const conversation = await this.requireLease(input.conversationId, input.leaseToken);
    requiredId(input.runId, 'runId', 128);
    const occurredAt = this.clock.now().toISOString();
    const event = await this.event({
      conversation,
      type: 'run_scheduled',
      occurredAt,
      turnId: input.turnId,
      data: { turnId: input.turnId, runId: input.runId },
    });
    return this.options.store.attachRun({
      conversationId: input.conversationId,
      turnId: input.turnId,
      runId: input.runId,
      event,
      leaseToken: input.leaseToken,
      updatedAt: occurredAt,
    });
  }

  /** Atomically binds a run and consumes exactly the mailbox messages included in its slice. */
  public async scheduleRun(input: {
    conversationId: string;
    turnId: string;
    runId: string;
    messageIds: string[];
    leaseToken: string;
  }): Promise<ConversationTurnRecord> {
    const conversation = await this.requireLease(input.conversationId, input.leaseToken);
    requiredId(input.runId, 'runId', 128);
    const messageIds = [...new Set(input.messageIds.map((id) => requiredId(id, 'messageId', 512)))];
    if (messageIds.length === 0 || messageIds.length > MAX_CONSUME_BATCH) {
      throw new ConversationStateError(`messageIds must contain 1-${MAX_CONSUME_BATCH} unique values`);
    }
    const occurredAt = this.clock.now().toISOString();
    const [runEvent, consumeEvent] = await Promise.all([
      this.event({
        conversation,
        type: 'run_scheduled',
        occurredAt,
        turnId: input.turnId,
        data: { turnId: input.turnId, runId: input.runId },
      }),
      this.event({
        conversation,
        type: 'messages_consumed',
        occurredAt,
        turnId: input.turnId,
        data: { messageIds },
      }),
    ]);
    return this.options.store.scheduleRun({
      conversationId: input.conversationId,
      turnId: input.turnId,
      runId: input.runId,
      messageIds,
      runEvent,
      consumeEvent,
      leaseToken: input.leaseToken,
      updatedAt: occurredAt,
    });
  }

  public async resumeTurn(input: {
    conversationId: string;
    turnId: string;
    leaseToken: string;
  }): Promise<ConversationTurnRecord> {
    const conversation = await this.requireLease(input.conversationId, input.leaseToken);
    const turn = await this.requiredTurn(input.conversationId, input.turnId);
    if (turn.state !== 'awaiting_resume' || !turn.checkpoint) {
      throw new ConversationStateError('turn is not resumable');
    }
    const occurredAt = this.clock.now().toISOString();
    const event = await this.event({
      conversation,
      type: 'turn_resumed',
      occurredAt,
      turnId: input.turnId,
      data: { turnId: input.turnId, fromSlice: turn.slice, reason: turn.resumeReason ?? 'retry' },
    });
    return this.options.store.resumeTurn({
      conversationId: input.conversationId,
      turnId: input.turnId,
      event,
      leaseToken: input.leaseToken,
      updatedAt: occurredAt,
    });
  }

  public async checkpointTurn(input: {
    conversationId: string;
    turnId: string;
    leaseToken: string;
    reason: ConversationResumeReason;
    checkpoint: ConversationCheckpoint;
  }): Promise<ConversationTurnRecord> {
    const conversation = await this.requireLease(input.conversationId, input.leaseToken);
    const turn = await this.requiredTurn(input.conversationId, input.turnId);
    if (turn.state !== 'running') throw new ConversationStateError('only a running turn can checkpoint');
    validateCheckpoint(input.checkpoint);
    const occurredAt = this.clock.now().toISOString();
    const checkpoint = await this.writeJson(
      conversation,
      `turns/${digest(input.turnId).slice(0, 32)}/slice-${String(turn.slice).padStart(4, '0')}.json`,
      input.checkpoint,
    );
    const event = this.eventRecord({
      conversation,
      type: 'turn_checkpointed',
      occurredAt,
      turnId: input.turnId,
      payload: checkpoint,
      preview: input.reason,
    });
    return this.options.store.checkpointTurn({
      conversationId: input.conversationId,
      turnId: input.turnId,
      checkpoint,
      resumeReason: input.reason,
      event,
      leaseToken: input.leaseToken,
      updatedAt: occurredAt,
    });
  }

  public async reportProgress(input: {
    conversationId: string;
    turnId: string;
    leaseToken: string;
    text: string;
  }): Promise<ConversationRecord> {
    const conversation = await this.requireLease(input.conversationId, input.leaseToken);
    const turn = await this.requiredTurn(input.conversationId, input.turnId);
    if (turn.state !== 'running') throw new ConversationStateError('progress requires a running turn');
    requiredText(input.text, 'progress', MAX_PROGRESS_BYTES);
    const occurredAt = this.clock.now().toISOString();
    const eventId = this.ids.random();
    const payload = await this.writeJson(conversation, `events/${digest(eventId)}.json`, {
      version: '1',
      type: 'progress_reported',
      data: { turnId: input.turnId, text: input.text },
    });
    const event = this.eventRecord({
      conversation,
      eventId,
      type: 'progress_reported',
      occurredAt,
      turnId: input.turnId,
      payload,
      preview: preview(input.text),
    });
    return this.options.store.reportProgress({
      conversationId: input.conversationId,
      turnId: input.turnId,
      progress: { eventId, text: input.text, reportedAt: occurredAt },
      event,
      leaseToken: input.leaseToken,
    });
  }

  public async consumeMessages(input: {
    conversationId: string;
    messageIds: string[];
    leaseToken: string;
  }): Promise<ConversationRecord> {
    const conversation = await this.requireLease(input.conversationId, input.leaseToken);
    const messageIds = [...new Set(input.messageIds.map((id) => requiredId(id, 'messageId', 512)))];
    if (messageIds.length === 0 || messageIds.length > MAX_CONSUME_BATCH) {
      throw new ConversationStateError(`messageIds must contain 1-${MAX_CONSUME_BATCH} unique values`);
    }
    const occurredAt = this.clock.now().toISOString();
    const event = await this.event({
      conversation,
      type: 'messages_consumed',
      occurredAt,
      data: { messageIds },
      ...(conversation.activeTurnId ? { turnId: conversation.activeTurnId } : {}),
    });
    return this.options.store.consumeMessages({
      conversationId: input.conversationId,
      messageIds,
      event,
      leaseToken: input.leaseToken,
      consumedAt: occurredAt,
    });
  }

  public async completeTurn(input: {
    conversationId: string;
    turnId: string;
    leaseToken: string;
    result?: ArtifactReference;
    context?: ConversationCheckpoint;
    artifactCatalog?: ArtifactCatalog;
    session?: ConversationSession;
  }): Promise<ConversationTurnRecord> {
    const conversation = await this.requireLease(input.conversationId, input.leaseToken);
    const occurredAt = this.clock.now().toISOString();
    if (input.context) validateCheckpoint(input.context);
    const context = input.context
      ? await this.writeJson(
          conversation,
          `context/${occurredAt.replace(/[:.]/g, '-')}-${digest(input.turnId).slice(0, 16)}.json`,
          input.context,
        )
      : undefined;
    const artifactCatalog = input.artifactCatalog
      ? await this.writeArtifactCatalog(conversation, input.turnId, occurredAt, input.artifactCatalog)
      : undefined;
    const event = await this.event({
      conversation,
      type: 'turn_completed',
      occurredAt,
      turnId: input.turnId,
      data: { turnId: input.turnId, ...(input.result ? { result: input.result } : {}) },
    });
    return this.options.store.completeTurn({
      conversationId: input.conversationId,
      turnId: input.turnId,
      result: input.result,
      context,
      artifacts: artifactCatalog,
      session: input.session,
      event,
      leaseToken: input.leaseToken,
      completedAt: occurredAt,
    });
  }

  public async failTurn(input: {
    conversationId: string;
    turnId: string;
    leaseToken: string;
    error: RunError;
  }): Promise<ConversationTurnRecord> {
    const conversation = await this.requireLease(input.conversationId, input.leaseToken);
    const occurredAt = this.clock.now().toISOString();
    const event = await this.event({
      conversation,
      type: 'turn_failed',
      occurredAt,
      turnId: input.turnId,
      data: { turnId: input.turnId, error: input.error },
    });
    return this.options.store.failTurn({
      conversationId: input.conversationId,
      turnId: input.turnId,
      error: input.error,
      event,
      leaseToken: input.leaseToken,
      failedAt: occurredAt,
    });
  }

  public getTurn(conversationId: string, turnId: string) {
    requiredId(conversationId, 'conversationId', 512);
    requiredId(turnId, 'turnId', 512);
    return this.options.store.getTurn(conversationId, turnId);
  }

  public history(conversationId: string, limit = 100) {
    requiredId(conversationId, 'conversationId', 512);
    return this.options.store.listEvents(conversationId, Math.max(1, Math.min(500, Math.floor(limit))));
  }

  private async requiredTurn(conversationId: string, turnId: string): Promise<ConversationTurnRecord> {
    const turn = await this.options.store.getTurn(conversationId, turnId);
    if (!turn) throw new ConversationStateError(`turn ${turnId} was not found`);
    return turn;
  }

  private async requireLease(conversationId: string, leaseToken: string): Promise<ConversationRecord & {
    lease: NonNullable<ConversationRecord['lease']>;
  }> {
    requiredId(conversationId, 'conversationId', 512);
    requiredId(leaseToken, 'leaseToken', 512);
    const conversation = await this.options.store.getConversation(conversationId);
    if (!conversation?.lease || conversation.lease.token !== leaseToken) {
      throw new ConversationLeaseError('conversation lease is not owned by this worker');
    }
    if (Date.parse(conversation.lease.expiresAt) <= this.clock.now().getTime()) {
      throw new ConversationLeaseError('conversation lease has expired');
    }
    return conversation as ConversationRecord & { lease: NonNullable<ConversationRecord['lease']> };
  }

  private async event(input: {
    conversation: ConversationRecord;
    type: ConversationEventType;
    occurredAt: string;
    data: unknown;
    turnId?: string;
    messageId?: string;
  }): Promise<ConversationEventRecord> {
    const eventId = this.ids.random();
    const payload = await this.writeJson(input.conversation, `events/${digest(eventId)}.json`, {
      version: '1',
      type: input.type,
      data: input.data,
    });
    return this.eventRecord({ ...input, eventId, payload });
  }

  private eventRecord(input: {
    conversation: ConversationRecord;
    type: ConversationEventType;
    occurredAt: string;
    payload: ArtifactReference;
    eventId?: string;
    turnId?: string;
    messageId?: string;
    preview?: string;
  }): ConversationEventRecord {
    return {
      version: '1',
      itemType: 'event',
      conversationId: input.conversation.conversationId,
      eventId: input.eventId ?? this.ids.random(),
      type: input.type,
      occurredAt: input.occurredAt,
      payload: input.payload,
      expiresAt: input.conversation.expiresAt,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.messageId ? { messageId: input.messageId } : {}),
      ...(input.preview ? { preview: input.preview } : {}),
    };
  }

  private writeJson(conversation: ConversationRecord, suffix: string, value: unknown) {
    const ownerHash = digest(conversation.ownerId).slice(0, 32);
    const conversationHash = digest(conversation.conversationId).slice(0, 32);
    const encoded = canonicalJson(value);
    const contentHash = digest(encoded);
    const normalizedSuffix = suffix.replace(/\.json$/, `-${contentHash}.json`);
    return this.options.artifacts.putBytes(
      `owners/${ownerHash}/conversations/${conversationHash}/${normalizedSuffix}`,
      Buffer.from(encoded),
      'application/json',
    );
  }

  private writeArtifactCatalog(
    conversation: ConversationRecord,
    turnId: string,
    occurredAt: string,
    catalog: ArtifactCatalog,
  ): Promise<ArtifactReference> {
    try {
      validateArtifactCatalog(catalog);
    } catch (error) {
      throw new ConversationStateError(
        error instanceof Error ? error.message : 'artifact catalog is invalid',
      );
    }
    return this.writeJson(
      conversation,
      `artifacts/${occurredAt.replace(/[:.]/g, '-')}-${digest(turnId).slice(0, 16)}.json`,
      catalog,
    );
  }
}

function validateExecutionPolicy(input: ConversationExecutionPolicy): ConversationExecutionPolicy {
  if ('outputSchema' in (input as Record<string, unknown>)) {
    throw new ConversationStateError('conversation execution policy cannot define an output schema');
  }
  const parsed = parseRunRequest({
    version: '1',
    prompt: 'validate trusted conversation execution policy',
    agent: input,
  }).agent;
  if (!parsed) throw new ConversationStateError('conversation execution policy is invalid');
  return {
    ...(parsed.driver ? { driver: parsed.driver } : {}),
    ...(parsed.model ? { model: parsed.model } : {}),
    ...(parsed.sandbox ? { sandbox: parsed.sandbox } : {}),
    ...(parsed.reasoningEffort ? { reasoningEffort: parsed.reasoningEffort } : {}),
    ...(parsed.reasoningSummary ? { reasoningSummary: parsed.reasoningSummary } : {}),
    ...(parsed.personality ? { personality: parsed.personality } : {}),
    ...(parsed.capabilities ? { capabilities: parsed.capabilities } : {}),
  };
}

function validateIntegrationPolicy(input: IntegrationAccessRequest): IntegrationAccessRequest {
  const parsed = parseRunRequest({
    version: '1',
    prompt: 'validate trusted conversation integration policy',
    integrations: input,
  }).integrations;
  if (!parsed) throw new ConversationStateError('conversation integration policy is invalid');
  return parsed;
}

function expiry(now: Date, retentionSeconds: number): number {
  return Math.floor(now.getTime() / 1_000) + retentionSeconds;
}

function requiredId(value: string, label: string, maxBytes: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new ConversationStateError(`${label} is required`);
  if (Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new ConversationStateError(`${label} exceeds ${maxBytes} bytes`);
  }
  return value;
}

function requiredText(value: string, label: string, maxBytes: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new ConversationStateError(`${label} is required`);
  if (Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new ConversationStateError(`${label} exceeds ${maxBytes} bytes`);
  }
  return value;
}

function validateMessageContent(content: ConversationMessageContent): void {
  const hasText = typeof content.text === 'string' && content.text.trim().length > 0;
  const hasAttachments = Array.isArray(content.attachments) && content.attachments.length > 0;
  if (!hasText && !hasAttachments) throw new ConversationStateError('message requires text or attachments');
  if (Buffer.byteLength(content.text, 'utf8') > MAX_TEXT_BYTES) {
    throw new ConversationStateError(`message text exceeds ${MAX_TEXT_BYTES} bytes`);
  }
  if ((content.attachments?.length ?? 0) > 20) {
    throw new ConversationStateError('message supports at most 20 attachment references');
  }
  if (content.metadata && Buffer.byteLength(canonicalJson(content.metadata), 'utf8') > MAX_METADATA_BYTES) {
    throw new ConversationStateError(`message metadata exceeds ${MAX_METADATA_BYTES} bytes`);
  }
  if (content.request) {
    let parsed;
    try {
      parsed = parseRunRequest(content.request);
    } catch (error) {
      throw new ConversationStateError(
        error instanceof Error ? error.message : 'message request is invalid',
      );
    }
    if (parsed.prompt !== content.text) {
      throw new ConversationStateError('message text must match its canonical Run prompt');
    }
  }
}

function validateCheckpoint(checkpoint: ConversationCheckpoint): void {
  if (checkpoint.version !== '1' || !Array.isArray(checkpoint.messages)) {
    throw new ConversationStateError('checkpoint must be a version 1 message array');
  }
  const bytes = Buffer.byteLength(canonicalJson(checkpoint), 'utf8');
  if (bytes > 5_000_000) throw new ConversationStateError('checkpoint exceeds 5000000 bytes');
}

function assertIsoDate(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new ConversationStateError(`${label} must be an ISO date`);
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function preview(value: string): string {
  return value.trim().slice(0, 500);
}
