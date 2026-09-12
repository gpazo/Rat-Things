import { describe, expect, it } from 'vitest';
import { messageContentPlan, messageRecords } from '../../src/conversation/message-planning.js';
import {
  requiredId,
  uniqueMessageIds,
  validateCheckpoint,
  validateMessageInput,
  type AppendConversationMessageInput,
} from '../../src/conversation/validation.js';
import { artifactIdForPath } from '../../src/domain/artifacts.js';
import { sha256Hex } from '../../src/domain/json.js';
import { artifact, conversation, freeze, timestamp } from './fixtures.js';

function input(overrides: Partial<AppendConversationMessageInput> = {}): AppendConversationMessageInput {
  const { source, destination, actor, credentialSubject } = conversation();
  return {
    conversationId: 'conversation-1', ownerId: 'owner-1', messageId: 'message-1', delivery: 'defer',
    content: { text: 'Review the queue' }, source, destination, actor, credentialSubject, ...overrides,
  };
}

describe('message content planning', () => {
  it('keeps canonical content identity stable without changing metadata or falsey values', () => {
    const request = freeze(input({ content: { text: 'Review', metadata: { zero: 0, enabled: false, empty: '' } } }));
    const before = structuredClone(request);
    const planned = messageContentPlan(request, new Date(timestamp), 600);
    expect(planned.encoded).toBe('{"metadata":{"empty":"","enabled":false,"zero":0},"text":"Review"}');
    expect(planned.contentHash).toBe(sha256Hex(planned.encoded));
    expect(planned.key).toBe(
      `owners/${sha256Hex('owner-1').slice(0, 32)}/conversations/${sha256Hex('conversation-1').slice(0, 32)}/messages/${sha256Hex('message-1').slice(0, 32)}-${planned.contentHash}.json`,
    );
    expect(messageContentPlan(input({ content: { metadata: { empty: '', enabled: false, zero: 0 }, text: 'Review' } }), new Date(timestamp), 600))
      .toEqual(planned);
    expect(request).toEqual(before);
  });

  it.each(['ownerId', 'conversationId', 'messageId'] as const)('scopes storage identity by %s', (field) => {
    const first = messageContentPlan(input(), new Date(timestamp), 600);
    const second = messageContentPlan(input({ [field]: 'another' }), new Date(timestamp), 600);
    expect(second.key).not.toBe(first.key);
    expect(second.contentHash).toBe(first.contentHash);
  });

  it('uses supplied time and retention, retaining the original received timestamp', () => {
    const receivedAt = '2026-08-03T05:00:00-07:00';
    expect(messageContentPlan(input({ receivedAt }), new Date(999), 0)).toMatchObject({
      createdAt: '1970-01-01T00:00:00.999Z', receivedAt, expiresAt: 0,
    });
    expect(messageContentPlan(input(), new Date(timestamp), 600).receivedAt).toBe(timestamp);
    expect(() => messageContentPlan(input({ receivedAt: '' }), new Date(timestamp), 600))
      .toThrow('receivedAt must be an ISO date');
  });
});

describe('message record construction', () => {
  it('preserves distinct trusted identities, narrowed policies, and paired content references', () => {
    const request = freeze(input({
      capabilityOwnerId: 'capability-owner', runId: 'run-1',
      actor: { kind: 'human', id: 'actor-1', provider: 'api' },
      credentialSubject: { kind: 'runtime', id: 'runtime-1' },
      executionPolicy: { driver: 'codex', capabilities: { networkAccess: false } },
      integrationPolicy: { connections: [{ connection: 'crm', allowOperations: ['records.read'], denyOperations: ['records.delete'] }] },
      receivedAt: '2026-08-03T11:59:00.000Z',
    }));
    const before = structuredClone(request);
    const content = freeze(artifact('message.json'));
    const planned = freeze(messageContentPlan(request, new Date(timestamp), 600));
    const records = messageRecords(request, planned, content);
    expect(records.conversation).toMatchObject({
      ownerId: 'owner-1', capabilityOwnerId: 'capability-owner', actor: request.actor,
      credentialSubject: request.credentialSubject, executionPolicy: request.executionPolicy,
      integrationPolicy: request.integrationPolicy, status: 'pending', pendingCount: 1,
    });
    expect(records.message).toMatchObject({ attemptCount: 0, state: 'pending', runId: 'run-1', receivedAt: request.receivedAt });
    expect(records.message.content).toBe(content);
    expect(records.event.payload).toBe(content);
    expect(records.transcript?.content).toBe(content);
    expect(records.event.occurredAt).toBe(timestamp);
    expect(records.transcript?.occurredAt).toBe(request.receivedAt);
    expect(records.search?.map(({ token }) => token)).toEqual(['review', 'the', 'queue']);
    expect(request).toEqual(before);
  });

  it('accepts attachment-only messages without inventing display text or search terms', () => {
    const path = 'uploads/message/empty.txt';
    const request = freeze(input({ content: { text: '', attachments: [{
      id: artifactIdForPath(path), path, bytes: 0, mediaType: 'text/plain', createdAt: timestamp,
      sourceRunId: 'run-1', file: artifact('empty.txt'),
    }] } }));
    expect(() => validateMessageInput(request)).not.toThrow();
    const records = messageRecords(request, messageContentPlan(request, new Date(timestamp), 0), artifact('body'));
    expect(records.conversation).not.toHaveProperty('title');
    expect(records.conversation).not.toHaveProperty('lastMessagePreview');
    expect(records.event.preview).toBe('');
    expect(records.search).toEqual([]);
  });

  it('bounds explicit titles, derives titles from the first line, and keeps previews separate', () => {
    const records = (request: AppendConversationMessageInput) => messageRecords(
      request, messageContentPlan(request, new Date(timestamp), 600), artifact('body'),
    );
    expect(records(input({ title: `  ${'x'.repeat(150)}  ` })).conversation.title).toBe('x'.repeat(128));
    const text = `  ${'hello '.repeat(20)}\n${'z'.repeat(600)}  `;
    expect(records(input({ content: { text } })).conversation).toMatchObject({
      title: `${'hello '.repeat(10).trimEnd()}…`, lastMessagePreview: text.trim().slice(0, 500),
    });
  });
});

describe('conversation input validation', () => {
  it('requires the exact canonical Run prompt while leaving policy checks to record construction', () => {
    const request = input({ content: { text: 'Review', request: { version: '1', prompt: 'Review' } } });
    expect(() => validateMessageInput(freeze(request))).not.toThrow();
    expect(() => validateMessageInput(input({ content: { ...request.content, text: ' Review ' } })))
      .toThrow('message text must match its canonical Run prompt');
    const invalidPolicy = input({ executionPolicy: JSON.parse('{"outputSchema":{}}') });
    expect(() => validateMessageInput(invalidPolicy)).not.toThrow();
    const planned = messageContentPlan(invalidPolicy, new Date(timestamp), 600);
    expect(() => messageRecords(invalidPolicy, planned, artifact('body')))
      .toThrow('conversation execution policy cannot define an output schema');
  });

  it('bounds UTF-8 text and metadata by bytes, retaining exact accepted values', () => {
    expect(() => validateMessageInput(input({ content: { text: 'é'.repeat(50_000) } }))).not.toThrow();
    expect(() => validateMessageInput(input({ content: { text: 'é'.repeat(50_001) } })))
      .toThrow('message text exceeds 100000 bytes');
    expect(() => validateMessageInput(input({ content: { text: 'ok', metadata: { value: 'é'.repeat(16_000) } } })))
      .toThrow('message metadata exceeds 32000 bytes');
    expect(requiredId(' é ', 'id', 4)).toBe(' é ');
    expect(() => requiredId(' é ', 'id', 3)).toThrow('id exceeds 3 bytes');
  });

  it('deduplicates message IDs in first occurrence order before enforcing the batch limit', () => {
    const ids = freeze(['b', 'a', 'b', ' a ']);
    expect(uniqueMessageIds(ids)).toEqual(['b', 'a', ' a ']);
    expect(ids).toEqual(['b', 'a', 'b', ' a ']);
    expect(uniqueMessageIds(Array.from({ length: 30 }, () => 'a'))).toEqual(['a']);
    expect(() => uniqueMessageIds([])).toThrow('messageIds must contain 1-20 unique values');
    expect(() => uniqueMessageIds(Array.from({ length: 21 }, (_, index) => String(index))))
      .toThrow('messageIds must contain 1-20 unique values');
    expect(() => uniqueMessageIds(['a', ' '])).toThrow('messageId is required');
  });

  it('accepts an empty checkpoint and rejects invalid shapes and oversized serialized contents', () => {
    expect(() => validateCheckpoint(freeze({ version: '1', messages: [] }))).not.toThrow();
    expect(() => validateCheckpoint(JSON.parse('{"version":"2","messages":[]}')))
      .toThrow('checkpoint must be a version 1 message array');
    expect(() => validateCheckpoint({ version: '1', messages: [{ role: 'user', content: 'x'.repeat(5_000_000) }] }))
      .toThrow('checkpoint exceeds 5000000 bytes');
  });
});
