import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import { DynamoIntegrationStore } from '../../src/adapters/dynamo-integration-store.js';
import type { SourceCapabilityBinding } from '../../src/domain/capabilities.js';

const original: SourceCapabilityBinding = {
  version: '1', bindingId: 'binding-1', ownerId: 'owner-1', sourceKind: 'github',
  selector: { repository: 'org/repo' }, threadScope: 'thread',
  agentId: 'agent_1', environment: { type: 'none' }, vaultIds: ['vault_1'],
  watchdog: { cancelLoops: true }, connectionSetId: 'set-1',
};
const policy = { mode: 'explicit' as const, actors: { allow: ['maintainer'] } };

describe('source event policy updates', () => {
  it('updates both binding copies using only writes allowed to the control role', async () => {
    const controlIntegrationActions = new Set(['GetItem', 'Query', 'PutItem', 'DeleteItem']);
    const send = vi.fn().mockImplementation(async command => {
      if (!command.input.TransactItems) return { Item: { value: original } };
      for (const item of command.input.TransactItems) {
        const action = 'Put' in item ? 'PutItem' : 'Update' in item ? 'UpdateItem' : undefined;
        if (!action || !controlIntegrationActions.has(action)) {
          throw Object.assign(new Error(`not authorized to perform: dynamodb:${action}`), {
            name: 'AccessDeniedException',
          });
        }
      }
      return {};
    });
    const store = new DynamoIntegrationStore({ send } as unknown as DynamoDBDocumentClient, 'integrations');
    const updated = await store.updateSourceEventPolicy('owner-1', 'binding-1', policy);
    expect(updated).toEqual({ ...original, eventPolicy: policy });
    expect(original).not.toHaveProperty('eventPolicy');
    expect(send.mock.calls[0]![0].input).toMatchObject({
      Key: { sk: 'SOURCE#binding-1' }, ConsistentRead: true,
    });
    const writes = send.mock.calls[1]![0].input.TransactItems;
    expect(writes).toHaveLength(2);
    expect(writes.map((write: { Put: { Item: unknown } }) => write.Put.Item)).toEqual([
      { pk: expect.stringMatching(/^OWNER#/), sk: 'SOURCE#binding-1', value: updated },
      { pk: 'SOURCE#github', sk: 'BINDING#binding-1', value: updated },
    ]);
    for (const { Put: write } of writes) {
      expect(write).toMatchObject({
        TableName: 'integrations',
        ConditionExpression: '#value = :previous',
        ExpressionAttributeNames: { '#value': 'value' },
        ExpressionAttributeValues: { ':previous': original },
      });
    }
  });

  it.each([undefined, { ...original, ownerId: 'another-owner' }, { ...original, bindingId: 'another-binding' }])('does not write a missing or mismatched owner binding', async value => {
    const send = vi.fn().mockResolvedValue(value ? { Item: { value } } : {});
    const store = new DynamoIntegrationStore({ send } as unknown as DynamoDBDocumentClient, 'integrations');
    await expect(store.updateSourceEventPolicy('owner-1', 'binding-1', policy)).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledOnce();
  });

  it('rejects a concurrent overwrite with 409 and keeps both copies consistent', async () => {
    let current = original;
    const send = vi.fn().mockImplementation(async command => {
      if (!command.input.TransactItems) return { Item: { value: structuredClone(current) } };
      const writes = command.input.TransactItems;
      if (writes.some((write: { Put: { ExpressionAttributeValues: Record<string, unknown> } }) => JSON.stringify(write.Put.ExpressionAttributeValues[':previous']) !== JSON.stringify(current))) {
        throw Object.assign(new Error('race'), { name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }] });
      }
      current = writes[0].Put.Item.value;
      return {};
    });
    const store = new DynamoIntegrationStore({ send } as unknown as DynamoDBDocumentClient, 'integrations');
    const results = await Promise.allSettled([
      store.updateSourceEventPolicy('owner-1', 'binding-1', policy),
      store.updateSourceEventPolicy('owner-1', 'binding-1', { mode: 'ignore' }),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { status: 409, code: 'conflict' } });
    expect(current).toEqual({ ...original, eventPolicy: policy });
  });

  it('does not mistake a storage outage for a policy conflict', async () => {
    const failure = Object.assign(new Error('unavailable'), { name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'ProvisionedThroughputExceeded' }] });
    const send = vi.fn().mockResolvedValueOnce({ Item: { value: original } }).mockRejectedValueOnce(failure);
    const store = new DynamoIntegrationStore({ send } as unknown as DynamoDBDocumentClient, 'integrations');
    await expect(store.updateSourceEventPolicy('owner-1', 'binding-1', policy)).rejects.toBe(failure);
  });
});
