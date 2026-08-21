import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
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
});
