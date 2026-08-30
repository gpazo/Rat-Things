import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import { DynamoConversationStore } from '../../src/adapters/dynamo-conversation-store.js';
import { ConversationConflictError } from '../../src/conversation/types.js';
import type {
  ConversationEventRecord,
  ConversationMessageRecord,
  ConversationRecord,
  ConversationTranscriptRecord,
} from '../../src/domain/conversations.js';

const occurredAt = '2026-08-21T00:00:00.000Z';
const artifact = { bucket: 'artifacts', key: 'object.json', sha256: 'a'.repeat(64) };
const actor = { kind: 'human' as const, id: 'user-1', provider: 'api' as const };
const credentialSubject = { kind: 'runtime' as const, id: 'runtime:api' };

describe('Dynamo conversation policy stability', () => {
  it('lists only an owner partition through the conversation index', async () => {
    const current = conversation();
    const send = vi.fn().mockResolvedValue({
      Items: [stored(current)],
      LastEvaluatedKey: { pk: 'CONVERSATION#hash', sk: 'META', ownerId: 'owner-1' },
    });
    const store = new DynamoConversationStore(
      { send } as unknown as DynamoDBDocumentClient,
      'conversations',
    );

    const result = await store.list('owner-1', 1);

    expect(result.items).toEqual([current]);
    expect(result.nextToken).toEqual(expect.any(String));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({
        TableName: 'conversations',
        IndexName: 'owner-created-index',
        KeyConditionExpression: 'ownerId = :ownerId',
        FilterExpression: 'attribute_not_exists(hiddenAt)',
        ExpressionAttributeValues: { ':ownerId': 'owner-1' },
        ScanIndexForward: false,
        Limit: 1,
      }),
    }));
  });

  it('persists owner-scoped organization toggles without changing message recency', async () => {
    const current = conversation({ pinnedAt: occurredAt });
    const send = vi.fn().mockResolvedValue({ Attributes: stored(current) });
    const store = new DynamoConversationStore(
      { send } as unknown as DynamoDBDocumentClient,
      'conversations',
    );

    await expect(store.updateOrganization({
      conversationId: current.conversationId,
      ownerId: current.ownerId,
      pinned: true,
      hidden: false,
      now: occurredAt,
    })).resolves.toEqual(current);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({
        UpdateExpression: 'SET pinnedAt = :now REMOVE hiddenAt',
        ConditionExpression: 'ownerId = :ownerId',
        ReturnValues: 'ALL_NEW',
      }),
    }));
  });

  it('treats an already-released lease as a completed conditional cleanup', async () => {
    const current = conversation();
    const send = vi.fn()
      .mockRejectedValueOnce(new ConditionalCheckFailedException({
        message: 'the first response was lost after releasing the lease',
        $metadata: {},
      }))
      .mockResolvedValueOnce({ Item: stored(current) });
    const store = new DynamoConversationStore(
      { send } as unknown as DynamoDBDocumentClient,
      'conversations',
    );

    await expect(store.releaseLease({
      conversationId: current.conversationId,
      expectedToken: 'lease-already-released',
      updatedAt: occurredAt,
    })).resolves.toEqual(current);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[0]).toBeInstanceOf(GetCommand);
  });

  it('intersects encrypted token postings and returns only owner conversations', async () => {
    const current = conversation({ pinnedAt: occurredAt });
    const posting = (token: string) => ({
      version: '1',
      itemType: 'search',
      ownerId: current.ownerId,
      conversationId: current.conversationId,
      entryId: 'message-1',
      token,
      kind: 'message',
      role: 'user',
      snippet: 'Release deployment evidence.',
      occurredAt,
      expiresAt: current.expiresAt,
      pk: `SEARCH#hash#${token}`,
      sk: `MATCH#${occurredAt}`,
    });
    const send = vi.fn()
      .mockResolvedValueOnce({ Items: [posting('release')] })
      .mockResolvedValueOnce({ Items: [posting('deployment')] })
      .mockResolvedValueOnce({ Responses: { conversations: [stored(current)] } });
    const store = new DynamoConversationStore(
      { send } as unknown as DynamoDBDocumentClient,
      'conversations',
    );

    await expect(store.search(current.ownerId, ['release', 'deployment'], 20)).resolves.toEqual([{
      conversation: current,
      matches: [expect.objectContaining({ snippet: 'Release deployment evidence.' })],
    }]);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('treats DynamoDB maps with different key order as the same policy', async () => {
    const current = conversation({
      // Deliberately use the reverse insertion order from the incoming policy.
      executionPolicy: {
        capabilities: {
          webSearch: 'live',
          networkAccess: true,
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
      transcript: transcript(),
      event: event(),
      search: [],
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
      transcript: transcript(),
      event: event(),
      search: [],
    })).rejects.toBeInstanceOf(ConversationConflictError);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('pages transcript entries newest first with an opaque cursor', async () => {
    const item = transcript();
    const send = vi.fn().mockResolvedValue({
      Items: [{ ...item, pk: 'CONVERSATION#hash', sk: 'TRANSCRIPT#time#hash' }],
      LastEvaluatedKey: { pk: 'CONVERSATION#hash', sk: 'TRANSCRIPT#time#hash' },
    });
    const store = new DynamoConversationStore(
      { send } as unknown as DynamoDBDocumentClient,
      'conversations',
    );

    const result = await store.listTranscript('conversation-1', 20);

    expect(result).toEqual({ items: [item], nextToken: expect.any(String) });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :transcript)',
        ScanIndexForward: false,
        Limit: 20,
      }),
    }));
  });

  it('writes and reads owner-scoped durable reactions without starting work', async () => {
    const reaction = {
      version: '1' as const,
      itemType: 'reaction' as const,
      conversationId: 'conversation-1',
      messageId: 'assistant-1',
      emoji: '👍' as const,
      ownerId: 'owner-1',
      createdAt: occurredAt,
      expiresAt: 1_900_000_000,
    };
    const send = vi.fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        Responses: {
          conversations: [{ ...reaction, pk: 'CONVERSATION#hash', sk: 'REACTION#hash' }],
        },
      });
    const store = new DynamoConversationStore(
      { send } as unknown as DynamoDBDocumentClient,
      'conversations',
    );

    await store.setReaction({ ...reaction, reacted: true });
    await expect(store.listReactions(
      reaction.conversationId,
      reaction.ownerId,
      [reaction.messageId],
    )).resolves.toEqual([reaction]);
    expect(send).toHaveBeenNthCalledWith(1, expect.objectContaining({
      input: expect.objectContaining({
        TransactItems: [
          expect.objectContaining({ ConditionCheck: expect.objectContaining({ ConditionExpression: 'ownerId = :ownerId' }) }),
          expect.objectContaining({ Put: expect.objectContaining({ TableName: 'conversations' }) }),
        ],
      }),
    }));
    expect(send).toHaveBeenNthCalledWith(2, expect.objectContaining({
      input: expect.objectContaining({ RequestItems: expect.objectContaining({ conversations: expect.any(Object) }) }),
    }));
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

function transcript(): ConversationTranscriptRecord {
  return {
    version: '1',
    itemType: 'transcript',
    conversationId: 'conversation-1',
    entryId: 'message-message-1',
    role: 'user',
    contentKind: 'message',
    content: artifact,
    occurredAt,
    expiresAt: 1_900_000_000,
    messageId: 'message-1',
  };
}

function stored(record: ConversationRecord): Record<string, unknown> {
  return { ...record, pk: 'CONVERSATION#hash', sk: 'META' };
}
