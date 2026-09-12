import {
  CONVERSATION_REACTION_EMOJIS,
  type ConversationCompletion,
  type ConversationMessageContent,
  type ConversationReactionRecord,
  type ConversationTranscriptMessage,
  type ConversationTranscriptRecord,
  type ConversationTurnRecord,
} from '../domain/conversations.js';

export interface LoadedTranscriptTurn {
  record: ConversationTranscriptRecord;
  turn: ConversationTurnRecord | undefined;
}

/** Page records arrive newest first; only completed, Run-bound turns produce public receipts. */
export function transcriptCompletions(loaded: readonly LoadedTranscriptTurn[]): ConversationCompletion[] {
  return loaded.flatMap(({ record, turn }) => turn?.runId && turn.completedAt ? [{
    runId: turn.runId,
    status: record.runStatus ?? (turn.error?.code === 'agent_cancelled' ? 'cancelled' as const
      : turn.state === 'failed' ? 'failed' as const : 'succeeded' as const),
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
  }] : []).reverse();
}

export function chronologicalMessages(
  loaded: readonly (ConversationTranscriptMessage | ConversationTranscriptMessage[] | undefined)[],
): ConversationTranscriptMessage[] {
  return [...loaded].reverse().flat().filter((message): message is ConversationTranscriptMessage => message !== undefined);
}

/** Project private message bodies to public text, attachment IDs, and reply edges only. */
export function userTranscriptMessage(
  record: ConversationTranscriptRecord,
  message: ConversationMessageContent,
  maxTextBytes: number,
): ConversationTranscriptMessage | undefined {
  if (!message || typeof message.text !== 'string') return undefined;
  return {
    role: 'user',
    content: boundedTranscriptText(message.text, maxTextBytes),
    ...(record.messageId ? { messageId: record.messageId } : {}),
    receivedAt: record.occurredAt,
    ...(message.attachments?.length
      ? { attachmentIds: message.attachments.map((attachment) => attachment.id) }
      : {}),
    ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
  };
}

export function turnTranscriptMessage(
  record: ConversationTranscriptRecord,
  entries: readonly ConversationTranscriptMessage[],
  maxTextBytes: number,
): ConversationTranscriptMessage | undefined {
  const final = entries.at(-1);
  if (!final) return undefined;
  return {
    role: 'assistant', content: boundedTranscriptText(final.content, maxTextBytes),
    receivedAt: final.receivedAt ?? record.occurredAt,
    ...(record.messageId ? { messageId: record.messageId } : {}),
    interactions: entries.slice(0, -1).map((entry) => ({
      role: entry.role, content: entry.content,
      ...(entry.receivedAt ? { receivedAt: entry.receivedAt } : {}),
    })),
  };
}

export function textTranscriptMessage(
  record: ConversationTranscriptRecord,
  text: string,
  maxTextBytes: number,
): ConversationTranscriptMessage {
  return {
    role: 'assistant',
    content: boundedTranscriptText(text, maxTextBytes),
    ...(record.messageId ? { messageId: record.messageId } : {}),
    receivedAt: record.occurredAt,
  };
}

export function withMessageReactions(
  messages: readonly ConversationTranscriptMessage[],
  reactions: readonly ConversationReactionRecord[],
  ownerId: string,
): ConversationTranscriptMessage[] {
  const byMessage = new Map<string, ConversationReactionRecord[]>();
  for (const reaction of reactions) {
    const list = byMessage.get(reaction.messageId) ?? [];
    list.push(reaction);
    byMessage.set(reaction.messageId, list);
  }
  return messages.map((message) => {
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

function boundedTranscriptText(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  return bytes.byteLength <= maxBytes
    ? value
    : `${bytes.subarray(0, maxBytes).toString('utf8')}…`;
}
