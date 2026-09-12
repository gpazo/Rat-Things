import { describe, expect, it } from 'vitest';
import { bindingForSlice, continuationForMessages, requestForMessage, requestForSlice } from '../../src/conversation/continuation.js';
import type { RunRequest } from '../../src/domain/contracts.js';
import { artifact, conversation, freeze, message, timestamp, turn } from './fixtures.js';

describe('continuation calculations', () => {
  it('keeps receipts paired with content, preserves ordering, and exposes only workspace attachment coordinates', () => {
    const loaded = freeze([
      {
        message: message({ messageId: 'second', receivedAt: '2026-08-03T12:01:00.000Z' }),
        content: {
          text: '', replyToMessageId: 'first',
          attachments: [{
            id: 'attachment-1', path: 'empty.txt', bytes: 0, mediaType: 'text/plain',
            createdAt: timestamp, sourceRunId: 'run-1', file: artifact('private-file'),
          }],
        },
      },
      { message: message({ messageId: 'first' }), content: { text: 'Earlier input', attachments: [] } },
    ]);
    const before = structuredClone(loaded);
    const continuation = continuationForMessages(loaded);
    expect(continuation).toEqual({
      version: '1',
      messages: [
        {
          messageId: 'second', text: '', receivedAt: '2026-08-03T12:01:00.000Z', replyToMessageId: 'first',
          attachments: [{ id: 'attachment-1', path: '.rat-things/artifacts/empty.txt', bytes: 0, mediaType: 'text/plain' }],
        },
        { messageId: 'first', text: 'Earlier input', receivedAt: timestamp },
      ],
    });
    expect(loaded).toEqual(before);
    expect(continuationForMessages([])).toEqual({ version: '1', messages: [] });
  });

  it('bounds execution and combines trusted defaults with explicit request policy without mutating either', () => {
    const record = freeze(conversation({
      executionPolicy: { driver: 'mock', sandbox: 'workspace-write', capabilities: { networkAccess: true } },
      integrationPolicy: { connectionSet: 'default-connections' },
    }));
    const raw: RunRequest = freeze({
      version: '1', prompt: 'Original prompt',
      agent: { sandbox: 'read-only', capabilities: { networkAccess: false } },
      integrations: { connectionSet: 'requested-connections' },
      execution: { backend: 'microvm', timeoutSeconds: 900 },
      metadata: { count: 0, enabled: false, label: '', conversationId: 'untrusted', messageIds: ['untrusted'] },
    });
    const before = structuredClone({ record, raw });
    const continuation = continuationForMessages([{ message: message(), content: { text: 'Newest request' } }]);
    const request = requestForSlice(record, { version: '1', messages: [] }, continuation, 600, raw);
    expect(request).toMatchObject({
      agent: { driver: 'mock', sandbox: 'read-only', capabilities: { networkAccess: false } },
      integrations: { connectionSet: 'requested-connections' },
      execution: { backend: 'microvm', timeoutSeconds: 600 },
      metadata: { count: 0, enabled: false, label: '', conversationId: 'conversation-1', messageIds: ['message-1'] },
    });
    expect(request.prompt).toContain('Newest request');
    expect(requestForSlice(record, { version: '1', messages: [] }, continuation, 600, {
      ...raw, execution: { timeoutSeconds: 30 },
    }).execution?.timeoutSeconds).toBe(30);
    expect({ record, raw }).toEqual(before);
  });

  it('distinguishes an empty message from a missing message when building a default request', () => {
    const record = conversation({ executionPolicy: { sandbox: 'read-only' } });
    expect(requestForMessage(record, { version: '1', messages: [] }).prompt).toBe('Continue the conversation.');
    expect(requestForMessage(record, {
      version: '1', messages: [{ messageId: 'message-1', text: '', receivedAt: timestamp }],
    })).toMatchObject({ prompt: '', agent: { sandbox: 'read-only' }, source: record.source, destinations: [record.destination] });
  });

  it('retains the native thread after VM expiry and keeps the original occurrence evidence', () => {
    const record = conversation();
    const input = freeze({
      conversation: record, preparedConversation: { ...record, artifacts: artifact('new-catalog.json') },
      turn: turn(), message: message({ delivery: 'defer' }),
      reserved: {
        conversationId: record.conversationId, title: 'Trusted title', delivery: 'interrupt' as const,
        attachmentManifest: artifact('original-manifest.json'), attachmentDigest: 'f'.repeat(64), replyToMessageId: 'older-message',
      },
      continuation: artifact('continuation.json'), resumable: false,
    });
    const binding = bindingForSlice(input);
    expect(binding).toMatchObject({
      turnId: 'turn-1', slice: 0, messageId: 'message-1', title: 'Trusted title', delivery: 'interrupt',
      agentThreadId: 'thread-1', artifacts: artifact('new-catalog.json'),
      attachmentManifest: artifact('original-manifest.json'), attachmentDigest: 'f'.repeat(64), replyToMessageId: 'older-message',
    });
    expect(binding).not.toHaveProperty('preferredMicrovmId');
    expect(bindingForSlice({ ...input, resumable: true }).preferredMicrovmId).toBe('microvm-1');
    expect(bindingForSlice({ ...input, reserved: { conversationId: record.conversationId } }).delivery).toBe('defer');
  });
});
