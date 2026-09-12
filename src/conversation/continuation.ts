import type { ArtifactReference, ConversationRunBinding, RunRequest } from '../domain/contracts.js';
import type {
  ConversationCheckpoint,
  ConversationMessageContent,
  ConversationMessageRecord,
  ConversationRecord,
  ConversationTurnRecord,
} from '../domain/conversations.js';
import { sha256Hex as hash } from '../domain/json.js';
import { replayPrompt } from './transcript.js';

export interface ContinuationBatch {
  version: '1';
  messages: Array<{
    messageId: string;
    text: string;
    receivedAt: string;
    replyToMessageId?: string;
    attachments?: Array<{
      id: string;
      path: string;
      mediaType: string;
      bytes: number;
    }>;
  }>;
}

/** Keep each receipt paired with its loaded content rather than joining parallel arrays by index. */
export interface LoadedConversationMessage {
  message: ConversationMessageRecord;
  content: ConversationMessageContent;
}

export function continuationForMessages(loaded: readonly LoadedConversationMessage[]): ContinuationBatch {
  return {
    version: '1',
    messages: loaded.map(({ message, content }) => ({
      messageId: message.messageId,
      text: content.text,
      receivedAt: message.receivedAt,
      ...(content.replyToMessageId ? { replyToMessageId: content.replyToMessageId } : {}),
      ...(content.attachments?.length ? {
        attachments: content.attachments.map((attachment) => ({
          id: attachment.id,
          path: `.rat-things/artifacts/${attachment.path}`,
          mediaType: attachment.mediaType,
          bytes: attachment.bytes,
        })),
      } : {}),
    })),
  };
}

export interface SliceBindingInput {
  conversation: ConversationRecord;
  preparedConversation: ConversationRecord;
  turn: ConversationTurnRecord;
  message: ConversationMessageRecord;
  reserved: ConversationRunBinding;
  continuation: ArtifactReference;
  resumable: boolean;
}

/** Uses only trusted coordination state; caller-provided RunRequest fields cannot select a VM. */
export function bindingForSlice({
  conversation, preparedConversation, turn, message, reserved, continuation, resumable,
}: SliceBindingInput): ConversationRunBinding {
  return {
    conversationId: conversation.conversationId,
    messageId: message.messageId,
    ...(reserved.title ? { title: reserved.title } : {}),
    turnId: turn.turnId,
    slice: turn.slice,
    delivery: reserved.delivery ?? message.delivery,
    continuation,
    ...(preparedConversation.artifacts ? { artifacts: preparedConversation.artifacts } : {}),
    ...(reserved.attachmentManifest ? { attachmentManifest: reserved.attachmentManifest } : {}),
    ...(reserved.attachmentDigest ? { attachmentDigest: reserved.attachmentDigest } : {}),
    ...(reserved.replyToMessageId ? { replyToMessageId: reserved.replyToMessageId } : {}),
    ...(resumable && conversation.session ? { preferredMicrovmId: conversation.session.id } : {}),
    // Native thread state outlives the VM lease and can be restored into a replacement worker.
    ...(conversation.session?.agentThreadId ? { agentThreadId: conversation.session.agentThreadId } : {}),
  };
}

export function requestForSlice(
  conversation: ConversationRecord,
  context: ConversationCheckpoint,
  continuation: ContinuationBatch,
  timeoutSeconds: number,
  rawRequest: RunRequest,
): RunRequest {
  return {
    ...rawRequest,
    prompt: replayPrompt(context, continuation),
    agent: {
      ...conversation.executionPolicy,
      ...rawRequest.agent,
      sandbox: rawRequest.agent?.sandbox ?? conversation.executionPolicy?.sandbox ?? 'danger-full-access',
    },
    ...(rawRequest.integrations ?? conversation.integrationPolicy
      ? { integrations: rawRequest.integrations ?? conversation.integrationPolicy }
      : {}),
    execution: {
      ...rawRequest.execution,
      backend: 'microvm',
      timeoutSeconds: Math.min(rawRequest.execution?.timeoutSeconds ?? timeoutSeconds, timeoutSeconds),
    },
    metadata: {
      ...rawRequest.metadata,
      conversationId: conversation.conversationId,
      messageIds: continuation.messages.map((message) => message.messageId),
    },
  };
}

export function requestForMessage(
  conversation: ConversationRecord,
  continuation: ContinuationBatch,
): RunRequest {
  return {
    version: '1',
    prompt: continuation.messages[0]?.text ?? 'Continue the conversation.',
    agent: {
      ...conversation.executionPolicy,
      sandbox: conversation.executionPolicy?.sandbox ?? 'danger-full-access',
    },
    ...(conversation.integrationPolicy ? { integrations: conversation.integrationPolicy } : {}),
    source: conversation.source,
    destinations: [conversation.destination],
  };
}

export function continuationKey(conversation: ConversationRecord, turnId: string, slice: number): string {
  return `owners/${hash(conversation.ownerId).slice(0, 32)}/conversations/${hash(conversation.conversationId).slice(0, 32)}/turns/${hash(turnId).slice(0, 32)}/slice-${slice}-input.json`;
}
