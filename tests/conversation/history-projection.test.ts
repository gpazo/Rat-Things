import { describe, expect, it } from 'vitest';
import {
  chronologicalMessages,
  textTranscriptMessage,
  transcriptCompletions,
  turnTranscriptMessage,
  userTranscriptMessage,
  withMessageReactions,
} from '../../src/conversation/history-projection.js';
import type { ConversationReactionRecord, ConversationTranscriptMessage, ConversationTranscriptRecord } from '../../src/domain/conversations.js';
import { artifact, freeze, timestamp, turn } from './fixtures.js';

describe('public transcript messages', () => {
  it('projects attachment IDs and reply edges while keeping private request and artifact fields out', () => {
    const message = freeze({
      text: 'Review this', replyToMessageId: 'earlier-message',
      request: { version: '1' as const, prompt: 'private-request' }, metadata: { private: 'private-metadata' },
      attachments: [{ id: 'attachment-1', path: 'private-path', mediaType: 'text/plain', bytes: 0,
        createdAt: timestamp, sourceRunId: 'private-run', file: artifact('private-artifact') }],
    });
    const before = structuredClone(message);
    const projected = userTranscriptMessage(freeze(record()), message, 100_000);
    expect(projected).toEqual({
      role: 'user', content: 'Review this', messageId: 'message-1', receivedAt: timestamp,
      attachmentIds: ['attachment-1'], replyToMessageId: 'earlier-message',
    });
    expect(JSON.stringify(projected)).not.toContain('private');
    expect(message).toEqual(before);
  });

  it('keeps empty text visible while omitting missing or malformed message bodies', () => {
    expect(userTranscriptMessage(record(), { text: '', attachments: [], replyToMessageId: '' }, 0)).toEqual({
      role: 'user', content: '', messageId: 'message-1', receivedAt: timestamp,
    });
    for (const encoded of ['null', '{}', '{"text":0}']) {
      expect(userTranscriptMessage(record(), JSON.parse(encoded), 100_000)).toBeUndefined();
    }
  });

  it.each([
    { maxBytes: 7, expected: 'AB🌍C' },
    { maxBytes: 6, expected: 'AB🌍…' },
    { maxBytes: 5, expected: 'AB�…' },
    { maxBytes: 0, expected: '…' },
  ])('retains the existing UTF-8 clipping behavior at $maxBytes bytes', ({ maxBytes, expected }) => {
    expect(textTranscriptMessage(record(), 'AB🌍C', maxBytes).content).toBe(expected);
    expect(userTranscriptMessage(record(), { text: 'AB🌍C' }, maxBytes)?.content).toBe(expected);
    expect(turnTranscriptMessage(record(), [{ role: 'assistant', content: 'AB🌍C' }], maxBytes)?.content).toBe(expected);
  });

  it('projects the final turn entry with its durable identity and retains earlier interactions in order', () => {
    const entries = freeze<ConversationTranscriptMessage[]>([
      { role: 'assistant', content: 'A complete question', receivedAt: '', messageId: 'private-first' },
      { role: 'user', content: 'A complete answer', receivedAt: timestamp, replyToMessageId: 'private-reply' },
      { role: 'user', content: '', receivedAt: '', messageId: 'private-last', attachmentIds: ['private-attachment'] },
    ]);
    expect(turnTranscriptMessage(record(), entries, 1)).toEqual({
      role: 'assistant', content: '', receivedAt: '', messageId: 'message-1',
      interactions: [
        { role: 'assistant', content: 'A complete question' },
        { role: 'user', content: 'A complete answer', receivedAt: timestamp },
      ],
    });
    expect(turnTranscriptMessage(record(), [], 100_000)).toBeUndefined();
    expect(turnTranscriptMessage(record(), [{ role: 'assistant', content: 'Done' }], 100_000)).toMatchObject({
      receivedAt: timestamp, interactions: [],
    });
  });

  it('reverses page entries without reversing interactions or mutating the loaded page', () => {
    const newest: ConversationTranscriptMessage = { role: 'assistant', content: 'Newest' };
    const middle: ConversationTranscriptMessage[] = [{ role: 'user', content: 'Middle 1' }, { role: 'assistant', content: 'Middle 2' }];
    const oldest: ConversationTranscriptMessage = { role: 'user', content: 'Oldest' };
    const loaded = freeze([newest, undefined, middle, oldest]);
    expect(chronologicalMessages(loaded)).toEqual([oldest, ...middle, newest]);
    expect(loaded).toEqual([newest, undefined, middle, oldest]);
    expect(chronologicalMessages([])).toEqual([]);
  });
});

describe('public completion receipts', () => {
  it.each([
    { state: 'failed', code: 'agent_cancelled', expected: 'cancelled' },
    { state: 'failed', code: 'agent_failed', expected: 'failed' },
    { state: 'completed', code: 'none', expected: 'succeeded' },
  ] as const)('derives $expected from persisted turn evidence', ({ state, code, expected }) => {
    const loaded = freeze({ record: record(), turn: turn({ state, runId: 'run-1', completedAt: timestamp,
      error: { code, message: 'private-error', retryable: false } }) });
    expect(transcriptCompletions([loaded])).toEqual([{ runId: 'run-1', status: expected, startedAt: timestamp, completedAt: timestamp }]);
    expect(transcriptCompletions([{ ...loaded, record: record({ runStatus: 'cancelled' }) }])[0]?.status).toBe('cancelled');
  });

  it('omits incomplete receipts, preserves page order, and excludes private turn coordinates', () => {
    const older = { record: record(), turn: turn({ state: 'completed', runId: 'older', completedAt: timestamp }) };
    const newer = { record: record(), turn: turn({ state: 'completed', runId: 'newer', completedAt: timestamp }) };
    const { runId: _runId, ...unbound } = turn({ completedAt: timestamp });
    const loaded = freeze([
      newer,
      { record: record(), turn: undefined },
      { record: record(), turn: unbound },
      { record: record(), turn: turn({ runId: 'unfinished' }) },
      older,
    ]);
    const receipts = transcriptCompletions(loaded);
    expect(receipts.map((receipt) => receipt.runId)).toEqual(['older', 'newer']);
    expect(JSON.stringify(receipts)).not.toMatch(/turnId|conversationId|bucket|private/);
    expect(transcriptCompletions([])).toEqual([]);
  });
});

describe('public reaction summaries', () => {
  it('counts reactions in the supported emoji order and marks only the current owner as reacted', () => {
    const messages = freeze<ConversationTranscriptMessage[]>([
      { role: 'user', content: 'First', messageId: 'message-1' },
      { role: 'assistant', content: 'No ID' },
      { role: 'user', content: 'No reactions', messageId: 'message-2' },
    ]);
    const reactions = freeze([
      reaction({ emoji: '👀' }), reaction({ emoji: '❤️', ownerId: 'owner-1' }),
      reaction({ emoji: '👍' }), reaction({ emoji: '👍', ownerId: 'owner-1' }),
      reaction({ messageId: 'outside-page' }),
    ]);
    const projected = withMessageReactions(messages, reactions, 'owner-1');
    expect(projected[0]).toEqual({ ...messages[0], reactions: [
      { emoji: '👍', count: 2, reacted: true },
      { emoji: '❤️', count: 1, reacted: true },
      { emoji: '👀', count: 1, reacted: false },
    ] });
    expect(projected[1]).toBe(messages[1]);
    expect(projected[2]).toBe(messages[2]);
    expect(messages[0]).not.toHaveProperty('reactions');
    expect(withMessageReactions(messages, [], 'owner-1')).toEqual(messages);
  });
});

function record(overrides: Partial<ConversationTranscriptRecord> = {}): ConversationTranscriptRecord {
  return {
    version: '1', itemType: 'transcript', conversationId: 'private-conversation', entryId: 'private-entry',
    role: 'assistant', contentKind: 'turn', content: artifact('private-body'), occurredAt: timestamp,
    expiresAt: 600, messageId: 'message-1', ...overrides,
  };
}

function reaction(overrides: Partial<ConversationReactionRecord> = {}): ConversationReactionRecord {
  return {
    version: '1', itemType: 'reaction', conversationId: 'conversation-1', messageId: 'message-1', emoji: '👍',
    ownerId: 'owner-2', createdAt: timestamp, expiresAt: 600, ...overrides,
  };
}
