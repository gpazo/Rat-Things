import { createHash } from 'node:crypto';
import type { JsonValue } from '../domain/contracts.js';
import type {
  ConversationCheckpoint,
  ConversationRecord,
  ConversationSearchRecord,
  ConversationTranscriptPage,
  ConversationTurnRecord,
} from '../domain/conversations.js';

export interface PublicConversationSummary {
  conversationId: string;
  title: string;
  threadKey?: string;
  status: ConversationRecord['status'];
  pendingCount: number;
  sourceKind: ConversationRecord['source']['kind'];
  createdAt: string;
  updatedAt: string;
  pinned: boolean;
  hidden: boolean;
  unread: boolean;
  lastMessagePreview?: string;
  latestProgress?: ConversationRecord['latestProgress'];
  session?: Pick<NonNullable<ConversationRecord['session']>, 'backend' | 'state' | 'updatedAt' | 'expiresAt'>;
}

export interface PublicConversationSearchHit {
  conversation: PublicConversationSummary;
  matches: Array<{
    kind: 'message' | 'file';
    snippet: string;
    occurredAt: string;
    role?: 'user' | 'assistant';
    artifactId?: string;
  }>;
}

export interface PublicConversationMessage {
  interactions?: Array<{role: 'user' | 'assistant'; content: string; receivedAt?: string}>;
  role: 'user' | 'assistant';
  content: string;
  messageId?: string;
  receivedAt?: string;
  attachments?: Array<{ id: string }>;
  replyToMessageId?: string;
  reactions?: Array<{ emoji: string; count: number; reacted: boolean }>;
}

export interface PublicConversationDetail extends PublicConversationSummary {
  activeRunId?: string;
  executionPolicy?: ConversationRecord['executionPolicy'];
  transcript: {
    messages: PublicConversationMessage[];
    compactedMessages: number;
    nextToken?: string;
  };
}

export function projectPublicConversation(
  conversation: ConversationRecord,
): PublicConversationSummary {
  const threadKey = apiThreadKey(conversation);
  return {
    conversationId: publicConversationId(conversation.conversationId),
    title: conversation.title ?? threadKey ?? `${sourceLabel(conversation.source.kind)} conversation`,
    ...(threadKey ? { threadKey } : {}),
    status: conversation.status,
    pendingCount: conversation.pendingCount,
    sourceKind: conversation.source.kind,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    pinned: Boolean(conversation.pinnedAt),
    hidden: Boolean(conversation.hiddenAt),
    unread: conversationUnread(conversation),
    ...(conversation.lastMessagePreview
      ? { lastMessagePreview: conversation.lastMessagePreview }
      : {}),
    ...(conversation.latestProgress
      ? { latestProgress: { ...conversation.latestProgress } }
      : {}),
    ...(conversation.session ? {
      session: {
        backend: conversation.session.backend,
        state: conversation.session.state,
        updatedAt: conversation.session.updatedAt,
        ...(conversation.session.expiresAt ? { expiresAt: conversation.session.expiresAt } : {}),
      },
    } : {}),
  };
}

export function projectPublicConversationSearchHit(
  hit: { conversation: ConversationRecord; matches: ConversationSearchRecord[] },
): PublicConversationSearchHit {
  return {
    conversation: projectPublicConversation(hit.conversation),
    matches: hit.matches.map((match) => ({
      kind: match.kind,
      snippet: match.snippet,
      occurredAt: match.occurredAt,
      ...(match.role ? { role: match.role } : {}),
      ...(match.artifactId ? { artifactId: match.artifactId } : {}),
    })),
  };
}

export function projectPublicConversationDetail(
  conversation: ConversationRecord,
  checkpoint: ConversationCheckpoint,
  transcript: ConversationTranscriptPage,
  activeTurn?: ConversationTurnRecord,
): PublicConversationDetail {
  return {
    ...projectPublicConversation(conversation),
    ...(conversation.executionPolicy ? { executionPolicy: conversation.executionPolicy } : {}),
    ...(activeTurn?.runId ? { activeRunId: activeTurn.runId } : {}),
    transcript: {
      messages: transcript.messages.length > 0 || transcript.nextToken
        ? transcript.messages.map((message) => ({
            role: message.role,
            content: message.content,
            ...(message.interactions?.length ? { interactions: message.interactions.map(entry => ({...entry})) } : {}),
            ...(message.messageId ? { messageId: message.messageId } : {}),
            ...(message.receivedAt ? { receivedAt: message.receivedAt } : {}),
            ...(message.attachmentIds?.length
              ? { attachments: message.attachmentIds.map((id) => ({ id })) }
              : {}),
            ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
            ...(message.reactions?.length ? { reactions: message.reactions.map((reaction) => ({ ...reaction })) } : {}),
          }))
        : checkpoint.messages
            .map(publicMessage)
            .filter((message): message is PublicConversationMessage => message !== undefined),
      compactedMessages: compactedMessages(checkpoint),
      ...(transcript.nextToken ? { nextToken: transcript.nextToken } : {}),
    },
  };
}

function sourceLabel(source: ConversationRecord['source']['kind']): string {
  return ({
    api: 'API',
    github: 'GitHub',
    gitlab: 'GitLab',
    teams: 'Teams',
    slack: 'Slack',
  })[source];
}

export function publicConversationId(conversationId: string): string {
  return createHash('sha256').update(conversationId).digest('hex');
}

function apiThreadKey(conversation: ConversationRecord): string | undefined {
  if (conversation.source.kind !== 'api') return undefined;
  return conversation.conversationId.match(/^api:[a-f0-9]{32}:(.+)$/)?.[1];
}

function publicMessage(value: JsonValue): PublicConversationMessage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const role = value.role;
  const content = value.content;
  if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string') return undefined;
  return {
    role,
    content,
    ...(typeof value.messageId === 'string' ? { messageId: value.messageId } : {}),
    ...(typeof value.receivedAt === 'string' ? { receivedAt: value.receivedAt } : {}),
  };
}

function compactedMessages(checkpoint: ConversationCheckpoint): number {
  const count = checkpoint.metadata?.compactedMessages;
  return typeof count === 'number' && Number.isSafeInteger(count) && count > 0 ? count : 0;
}

function conversationUnread(conversation: ConversationRecord): boolean {
  const readAt = Date.parse(conversation.readAt ?? '');
  const updatedAt = Date.parse(conversation.updatedAt);
  return !Number.isFinite(readAt) || (Number.isFinite(updatedAt) && updatedAt > readAt);
}
