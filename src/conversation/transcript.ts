import type { JsonValue, RunRecord } from '../domain/contracts.js';
import type { AgentToolCallRecord } from '../domain/interaction.js';
import type { ConversationCheckpoint, ConversationTranscriptMessage } from '../domain/conversations.js';
import { isRecord } from '../domain/validation.js';
import type { ContinuationBatch } from './continuation.js';

const MAX_REPLAY_BYTES = 80_000;
const MAX_CONTEXT_MESSAGES = 200;
const MAX_CONTEXT_BYTES = 4_500_000;

/** Parse saved interaction evidence. Transcript limits count UTF-16 code units, as stored historically. */
export function interactionTranscript(events: string, updatedAt: string): ConversationTranscriptMessage[] {
  const messages: ConversationTranscriptMessage[] = [];
  let remaining = 64_000;
  let omitted = false;
  for (const line of events.split('\n')) {
    let event: unknown;
    try { event = JSON.parse(line); } catch { continue; }
    if (!isRecord(event) || event.method !== 'rat/interaction') continue;
    const value = event.params;
    if (!isRecord(value) || (value.role !== 'user' && value.role !== 'assistant') || typeof value.text !== 'string') continue;
    if (messages.length >= 255 || remaining <= 0) { omitted = true; continue; }
    const text = value.text.slice(0, Math.min(16_384, remaining));
    remaining -= text.length;
    if (text.length < value.text.length) omitted = true;
    messages.push({
      role: value.role, content: text,
      receivedAt: typeof value.occurredAt === 'string' ? value.occurredAt : updatedAt,
    });
  }
  if (omitted) {
    messages.push({
      role: 'assistant',
      content: 'Some interaction details were omitted from this bounded transcript. Full terminal events remain in the Run evidence.',
    });
  }
  return messages;
}

export interface TerminalTranscript {
  messages: ConversationTranscriptMessage[];
  interactions: ConversationTranscriptMessage[];
  output: string;
}

/** Absence falls back to the saved preview; an explicitly empty output remains empty. */
export function terminalTranscript(
  run: RunRecord,
  interactions: ConversationTranscriptMessage[],
  savedOutput: string | undefined,
): TerminalTranscript {
  const output = run.result
    ? savedOutput ?? run.result.preview
    : run.status === 'cancelled' ? 'Stopped. No final output was saved.'
    : `Work failed: ${run.error?.message ?? 'No final output was saved.'}`;
  return {
    interactions,
    output,
    messages: [...interactions, { role: 'assistant', receivedAt: run.updatedAt, content: output }],
  };
}

export function replayPrompt(
  context: ConversationCheckpoint,
  continuation: ContinuationBatch,
): string {
  const latest: JsonValue[] = continuation.messages.map((message) => ({
    role: 'user',
    content: message.text,
    messageId: message.messageId,
    ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
    ...(message.attachments?.length ? { attachments: message.attachments } : {}),
  }));
  const transcript = [...context.messages, ...latest];
  const selected: JsonValue[] = [];
  let bytes = 0;
  for (const item of transcript.slice().reverse()) {
    const encoded = JSON.stringify(item);
    if (bytes + Buffer.byteLength(encoded) > MAX_REPLAY_BYTES) break;
    selected.unshift(item);
    bytes += Buffer.byteLength(encoded);
  }
  const compacted = compactedMessageCount(context);
  const omittedFromReplay = transcript.length - selected.length;
  const handoff = compacted > 0 || omittedFromReplay > 0
    ? [
        'Durable replay handoff:',
        `- ${compacted} older transcript item(s) were compacted before this turn.`,
        `- ${omittedFromReplay} retained item(s) were omitted from this bounded replay.`,
        '- Warm session memory may contain more context, but do not invent omitted details. Ask the user or inspect durable files when an omitted fact is required.',
      ].join('\n')
    : 'Durable replay handoff: no known transcript items were omitted.';
  return [
    'Continue this durable conversation. The JSON transcript is canonical and may overlap with warm session memory.',
    'Respond to the newest user message. Use tools when the request requires them.',
    handoff,
    JSON.stringify(selected),
  ].join('\n\n');
}

export function appendContext(
  previous: ConversationCheckpoint,
  continuation: ContinuationBatch,
  output: string,
  interactions: ConversationTranscriptMessage[] = [],
): ConversationCheckpoint {
  const appended: JsonValue[] = [
    ...previous.messages,
    ...continuation.messages.map((message) => ({
      role: 'user',
      content: message.text,
      messageId: message.messageId,
      ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
      ...(message.attachments?.length ? { attachments: message.attachments } : {}),
      receivedAt: message.receivedAt,
    })),
    ...interactions.map(message => ({ role: message.role, content: message.content, ...(message.receivedAt ? {receivedAt: message.receivedAt} : {}) })),
    { role: 'assistant', content: output },
  ];
  const messages = boundedContextMessages(appended);
  const newlyCompacted = appended.length - messages.length;
  return {
    version: '1',
    messages,
    metadata: {
      ...previous.metadata,
      compactedMessages: Math.min(
        Number.MAX_SAFE_INTEGER,
        compactedMessageCount(previous) + newlyCompacted,
      ),
    },
  };
}

export function appendInterruptedToolContext(
  previous: ConversationCheckpoint,
  continuation: ContinuationBatch,
  interrupted: AgentToolCallRecord[],
): ConversationCheckpoint {
  const listed = interrupted.slice(0, 20).map((call) => (
    `- request ${call.requestId}: ${call.namespace ? `${call.namespace}.` : ''}${call.tool} ` +
    `(started ${call.startedAt}; argument digest ${call.argumentDigest})`
  ));
  const content = [
    'Execution interruption handoff:',
    `${interrupted.length} host tool call(s) ended without a durably settled result.`,
    ...listed,
    ...(interrupted.length > listed.length
      ? [`- ${interrupted.length - listed.length} additional interrupted call(s) omitted from this bounded handoff.`]
      : []),
    'The external outcome is unknown. Do not replay any of these calls automatically.',
    'Verify durable/provider state and wait for an explicit new user instruction before attempting a consequential call again.',
  ].join('\n');
  const appended: JsonValue[] = [
    ...previous.messages,
    ...continuation.messages.map((message) => ({
      role: 'user',
      content: message.text,
      messageId: message.messageId,
      receivedAt: message.receivedAt,
    })),
    { role: 'system', content },
  ];
  return boundedCheckpoint(previous, appended);
}

function compactedMessageCount(context: ConversationCheckpoint): number {
  const value = context.metadata?.compactedMessages;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : 0;
}

function boundedCheckpoint(
  previous: ConversationCheckpoint,
  appended: JsonValue[],
): ConversationCheckpoint {
  const messages = boundedContextMessages(appended);
  return {
    version: '1',
    messages,
    metadata: {
      ...previous.metadata,
      compactedMessages: Math.min(
        Number.MAX_SAFE_INTEGER,
        compactedMessageCount(previous) + appended.length - messages.length,
      ),
    },
  };
}

function boundedContextMessages(appended: readonly JsonValue[]): JsonValue[] {
  const messages = appended.slice(-MAX_CONTEXT_MESSAGES);
  while (messages.length > 1 && Buffer.byteLength(JSON.stringify(messages)) > MAX_CONTEXT_BYTES) {
    messages.shift();
  }
  return messages;
}
