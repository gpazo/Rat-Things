import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import { DynamoRoutineStore } from '../../src/adapters/dynamo-routine-store.js';

describe('DynamoRoutineStore', () => {
  it('continues across filtered pages to fill the requested visible page', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({ Items: [], LastEvaluatedKey: { routineId: 'deleted-1' } })
      .mockResolvedValueOnce({ Items: [{ routineId: 'routine-1' }] });
    const store = new DynamoRoutineStore(
      { send } as unknown as DynamoDBDocumentClient,
      'routines',
    );

    await expect(store.list('owner-1', 1)).resolves.toEqual({
      items: [{ routineId: 'routine-1' }],
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(QueryCommand);
    expect((send.mock.calls[1]?.[0] as QueryCommand).input).toMatchObject({
      ExclusiveStartKey: { routineId: 'deleted-1' },
      Limit: 1,
    });
  });

  it('rejects malformed opaque page tokens before querying DynamoDB', async () => {
    const send = vi.fn();
    const store = new DynamoRoutineStore(
      { send } as unknown as DynamoDBDocumentClient,
      'routines',
    );

    await expect(store.list('owner-1', 25, 'not-json')).rejects.toThrow(
      'invalid pagination token',
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('records a manual run without allowing older run history to replace newer history', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new ConditionalCheckFailedException({ message: 'older run', $metadata: {} }));
    const store = new DynamoRoutineStore(
      { send } as unknown as DynamoDBDocumentClient,
      'routines',
    );

    await expect(store.recordLastRun(
      'owner-1',
      'routine-1',
      '2026-08-29T21:00:00.000Z',
      'run-1',
      '2026-08-29T21:00:01.000Z',
    )).resolves.toBe(true);
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(UpdateCommand);
    expect((send.mock.calls[0]?.[0] as UpdateCommand).input).toMatchObject({
      Key: { routineId: 'routine-1' },
      ConditionExpression: expect.stringContaining('lastRunAt <= :runAt'),
      ExpressionAttributeValues: expect.objectContaining({
        ':ownerId': 'owner-1',
        ':runAt': '2026-08-29T21:00:00.000Z',
        ':runId': 'run-1',
      }),
    });

    await expect(store.recordLastRun(
      'owner-1',
      'routine-1',
      '2026-08-29T20:00:00.000Z',
      'run-older',
      '2026-08-29T21:00:02.000Z',
    )).resolves.toBe(false);
  });
});
