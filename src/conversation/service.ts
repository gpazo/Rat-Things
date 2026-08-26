import { createHash, randomUUID } from 'node:crypto';
import type { ArtifactStore, Clock } from '../core/ports.js';
import { artifactIdForPath, validateArtifactCatalog, validateArtifactPath } from '../domain/artifacts.js';
import type {
  ArtifactCatalog,
  ArtifactReference,
  PublishedArtifact,
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
  ConversationReactionEmoji,
  ConversationResumeReason,
  ConversationSearchKind,
  ConversationSearchRecord,
  ConversationSession,
  ConversationTranscriptMessage,
  ConversationTranscriptPage,
  ConversationTranscriptRecord,
  ConversationTurnRecord,
} from '../domain/conversations.js';
import { CONVERSATION_REACTION_EMOJIS } from '../domain/conversations.js';
import { parseRunRequest } from '../domain/validation.js';
import {
  ConversationLeaseError,
  ConversationConflictError,
  ConversationStateError,
  type ConversationStore,
  type ConversationVisibility,
  type PendingMessageOptions,
} from './types.js';

const DEFAULT_RETENTION_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_LEASE_SECONDS = 90;
const MAX_TEXT_BYTES = 100_000;
const MAX_METADATA_BYTES = 32_000;
const MAX_PROGRESS_BYTES = 4_000;
const MAX_CONSUME_BATCH = 20;
const MAX_TITLE_CHARACTERS = 120;
const DEFAULT_TRANSCRIPT_LIMIT = 50;
const MAX_SEARCH_QUERY_BYTES = 512;
const MAX_SEARCH_QUERY_TOKENS = 8;
const MAX_SEARCH_DOCUMENT_TOKENS = 80;
const MAX_ASSISTANT_SEARCH_TOKENS = 60;
const MAX_SEARCH_SNIPPET_CHARACTERS = 280;
export const MAX_CONVERSATION_UPLOAD_FILES = 6;
export const MAX_CONVERSATION_UPLOAD_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_CONVERSATION_UPLOAD_TOTAL_BYTES = 6 * 1024 * 1024;

export interface ConversationAttachmentUpload {
  name: string;
  mediaType: string;
  bytes: Uint8Array;
  sha256: string;
}

export interface ConversationAttachmentManifest {
  version: '1';
  files: PublishedArtifact[];
}

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
      ...(title(input.content.text) ? { title: title(input.content.text) } : {}),
      ...(preview(input.content.text) ? { lastMessagePreview: preview(input.content.text) } : {}),
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
    const transcript: ConversationTranscriptRecord = {
      version: '1',
      itemType: 'transcript',
      conversationId: input.conversationId,
      entryId: `message-${messageHash}`,
      role: 'user',
      contentKind: 'message',
      content,
      occurredAt: receivedAt,
      expiresAt,
      messageId: input.messageId,
    };
    return this.options.store.appendMessage({
      conversation,
      message,
      transcript,
      event,
      search: searchPostings({
        ownerId: input.ownerId,
        conversationId: input.conversationId,
        entryId: transcript.entryId,
        kind: 'message',
        role: 'user',
        text: input.content.text,
        occurredAt: receivedAt,
        expiresAt,
      }),
    });
  }

  /**
   * Materializes API uploads as ordinary encrypted conversation artifacts.
   * The returned manifest is bound privately to the Run so the mailbox repair
   * path can reproduce the same message after a process crash.
   */
  public async prepareAttachments(input: {
    conversationId: string;
    ownerId: string;
    messageId: string;
    sourceRunId: string;
    uploads: ConversationAttachmentUpload[];
  }): Promise<{ files: PublishedArtifact[]; manifest: ArtifactReference }> {
    requiredId(input.conversationId, 'conversationId', 512);
    requiredId(input.ownerId, 'ownerId', 1_024);
    requiredId(input.messageId, 'messageId', 512);
    requiredId(input.sourceRunId, 'sourceRunId', 128);
    if (!Array.isArray(input.uploads) || input.uploads.length < 1 || input.uploads.length > MAX_CONVERSATION_UPLOAD_FILES) {
      throw new ConversationStateError(`attachments must contain 1-${MAX_CONVERSATION_UPLOAD_FILES} files`);
    }
    const current = await this.options.store.getConversation(input.conversationId);
    if (current && current.ownerId !== input.ownerId) {
      throw new ConversationConflictError('conversation belongs to another owner');
    }
    const ownerHash = digest(input.ownerId).slice(0, 32);
    const conversationHash = digest(input.conversationId).slice(0, 32);
    const messageHash = digest(input.messageId).slice(0, 32);
    const occurredAt = this.clock.now().toISOString();
    const paths = new Set<string>();
    let totalBytes = 0;
    const files: PublishedArtifact[] = [];
    for (const upload of input.uploads) {
      const name = safeUploadName(upload.name);
      const path = `uploads/${messageHash.slice(0, 12)}/${name}`;
      validateArtifactPath(path);
      if (paths.has(path)) throw new ConversationStateError(`attachment name ${name} is duplicated`);
      paths.add(path);
      if (!(upload.bytes instanceof Uint8Array) || upload.bytes.byteLength > MAX_CONVERSATION_UPLOAD_FILE_BYTES) {
        throw new ConversationStateError(`attachment ${name} exceeds ${MAX_CONVERSATION_UPLOAD_FILE_BYTES} bytes`);
      }
      totalBytes += upload.bytes.byteLength;
      if (totalBytes > MAX_CONVERSATION_UPLOAD_TOTAL_BYTES) {
        throw new ConversationStateError(`attachments exceed ${MAX_CONVERSATION_UPLOAD_TOTAL_BYTES} bytes`);
      }
      if (
        !/^[a-f0-9]{64}$/.test(upload.sha256) ||
        createHash('sha256').update(upload.bytes).digest('hex') !== upload.sha256
      ) {
        throw new ConversationStateError(`attachment ${name} checksum is invalid`);
      }
      const mediaType = safeMediaType(upload.mediaType);
      const file = await this.options.artifacts.putBytes(
        `owners/${ownerHash}/blobs/sha256/${upload.sha256}`,
        upload.bytes,
        mediaType,
      );
      files.push({
        id: artifactIdForPath(path),
        path,
        mediaType,
        bytes: upload.bytes.byteLength,
        createdAt: occurredAt,
        sourceRunId: input.sourceRunId,
        file,
      });
    }
    const catalog: ArtifactCatalog = { version: '1', files };
    try {
      validateArtifactCatalog(catalog);
    } catch (error) {
      throw new ConversationStateError(error instanceof Error ? error.message : 'attachments are invalid');
    }
    const encoded = canonicalJson(catalog);
    const manifest = await this.options.artifacts.putBytes(
      `owners/${ownerHash}/conversations/${conversationHash}/attachment-manifests/${messageHash}-${digest(encoded)}.json`,
      Buffer.from(encoded),
      'application/json',
    );
    return { files, manifest };
  }

  public async readAttachmentManifest(reference: ArtifactReference): Promise<ConversationAttachmentManifest> {
    const manifest = await this.options.artifacts.getJson<ConversationAttachmentManifest>(reference);
    try {
      validateArtifactCatalog(manifest);
    } catch (error) {
      throw new ConversationStateError(error instanceof Error ? error.message : 'attachment manifest is invalid');
    }
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
    try {
      validateArtifactCatalog({ version: '1', files: input.files });
    } catch (error) {
      throw new ConversationStateError(error instanceof Error ? error.message : 'attachments are invalid');
    }
    const previous = conversation.artifacts
      ? await this.options.artifacts.getJson<ArtifactCatalog>(conversation.artifacts)
      : { version: '1' as const, files: [] };
    try {
      validateArtifactCatalog(previous);
    } catch (error) {
      throw new ConversationStateError(error instanceof Error ? error.message : 'artifact catalog is invalid');
    }
    const byPath = new Map(previous.files.map((file) => [file.path, file]));
    for (const file of input.files) {
      const existing = byPath.get(file.path);
      if (existing && canonicalJson(existing) !== canonicalJson(file)) {
        throw new ConversationConflictError(`artifact path ${file.path} already has different content`);
      }
      byPath.set(file.path, file);
    }
    const catalog: ArtifactCatalog = {
      version: '1',
      files: [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path)),
    };
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
    update: { pinned?: boolean; hidden?: boolean; read?: boolean },
  ): Promise<ConversationRecord | undefined> {
    requiredId(ownerId, 'ownerId', 1_024);
    if (!/^[a-f0-9]{64}$/.test(publicId)) {
      throw new ConversationStateError('conversation ID must be a 64-character lowercase hex value');
    }
    if (
      !Object.keys(update).some((key) => ['pinned', 'hidden', 'read'].includes(key)) ||
      Object.values(update).some((value) => typeof value !== 'boolean')
    ) throw new ConversationStateError('organization update requires boolean pinned, hidden, or read fields');
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
    requiredId(ownerId, 'ownerId', 1_024);
    if (!/^[a-f0-9]{64}$/.test(publicId)) {
      throw new ConversationStateError('conversation ID must be a 64-character lowercase hex value');
    }
    const conversation = await this.options.store.getConversationByPublicId(publicId);
    if (!conversation || conversation.ownerId !== ownerId) return undefined;
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
    let transcriptMessages = (
      await Promise.all(transcriptRecords.items.map((record) => this.readTranscriptRecord(record)))
    ).filter((message): message is ConversationTranscriptMessage => message !== undefined).reverse();
    const reactionMessageIds = transcriptMessages.flatMap((message) => message.messageId ? [message.messageId] : []);
    if (reactionMessageIds.length > 0) {
      const reactions = await this.options.store.listReactions(
        conversation.conversationId,
        ownerId,
        reactionMessageIds,
      );
      const byMessage = new Map<string, typeof reactions>();
      for (const reaction of reactions) {
        const list = byMessage.get(reaction.messageId) ?? [];
        list.push(reaction);
        byMessage.set(reaction.messageId, list);
      }
      transcriptMessages = transcriptMessages.map((message) => {
        if (!message.messageId) return message;
        const records = byMessage.get(message.messageId) ?? [];
        const projected = CONVERSATION_REACTION_EMOJIS.flatMap((emoji) => {
          const matching = records.filter((record) => record.emoji === emoji);
          return matching.length > 0
            ? [{ emoji, count: matching.length, reacted: matching.some((record) => record.ownerId === ownerId) }]
            : [];
        });
        return projected.length > 0 ? { ...message, reactions: projected } : message;
      });
    }
    return {
      conversation,
      checkpoint,
      transcript: {
        messages: transcriptMessages,
        ...(transcriptRecords.nextToken ? { nextToken: transcriptRecords.nextToken } : {}),
      },
      ...(activeTurn ? { activeTurn } : {}),
    };
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
    const lastAssistantMessage = input.context
      ? [...input.context.messages].reverse().find(isAssistantTextMessage)
      : undefined;
    const transcript: ConversationTranscriptRecord | undefined = input.result ? {
      version: '1',
      itemType: 'transcript',
      conversationId: input.conversationId,
      entryId: `turn-${digest(input.turnId)}`,
      role: 'assistant',
      contentKind: 'text',
      content: input.result,
      occurredAt,
      expiresAt: conversation.expiresAt,
      messageId: `assistant-${digest(input.turnId).slice(0, 32)}`,
    } : undefined;
    const search = [
      ...(lastAssistantMessage ? searchPostings({
        ownerId: conversation.ownerId,
        conversationId: input.conversationId,
        entryId: `turn-${digest(input.turnId)}`,
        kind: 'message',
        role: 'assistant',
        text: lastAssistantMessage.content,
        occurredAt,
        expiresAt: conversation.expiresAt,
      }, MAX_ASSISTANT_SEARCH_TOKENS) : []),
      ...(input.artifactCatalog?.files.flatMap((file) => searchPostings({
        ownerId: conversation.ownerId,
        conversationId: input.conversationId,
        entryId: `turn-${digest(input.turnId)}-artifact-${file.id}`,
        kind: 'file',
        artifactId: file.id,
        text: file.path,
        occurredAt: file.createdAt,
        expiresAt: conversation.expiresAt,
      })) ?? []),
    ].slice(0, MAX_SEARCH_DOCUMENT_TOKENS);
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
    conversationId: string;
    turnId: string;
    leaseToken: string;
    error: RunError;
    context?: ConversationCheckpoint;
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
    return this.options.store.failTurn({
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

  private async readTranscriptRecord(
    record: ConversationTranscriptRecord,
  ): Promise<ConversationTranscriptMessage | undefined> {
    if (record.contentKind === 'message') {
      const message = await this.options.artifacts.getJson<ConversationMessageContent>(record.content);
      if (!message || typeof message.text !== 'string') return undefined;
      return {
        role: 'user',
        content: boundedTranscriptText(message.text),
        ...(record.messageId ? { messageId: record.messageId } : {}),
        receivedAt: record.occurredAt,
        ...(message.attachments?.length
          ? { attachmentIds: message.attachments.map((attachment) => attachment.id) }
          : {}),
        ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
      };
    }
    const bytes = await this.options.artifacts.getBytes(record.content);
    return {
      role: 'assistant',
      content: boundedTranscriptText(Buffer.from(bytes).toString('utf8')),
      ...(record.messageId ? { messageId: record.messageId } : {}),
      receivedAt: record.occurredAt,
    };
  }
}

function searchPostings(input: {
  ownerId: string;
  conversationId: string;
  entryId: string;
  kind: ConversationSearchKind;
  text: string;
  occurredAt: string;
  expiresAt: number;
  role?: 'user' | 'assistant';
  artifactId?: string;
}, tokenLimit = MAX_SEARCH_DOCUMENT_TOKENS): ConversationSearchRecord[] {
  const snippet = searchSnippet(input.text);
  return searchableTokens(input.text, tokenLimit).map((token) => ({
    version: '1',
    itemType: 'search',
    ownerId: input.ownerId,
    conversationId: input.conversationId,
    entryId: input.entryId,
    token,
    kind: input.kind,
    snippet,
    occurredAt: input.occurredAt,
    expiresAt: input.expiresAt,
    ...(input.role ? { role: input.role } : {}),
    ...(input.artifactId ? { artifactId: input.artifactId } : {}),
  }));
}

function searchableTokens(value: string, limit: number): string[] {
  const tokens = value.normalize('NFKC').toLocaleLowerCase('en-US')
    .match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) ?? [];
  return [...new Set(tokens.filter((token) => token.length >= 2).map((token) => token.slice(0, 64)))]
    .slice(0, limit);
}

function searchSnippet(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > MAX_SEARCH_SNIPPET_CHARACTERS
    ? `${compact.slice(0, MAX_SEARCH_SNIPPET_CHARACTERS - 1).trimEnd()}…`
    : compact;
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
  if (content.attachments?.length) {
    try {
      validateArtifactCatalog({ version: '1', files: content.attachments });
    } catch (error) {
      throw new ConversationStateError(error instanceof Error ? error.message : 'message attachments are invalid');
    }
  }
  if (content.replyToMessageId !== undefined) requiredId(content.replyToMessageId, 'replyToMessageId', 512);
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

function safeUploadName(value: string): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > 255) {
    throw new ConversationStateError('attachment name must be 1-255 bytes');
  }
  const name = value.normalize('NFKC').trim();
  if (name === '.' || name === '..' || /[\\/\0-\x1f\x7f]/.test(name)) {
    throw new ConversationStateError(`attachment name ${JSON.stringify(value)} is invalid`);
  }
  return name;
}

function safeMediaType(value: string): string {
  const mediaType = typeof value === 'string' && value.trim()
    ? value.trim().toLowerCase()
    : 'application/octet-stream';
  if (mediaType.length > 128 || /[\r\n]/.test(mediaType) || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mediaType)) {
    throw new ConversationStateError('attachment media type is invalid');
  }
  return mediaType;
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

function title(value: string): string {
  return value.trim().split(/\r?\n/, 1)[0]?.trim().slice(0, MAX_TITLE_CHARACTERS) ?? '';
}

function boundedTranscriptText(value: string): string {
  const bytes = Buffer.from(value, 'utf8');
  return bytes.byteLength <= MAX_TEXT_BYTES
    ? value
    : `${bytes.subarray(0, MAX_TEXT_BYTES).toString('utf8')}…`;
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
