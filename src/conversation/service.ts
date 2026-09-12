import { randomUUID } from 'node:crypto';
import type { ArtifactStore, Clock } from '../core/ports.js';
import type {
  ArtifactCatalog,
  ArtifactReference,
  PublishedArtifact,
  RunError,
} from '../domain/contracts.js';
import type {
  ConversationCheckpoint,
  ConversationEventRecord,
  ConversationEventType,
  ConversationMessageContent,
  ConversationRecord,
  ConversationReactionEmoji,
  ConversationResumeReason,
  ConversationSession,
  ConversationTranscriptMessage,
  ConversationTranscriptPage,
  ConversationTranscriptRecord,
  ConversationTurnRecord,
} from '../domain/conversations.js';
import { canonicalJson, sha256Hex as digest } from '../domain/json.js';
import { CONVERSATION_REACTION_EMOJIS } from '../domain/conversations.js';
import {
  attachmentManifestPlan,
  mergeAttachmentCatalog,
  planAttachmentUpload,
  publishedAttachment,
  validateAttachmentInput,
  type AttachmentBatch,
  type ConversationAttachmentManifest,
  type PrepareAttachmentsInput,
} from './attachments.js';
import { expiry, messageContentPlan, messageRecords, preview } from './message-planning.js';
import {
  chronologicalMessages,
  textTranscriptMessage,
  transcriptCompletions,
  turnTranscriptMessage,
  userTranscriptMessage,
  withMessageReactions,
} from './history-projection.js';
import {
  completedTurnSearch,
  MAX_SEARCH_QUERY_BYTES,
  MAX_SEARCH_QUERY_TOKENS,
  searchableTokens,
} from './search.js';
import {
  ConversationLeaseError,
  ConversationConflictError,
  ConversationStateError,
  type ConversationStore,
  type ConversationVisibility,
  type PendingMessageOptions,
} from './types.js';
import {
  MAX_TEXT_BYTES,
  requiredId,
  requiredText,
  uniqueMessageIds,
  validateCheckpoint,
  validateConversationArtifactCatalog,
  validateMessageInput,
  type AppendConversationMessageInput,
} from './validation.js';

const DEFAULT_RETENTION_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_LEASE_SECONDS = 90;
const MAX_PROGRESS_BYTES = 4_000;
const DEFAULT_TRANSCRIPT_LIMIT = 50;
export {
  MAX_CONVERSATION_UPLOAD_FILES,
  MAX_CONVERSATION_UPLOAD_FILE_BYTES,
  MAX_CONVERSATION_UPLOAD_TOTAL_BYTES,
  type ConversationAttachmentUpload,
  type ConversationAttachmentManifest,
} from './attachments.js';
export type { AppendConversationMessageInput } from './validation.js';

export interface ConversationIds {
  random(): string;
}

export interface ConversationServiceOptions {
  store: ConversationStore;
  artifacts: Pick<ArtifactStore, 'putBytes' | 'getJson' | 'getBytes'>;
  retentionSeconds?: number;
  leaseSeconds?: number;
  clock?: Clock;
  ids?: ConversationIds;
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
    validateMessageInput(input);
    const planned = messageContentPlan(input, this.clock.now(), this.retentionSeconds);
    const content = await this.options.artifacts.putBytes(planned.key, Buffer.from(planned.encoded), 'application/json');
    const records = messageRecords(input, planned, content);
    return this.options.store.appendMessage(records);
  }

  /**
   * Materializes API uploads as ordinary encrypted conversation artifacts.
   * The returned manifest is bound privately to the Run so the mailbox repair
   * path can reproduce the same message after a process crash.
   */
  public async prepareAttachments(input: PrepareAttachmentsInput): Promise<{ files: PublishedArtifact[]; manifest: ArtifactReference }> {
    validateAttachmentInput(input);
    const current = await this.options.store.getConversation(input.conversationId);
    if (current && current.ownerId !== input.ownerId) {
      throw new ConversationConflictError('conversation belongs to another owner');
    }
    const ownerHash = digest(input.ownerId).slice(0, 32);
    const conversationHash = digest(input.conversationId).slice(0, 32);
    const messageHash = digest(input.messageId).slice(0, 32);
    const occurredAt = this.clock.now().toISOString();
    let batch: AttachmentBatch = { paths: [], totalBytes: 0 };
    const files: PublishedArtifact[] = [];
    for (const upload of input.uploads) {
      const plan = planAttachmentUpload(upload, messageHash, batch);
      batch = plan.batch;
      const file = await this.options.artifacts.putBytes(
        `owners/${ownerHash}/blobs/sha256/${upload.sha256}`,
        upload.bytes,
        plan.mediaType,
      );
      files.push(publishedAttachment(plan, upload.bytes.byteLength, occurredAt, input.sourceRunId, file));
    }
    const planned = attachmentManifestPlan(ownerHash, conversationHash, messageHash, files);
    const manifest = await this.options.artifacts.putBytes(planned.key, Buffer.from(planned.encoded), 'application/json');
    return { files, manifest };
  }

  public async readAttachmentManifest(reference: ArtifactReference): Promise<ConversationAttachmentManifest> {
    const manifest = await this.options.artifacts.getJson<ConversationAttachmentManifest>(reference);
    validateConversationArtifactCatalog(manifest, 'attachment manifest is invalid');
    return manifest;
  }

  /** Merges pending message files into the durable workspace while holding its lease. */
  public async attachArtifacts(input: {
    conversationId: string;
    leaseToken: string;
    files: PublishedArtifact[];
  }): Promise<ConversationRecord> {
    const conversation = await this.requireLease(input.conversationId, input.leaseToken);
    if (input.files.length === 0) return conversation;
    validateConversationArtifactCatalog({ version: '1', files: input.files }, 'attachments are invalid');
    const previous = conversation.artifacts
      ? await this.options.artifacts.getJson<ArtifactCatalog>(conversation.artifacts)
      : { version: '1' as const, files: [] };
    validateConversationArtifactCatalog(previous, 'artifact catalog is invalid');
    const catalog = mergeAttachmentCatalog(previous, input.files);
    const occurredAt = this.clock.now().toISOString();
    const artifacts = await this.writeArtifactCatalog(
      conversation,
      `attachments-${digest(input.files.map((file) => file.id).join('\u0000')).slice(0, 32)}`,
      occurredAt,
      catalog,
    );
    return this.options.store.updateArtifacts({
      conversationId: input.conversationId,
      artifacts,
      expectedToken: input.leaseToken,
      updatedAt: occurredAt,
    });
  }

  public async setReaction(
    ownerId: string,
    publicId: string,
    messageId: string,
    emoji: ConversationReactionEmoji,
    reacted: boolean,
  ): Promise<boolean> {
    requiredId(ownerId, 'ownerId', 1_024);
    requiredId(messageId, 'messageId', 512);
    if (!/^[a-f0-9]{64}$/.test(publicId)) {
      throw new ConversationStateError('conversation ID must be a 64-character lowercase hex value');
    }
    if (!CONVERSATION_REACTION_EMOJIS.includes(emoji)) {
      throw new ConversationStateError('reaction emoji is not supported');
    }
    const conversation = await this.options.store.getConversationByPublicId(publicId);
    if (!conversation || conversation.ownerId !== ownerId) return false;
    const now = this.clock.now();
    await this.options.store.setReaction({
      conversationId: conversation.conversationId,
      ownerId,
      messageId,
      emoji,
      reacted,
      createdAt: now.toISOString(),
      expiresAt: expiry(now, this.retentionSeconds),
    });
    return true;
  }

  public get(conversationId: string): Promise<ConversationRecord | undefined> {
    requiredId(conversationId, 'conversationId', 512);
    return this.options.store.getConversation(conversationId);
  }

  public list(
    ownerId: string,
    limit = 25,
    nextToken?: string,
    visibility: ConversationVisibility = 'visible',
  ) {
    requiredId(ownerId, 'ownerId', 1_024);
    if (!['visible', 'hidden', 'all'].includes(visibility)) {
      throw new ConversationStateError('visibility must be visible, hidden, or all');
    }
    const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    return this.options.store.list(ownerId, boundedLimit, nextToken, visibility);
  }

  public async updateOrganization(
    ownerId: string,
    publicId: string,
    update: { title?: string; pinned?: boolean; hidden?: boolean; read?: boolean },
  ): Promise<ConversationRecord | undefined> {
    requiredId(ownerId, 'ownerId', 1_024);
    if (!/^[a-f0-9]{64}$/.test(publicId)) {
      throw new ConversationStateError('conversation ID must be a 64-character lowercase hex value');
    }
    if (
      !Object.keys(update).length ||
      Object.entries(update).some(([key, value]) => key === 'title' ? typeof value !== 'string' : !['pinned', 'hidden', 'read'].includes(key) || typeof value !== 'boolean')
    ) throw new ConversationStateError('organization update requires a title or boolean pinned, hidden, or read fields');
    if (update.title !== undefined && update.title.trim().length > 128) throw new ConversationStateError('title exceeds 128 characters');
    if (update.title !== undefined) update = {...update, title: requiredText(update.title, 'title', 512).trim()};
    const conversation = await this.options.store.getConversationByPublicId(publicId);
    if (!conversation || conversation.ownerId !== ownerId) return undefined;
    return this.options.store.updateOrganization({
      conversationId: conversation.conversationId,
      ownerId,
      ...update,
      now: this.clock.now().toISOString(),
    });
  }

  public search(ownerId: string, query: string, limit = 20) {
    requiredId(ownerId, 'ownerId', 1_024);
    const value = requiredText(query, 'query', MAX_SEARCH_QUERY_BYTES);
    const tokens = searchableTokens(value, MAX_SEARCH_QUERY_TOKENS);
    if (tokens.length === 0) {
      throw new ConversationStateError('query must contain at least one searchable letter or number');
    }
    return this.options.store.search(
      ownerId,
      tokens,
      Math.max(1, Math.min(50, Math.floor(limit))),
    );
  }

  public async getPublicDetail(
    ownerId: string,
    publicId: string,
    options: { limit?: number; nextToken?: string } = {},
  ): Promise<{
    conversation: ConversationRecord;
    checkpoint: ConversationCheckpoint;
    transcript: ConversationTranscriptPage;
    activeTurn?: ConversationTurnRecord;
  } | undefined> {
    const conversation = await this.getByPublicId(ownerId, publicId);
    if (!conversation) return undefined;
    const limit = Math.max(
      1,
      Math.min(100, Math.floor(options.limit ?? DEFAULT_TRANSCRIPT_LIMIT)),
    );
    const [checkpoint, activeTurn, transcriptRecords] = await Promise.all([
      conversation.context
        ? this.options.artifacts.getJson<ConversationCheckpoint>(conversation.context)
        : Promise.resolve({ version: '1' as const, messages: [] }),
      conversation.activeTurnId
        ? this.options.store.getTurn(conversation.conversationId, conversation.activeTurnId)
        : Promise.resolve(undefined),
      this.options.store.listTranscript(
        conversation.conversationId,
        limit,
        options.nextToken,
      ),
    ]);
    const assistantRecords = transcriptRecords.items.filter(record => record.role === 'assistant');
    const turns = await Promise.all(assistantRecords.map(record => this.options.store.getTranscriptTurn(record)));
    const completions = transcriptCompletions(assistantRecords.map((record, index) => ({
      record, turn: turns[index],
    })));
    let transcriptMessages = chronologicalMessages(
      await Promise.all(transcriptRecords.items.map((record) => this.readTranscriptRecord(record))),
    );
    const reactionMessageIds = transcriptMessages.flatMap((message) => message.messageId ? [message.messageId] : []);
    if (reactionMessageIds.length > 0) {
      const reactions = await this.options.store.listReactions(
        conversation.conversationId,
        ownerId,
        reactionMessageIds,
      );
      transcriptMessages = withMessageReactions(transcriptMessages, reactions, ownerId);
    }
    return {
      conversation,
      checkpoint,
      transcript: {
        messages: transcriptMessages,
        completions,
        ...(transcriptRecords.nextToken ? { nextToken: transcriptRecords.nextToken } : {}),
      },
      ...(activeTurn ? { activeTurn } : {}),
    };
  }

  public async getByPublicId(
    ownerId: string,
    publicId: string,
  ): Promise<ConversationRecord | undefined> {
    requiredId(ownerId, 'ownerId', 1_024);
    if (!/^[a-f0-9]{64}$/.test(publicId)) {
      throw new ConversationStateError('conversation ID must be a 64-character lowercase hex value');
    }
    const conversation = await this.options.store.getConversationByPublicId(publicId);
    return conversation?.ownerId === ownerId ? conversation : undefined;
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
    const messageIds = uniqueMessageIds(input.messageIds);
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
    const messageIds = uniqueMessageIds(input.messageIds);
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
    runStatus?: 'succeeded' | 'cancelled';
    transcriptMessages?: ConversationTranscriptMessage[];
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
    const lastAssistantMessage = input.context
      ? [...input.context.messages].reverse().find(isAssistantTextMessage)
      : undefined;
    const transcriptContent = input.transcriptMessages?.length
      ? await this.writeJson(conversation, `transcripts/${digest(input.turnId)}.json`, input.transcriptMessages)
      : input.result ?? await this.writeJson(conversation, `transcripts/${digest(input.turnId)}.json`, []);
    const transcript: ConversationTranscriptRecord = {
      version: '1',
      itemType: 'transcript',
      conversationId: input.conversationId,
      entryId: `turn-${digest(input.turnId)}`,
      turnId: input.turnId,
      role: 'assistant',
      runStatus: input.runStatus ?? 'succeeded',
      contentKind: input.transcriptMessages?.length || !input.result ? 'turn' : 'text',
      content: transcriptContent,
      occurredAt,
      expiresAt: conversation.expiresAt,
      messageId: `assistant-${digest(input.turnId).slice(0, 32)}`,
    };
    const search = completedTurnSearch({
      ownerId: conversation.ownerId,
      conversationId: input.conversationId,
      turnId: input.turnId,
      assistantText: lastAssistantMessage?.content,
      artifactCatalog: input.artifactCatalog,
      occurredAt,
      expiresAt: conversation.expiresAt,
    });
    return this.options.store.completeTurn({
      conversationId: input.conversationId,
      turnId: input.turnId,
      result: input.result,
      context,
      artifacts: artifactCatalog,
      session: input.session,
      ...(transcript ? { transcript } : {}),
      ...(lastAssistantMessage
        ? { lastMessagePreview: preview(lastAssistantMessage.content) }
        : {}),
      ...(search.length > 0 ? { search } : {}),
      event,
      leaseToken: input.leaseToken,
      completedAt: occurredAt,
    });
  }

  public async failTurn(input: {
    runStatus?: 'failed' | 'cancelled';
    conversationId: string;
    turnId: string;
    leaseToken: string;
    error: RunError;
    context?: ConversationCheckpoint;
    transcriptMessages?: ConversationTranscriptMessage[];
    artifactCatalog?: ArtifactCatalog;
    session?: ConversationSession;
    clearSession?: boolean;
  }): Promise<ConversationTurnRecord> {
    const conversation = await this.requireLease(input.conversationId, input.leaseToken);
    const occurredAt = this.clock.now().toISOString();
    if (input.context) validateCheckpoint(input.context);
    const context = input.context
      ? await this.writeJson(
          conversation,
          `context/${occurredAt.replace(/[:.]/g, '-')}-${digest(input.turnId).slice(0, 16)}-failed.json`,
          input.context,
        )
      : undefined;
    const event = await this.event({
      conversation,
      type: 'turn_failed',
      occurredAt,
      turnId: input.turnId,
      data: { turnId: input.turnId, error: input.error },
    });
    const transcript: ConversationTranscriptRecord = {
      version: '1', itemType: 'transcript', conversationId: input.conversationId,
      entryId: `turn-${digest(input.turnId)}`, turnId: input.turnId, runStatus: input.runStatus ?? 'failed', role: 'assistant', contentKind: 'turn',
      content: await this.writeJson(conversation, `transcripts/${digest(input.turnId)}.json`, input.transcriptMessages?.length ? input.transcriptMessages : []),
      occurredAt, expiresAt: conversation.expiresAt,
    };
    const artifacts = input.artifactCatalog
      ? await this.writeArtifactCatalog(conversation, input.turnId, occurredAt, input.artifactCatalog) : undefined;
    return this.options.store.failTurn({
      ...(transcript ? { transcript } : {}),
      ...(artifacts ? { artifacts } : {}),
      ...(input.session && !input.clearSession ? { session: input.session } : {}),
      conversationId: input.conversationId,
      turnId: input.turnId,
      error: input.error,
      ...(context ? { context } : {}),
      ...(input.clearSession ? { clearSession: true } : {}),
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
    validateConversationArtifactCatalog(catalog, 'artifact catalog is invalid');
    return this.writeJson(
      conversation,
      `artifacts/${occurredAt.replace(/[:.]/g, '-')}-${digest(turnId).slice(0, 16)}.json`,
      catalog,
    );
  }

  private async readTranscriptRecord(
    record: ConversationTranscriptRecord,
  ): Promise<ConversationTranscriptMessage | undefined> {
    if (record.contentKind === 'turn') {
      const entries = await this.options.artifacts.getJson<ConversationTranscriptMessage[]>(record.content);
      return turnTranscriptMessage(record, entries, MAX_TEXT_BYTES);
    }
    if (record.contentKind === 'message') {
      const message = await this.options.artifacts.getJson<ConversationMessageContent>(record.content);
      return userTranscriptMessage(record, message, MAX_TEXT_BYTES);
    }
    const bytes = await this.options.artifacts.getBytes(record.content);
    return textTranscriptMessage(record, Buffer.from(bytes).toString('utf8'), MAX_TEXT_BYTES);
  }
}

function isAssistantTextMessage(
  value: unknown,
): value is { role: 'assistant'; content: string } {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).role === 'assistant' &&
    typeof (value as Record<string, unknown>).content === 'string',
  );
}
