import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import { DynamoConversationStore } from '../../src/adapters/dynamo-conversation-store.js';
import { ConversationConflictError } from '../../src/conversation/types.js';
import type {
  ConversationEventRecord,
  ConversationMessageRecord,
  ConversationRecord,
} from '../../src/domain/conversations.js';

const occurredAt = '2026-08-21T00:00:00.000Z';
const artifact = { bucket: 'artifacts', key: 'object.json', sha256: 'a'.repeat(64) };
const actor = { kind: 'human' as const, id: 'user-1', provider: 'api' as const };
const credentialSubject = { kind: 'runtime' as const, id: 'runtime:api' };

describe('Dynamo conversation policy stability', () => {
  it('treats DynamoDB maps with different key order as the same policy', async () => {
    const current = conversation({
      // Deliberately use the reverse insertion order from the incoming policy.
      executionPolicy: {
        capabilities: {
          webSearch: 'live',
          networkAccess: true,
          approvalPolicy: 'never',
        },
        sandbox: 'danger-full-access',
        driver: 'mock',
      },
      integrationPolicy: {
        connections: [{ denyOperations: ['message.delete'], preset: 'custom', connection: 'primary' }],
        connectionSet: 'daily-work',
      },
    });
    const incoming = conversation({
      executionPolicy: {
        driver: 'mock',
        sandbox: 'danger-full-access',
        capabilities: {
          approvalPolicy: 'never',
          networkAccess: true,
          webSearch: 'live',
        },
      },
      integrationPolicy: {
        connectionSet: 'daily-work',
        connections: [{ connection: 'primary', preset: 'custom', denyOperations: ['message.delete'] }],
      },
    });
    const send = vi.fn()
      .mockResolvedValueOnce({ Item: stored(current) })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: stored({ ...incoming, status: 'pending', pendingCount: 1 }) });
    const store = new DynamoConversationStore(
      { send } as unknown as DynamoDBDocumentClient,
      'conversations',
    );

    await expect(store.appendMessage({
      conversation: incoming,
      message: message(),
      event: event(),
    })).resolves.toMatchObject({ status: 'appended' });
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('still rejects a material execution-policy change', async () => {
    const current = conversation({
      executionPolicy: { driver: 'mock', sandbox: 'read-only' },
    });
    const incoming = conversation({
      executionPolicy: { driver: 'mock', sandbox: 'danger-full-access' },
    });
    const send = vi.fn().mockResolvedValueOnce({ Item: stored(current) });
    const store = new DynamoConversationStore(
      { send } as unknown as DynamoDBDocumentClient,
      'conversations',
    );

    await expect(store.appendMessage({
      conversation: incoming,
      message: message(),
      event: event(),
    })).rejects.toBeInstanceOf(ConversationConflictError);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

function conversation(patch: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    version: '1',
    itemType: 'conversation',
    conversationId: 'conversation-1',
    ownerId: 'owner-1',
    status: 'idle',
    pendingCount: 0,
    createdAt: occurredAt,
    updatedAt: occurredAt,
    expiresAt: 1_900_000_000,
    source: { kind: 'api' },
    destination: { kind: 'none' },
    actor,
    credentialSubject,
    ...patch,
  };
}

function message(): ConversationMessageRecord {
  return {
    version: '1',
    itemType: 'message',
    conversationId: 'conversation-1',
    messageId: 'message-1',
    delivery: 'defer',
    state: 'pending',
    actor,
    credentialSubject,
    source: { kind: 'api' },
    destination: { kind: 'none' },
    content: artifact,
    contentHash: 'b'.repeat(64),
    attemptCount: 0,
    createdAt: occurredAt,
    receivedAt: occurredAt,
    expiresAt: 1_900_000_000,
  };
}

function event(): ConversationEventRecord {
  return {
    version: '1',
    itemType: 'event',
    conversationId: 'conversation-1',
    eventId: 'event-1',
    type: 'message_received',
    occurredAt,
    payload: artifact,
    expiresAt: 1_900_000_000,
    messageId: 'message-1',
  };
}

function stored(record: ConversationRecord): Record<string, unknown> {
  return { ...record, pk: 'CONVERSATION#hash', sk: 'META' };
}
