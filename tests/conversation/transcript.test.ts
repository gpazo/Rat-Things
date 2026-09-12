import { describe, expect, it } from 'vitest';
import {
  appendContext,
  appendInterruptedToolContext,
  interactionTranscript,
  replayPrompt,
  terminalTranscript,
} from '../../src/conversation/transcript.js';
import type { ConversationCheckpoint } from '../../src/domain/conversations.js';
import { freeze, run, timestamp, toolCall } from './fixtures.js';

const continuation = {
  version: '1' as const,
  messages: [{ messageId: 'message-1', text: 'Newest input', receivedAt: timestamp }],
};

describe('saved interaction transcripts', () => {
  it('ignores malformed and unrelated events while retaining empty text and recorded timestamps', () => {
    const events = [
      'not JSON', 'null', '[]',
      JSON.stringify({ method: 'other', params: { role: 'user', text: 'ignored' } }),
      JSON.stringify({ method: 'rat/interaction', params: { role: 'system', text: 'ignored' } }),
      JSON.stringify({ method: 'rat/interaction', params: { role: 'user', text: 0 } }),
      interaction(''),
      JSON.stringify({ method: 'rat/interaction', params: { role: 'assistant', text: 'Reply', occurredAt: '' } }),
    ].join('\n');
    expect(interactionTranscript(events, timestamp)).toEqual([
      { role: 'user', content: '', receivedAt: timestamp },
      { role: 'assistant', content: 'Reply', receivedAt: '' },
    ]);
    expect(interactionTranscript('', timestamp)).toEqual([]);
  });

  it('preserves per-message and total character limits and reports omission once', () => {
    const messages = interactionTranscript(Array.from({ length: 5 }, () => interaction('😀'.repeat(10_000))).join('\n'), timestamp);
    expect(messages.slice(0, -1).map(message => message.content.length)).toEqual([16_384, 16_384, 16_384, 14_848]);
    expect(messages.at(-1)?.content).toContain('Some interaction details were omitted');
    expect(messages).toHaveLength(5);
  });

  it('bounds message count even when empty interactions use no character budget', () => {
    expect(interactionTranscript(Array.from({ length: 255 }, () => interaction('')).join('\n'), timestamp)).toHaveLength(255);
    const messages = interactionTranscript(Array.from({ length: 256 }, () => interaction('')).join('\n'), timestamp);
    expect(messages).toHaveLength(256);
    expect(messages.at(-1)?.content).toContain('Full terminal events remain in the Run evidence');
  });

  it('keeps empty output, preview fallback, and failure messages distinct without mutating interactions', () => {
    const record = freeze(run());
    const interactions = freeze([{ role: 'user' as const, content: 'Steering', receivedAt: timestamp }]);
    const transcript = terminalTranscript(record, interactions, '');
    expect(transcript.output).toBe('');
    expect(transcript.messages).toEqual([
      ...interactions, { role: 'assistant', content: '', receivedAt: timestamp },
    ]);
    expect(interactions).toHaveLength(1);
    expect(terminalTranscript(record, [], undefined).output).toBe('Saved preview');
    const { result: _result, ...noOutput } = run({ status: 'cancelled' });
    expect(terminalTranscript(noOutput, [], undefined).output).toBe('Stopped. No final output was saved.');
    expect(terminalTranscript({ ...noOutput, status: 'failed', error: { code: 'failed', message: '', retryable: false } }, [], undefined).output)
      .toBe('Work failed: ');
  });
});

describe('durable replay and checkpoints', () => {
  it('bounds replay in UTF-8 bytes and retains a contiguous suffix rather than skipping an oversized item', () => {
    const previous = freeze({
      version: '1' as const,
      messages: [{ role: 'user', content: 'Older short item' }, { role: 'assistant', content: 'é'.repeat(40_000) }],
      metadata: { compactedMessages: 3 },
    });
    const prompt = replayPrompt(previous, continuation);
    expect(prompt).toContain('3 older transcript item(s) were compacted');
    expect(prompt).toContain('2 retained item(s) were omitted');
    expect(JSON.parse(prompt.split('\n\n').at(-1)!)).toEqual([
      { role: 'user', content: 'Newest input', messageId: 'message-1' },
    ]);
    expect(previous.messages).toHaveLength(2);
  });

  it('compacts checkpoints by UTF-8 size while preserving metadata and caller-owned history', () => {
    const previous: ConversationCheckpoint = freeze({
      version: '1',
      messages: [{ role: 'user', content: 'é'.repeat(1_200_000) }, { role: 'assistant', content: '界'.repeat(800_000) }],
      metadata: { compactedMessages: 7, zero: 0, disabled: false, label: '' },
    });
    const next = appendContext(previous, continuation, 'Newest output');
    expect(next.messages).toHaveLength(3);
    expect(next.messages[0]).toEqual(previous.messages[1]);
    expect(next.messages.at(-1)).toEqual({ role: 'assistant', content: 'Newest output' });
    expect(next.metadata).toEqual({ compactedMessages: 8, zero: 0, disabled: false, label: '' });
    expect(Buffer.byteLength(JSON.stringify(next.messages))).toBeLessThanOrEqual(4_500_000);
    expect(previous.messages).toHaveLength(2);
  });

  it('retains the newest item even when it alone exceeds the checkpoint budget', () => {
    const output = 'x'.repeat(4_500_001);
    const next = appendContext({ version: '1', messages: [] }, continuation, output);
    expect(next.messages).toEqual([{ role: 'assistant', content: output }]);
    expect(next.metadata?.compactedMessages).toBe(1);
  });

  it('bounds interrupted-call evidence and preserves the instruction against automatic replay', () => {
    const previous = freeze({
      version: '1' as const, messages: Array.from({ length: 200 }, (_, index) => ({ role: 'user', content: `history-${index}` })),
      metadata: { compactedMessages: 7, retained: false },
    });
    const calls = freeze(Array.from({ length: 22 }, (_, index) => toolCall({ requestId: `call-${index}` })));
    const context = appendInterruptedToolContext(previous, continuation, calls);
    expect(context.messages).toHaveLength(200);
    expect(context.metadata).toEqual({ compactedMessages: 9, retained: false });
    expect(context.messages.at(-1)).toMatchObject({
      role: 'system', content: expect.stringContaining('Do not replay any of these calls automatically'),
    });
    const serialized = JSON.stringify(context.messages.at(-1));
    expect(serialized).toContain('call-19');
    expect(serialized).not.toContain('call-20');
    expect(serialized).toContain('2 additional interrupted call(s) omitted');
    expect(previous.messages).toHaveLength(200);
    expect(calls).toHaveLength(22);
  });
});

function interaction(text: string): string {
  return JSON.stringify({ method: 'rat/interaction', params: { role: 'user', text } });
}
