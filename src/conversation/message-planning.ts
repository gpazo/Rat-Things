import type { ArtifactReference } from '../domain/contracts.js';
import type { ConversationEventRecord, ConversationMessageRecord, ConversationRecord, ConversationTranscriptRecord } from '../domain/conversations.js';
import { canonicalJson, sha256Hex as digest } from '../domain/json.js';
import { searchPostings } from './search.js';
import type { ConversationStore } from './types.js';
import { assertIsoDate, validateExecutionPolicy, validateIntegrationPolicy, type AppendConversationMessageInput } from './validation.js';

const MAX_TITLE_CHARACTERS = 120;

export interface MessageContentPlan {
  key: string;
  encoded: string;
  contentHash: string;
  messageHash: string;
  createdAt: string;
  receivedAt: string;
  expiresAt: number;
}

/** Capture the content identity and timing before its storage write. */
export function messageContentPlan(input: AppendConversationMessageInput, now: Date, retentionSeconds: number): MessageContentPlan {
  const createdAt = now.toISOString();
  const receivedAt = input.receivedAt ?? createdAt;
  assertIsoDate(receivedAt, 'receivedAt');
  const expiresAt = expiry(now, retentionSeconds);
  const ownerHash = digest(input.ownerId).slice(0, 32);
  const conversationHash = digest(input.conversationId).slice(0, 32);
  const messageHash = digest(input.messageId).slice(0, 32);
  const encoded = canonicalJson(input.content);
  const contentHash = digest(encoded);
  return {
    key: `owners/${ownerHash}/conversations/${conversationHash}/messages/${messageHash}-${contentHash}.json`,
    encoded, contentHash, messageHash, createdAt, receivedAt, expiresAt,
  };
}

export type MessageRecords = Parameters<ConversationStore['appendMessage']>[0];

/** Build the mailbox records only after storing the content, keeping trusted policy validation here. */
export function messageRecords(input: AppendConversationMessageInput, planned: MessageContentPlan, content: ArtifactReference): MessageRecords {
  const { createdAt, receivedAt, expiresAt, messageHash, contentHash } = planned;
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
    ...(input.title || title(input.content.text) ? { title: input.title?.trim().slice(0, 128) || title(input.content.text) } : {}),
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
  return {
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
  };
}

export function expiry(now: Date, retentionSeconds: number): number {
  return Math.floor(now.getTime() / 1_000) + retentionSeconds;
}

export function preview(value: string): string {
  return value.trim().slice(0, 500);
}

function title(value: string): string {
  const line = value.trim().split(/\r?\n/, 1)[0]?.trim() ?? '';
  const limit = Math.min(MAX_TITLE_CHARACTERS, 64);
  return line.length <= limit ? line : `${line.slice(0, limit - 1).replace(/\s+\S*$/, '')}…`;
}
