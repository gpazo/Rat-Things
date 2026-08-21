import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import { DynamoThingStore } from '../../src/adapters/dynamo-thing-store.js';

describe('DynamoThingStore', () => {
  it('continues across filtered archived pages to fill a visible page', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({ Items: [], LastEvaluatedKey: { thingId: 'archived-1', recordKey: 'THING' } })
      .mockResolvedValueOnce({ Items: [{ thingId: 'thing-1', recordKey: 'THING', name: 'Visible' }] });
    const store = new DynamoThingStore(
      { send } as unknown as DynamoDBDocumentClient,
      'things',
    );

    await expect(store.list('owner-1', 1)).resolves.toEqual({
      items: [{ thingId: 'thing-1', name: 'Visible' }],
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(QueryCommand);
    expect((send.mock.calls[1]?.[0] as QueryCommand).input).toMatchObject({
      ExclusiveStartKey: { thingId: 'archived-1', recordKey: 'THING' },
      Limit: 1,
    });
  });

  it('can include archived Things without a filter and rejects malformed page tokens', async () => {
    const send = vi.fn().mockResolvedValueOnce({ Items: [] });
    const store = new DynamoThingStore(
      { send } as unknown as DynamoDBDocumentClient,
      'things',
    );

    await store.list('owner-1', 25, undefined, true);
    const command = send.mock.calls[0]?.[0] as QueryCommand;
    expect(command.input).not.toHaveProperty('FilterExpression');
    await expect(store.list('owner-1', 25, 'not-json')).rejects.toThrow(
      'invalid pagination token',
    );
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('translates only conditional transaction cancellation into a revision conflict', async () => {
    const conditional = Object.assign(new Error(
      'Transaction cancelled [ConditionalCheckFailed, None]',
    ), { name: 'TransactionCanceledException' });
    const throttled = Object.assign(new Error('Transaction was throttled'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'ProvisionedThroughputExceeded' }],
    });
    const send = vi.fn()
      .mockRejectedValueOnce(conditional)
      .mockRejectedValueOnce(throttled);
    const store = new DynamoThingStore(
      { send } as unknown as DynamoDBDocumentClient,
      'things',
    );
    const record = {
      version: '1' as const,
      thingId: 'thing-1',
      ownerId: 'owner-1',
      ownerCreated: 'owner-1#2026-08-21T00:00:00.000Z#thing-1',
      revision: 2,
      name: 'Thing',
      status: 'draft' as const,
      trigger: { kind: 'manual' as const },
      spec: { bucket: 'definitions', key: 'definition.json', sha256: 'a'.repeat(64) },
      specHash: 'b'.repeat(64),
      createdAt: '2026-08-21T00:00:00.000Z',
      updatedAt: '2026-08-21T00:01:00.000Z',
    };
    const version = {
      version: '1' as const,
      thingId: record.thingId,
      revision: record.revision,
      spec: record.spec,
      specHash: record.specHash,
      createdAt: record.updatedAt,
    };

    await expect(store.addVersion(record, version, 1)).rejects.toThrow(
      'Thing changed concurrently',
    );
    await expect(store.addVersion(record, version, 1)).rejects.toBe(throttled);
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(TransactWriteCommand);
    expect((send.mock.calls[0]?.[0] as TransactWriteCommand).input.TransactItems?.[0]?.Put)
      .toMatchObject({
        ConditionExpression: 'ownerId = :ownerId AND revision = :expected AND #status = :expectedStatus',
        ExpressionAttributeValues: {
          ':ownerId': 'owner-1',
          ':expected': 1,
          ':expectedStatus': 'draft',
        },
      });
  });
});
