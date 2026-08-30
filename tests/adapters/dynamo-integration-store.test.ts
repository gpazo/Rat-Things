import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import { DynamoIntegrationStore } from '../../src/adapters/dynamo-integration-store.js';
import type {
  ConnectionHealth,
  IntegrationConnection,
  SourceCapabilityBinding,
} from '../../src/domain/capabilities.js';

describe('Dynamo integration source claims', () => {
  it('scopes API selector claims by owner while keeping provider claims global', async () => {
    const send = vi.fn().mockResolvedValue({});
    const store = new DynamoIntegrationStore(
      { send } as unknown as DynamoDBDocumentClient,
      'integrations',
    );

    await store.putSourceBinding(binding('api-one', 'owner-one', 'api'));
    await store.putSourceBinding(binding('api-two', 'owner-two', 'api'));
    await store.putSourceBinding(binding('slack-one', 'owner-one', 'slack'));
    await store.putSourceBinding(binding('slack-two', 'owner-two', 'slack'));

    const claims = send.mock.calls.map(([command]) => (
      command.input.TransactItems[2].Put.Item.sk as string
    ));
    expect(claims[0]).not.toBe(claims[1]);
    expect(claims[2]).toBe(claims[3]);
  });

  it('stores and retrieves bounded connection health separately from credentials', async () => {
    const health: ConnectionHealth = {
      version: '1',
      ownerId: 'owner-one',
      connectionId: 'connection-one',
      status: 'healthy',
      code: 'verified',
      checkedAt: '2026-08-29T18:00:00.000Z',
      lastHealthyAt: '2026-08-29T18:00:00.000Z',
    };
    const send = vi.fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: { value: health } });
    const store = new DynamoIntegrationStore(
      { send } as unknown as DynamoDBDocumentClient,
      'integrations',
    );

    await store.putConnectionHealth(health);
    await expect(store.getConnectionHealth('owner-one', 'connection-one')).resolves.toEqual(health);
    expect(send.mock.calls[0]?.[0].input.Item).toMatchObject({
      sk: 'HEALTH#connection-one',
      value: health,
    });
    expect(send.mock.calls[1]?.[0].input).toMatchObject({
      TableName: 'integrations',
      Key: { sk: 'HEALTH#connection-one' },
      ConsistentRead: true,
    });
  });

  it('rotates a private scan cursor for bounded deployment health slices', async () => {
    const candidate = connection();
    const send = vi.fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        Items: [{ value: candidate }],
        LastEvaluatedKey: { pk: 'OWNER#hash', sk: 'CONNECTION#connection-one' },
      })
      .mockResolvedValueOnce({});
    const store = new DynamoIntegrationStore(
      { send } as unknown as DynamoDBDocumentClient,
      'integrations',
    );

    await expect(store.nextHealthCheckCandidates(1)).resolves.toEqual([candidate]);
    expect(send.mock.calls[1]?.[0].input).toMatchObject({
      TableName: 'integrations',
      FilterExpression: 'begins_with(sk, :prefix)',
      Limit: 1,
    });
    expect(send.mock.calls[2]?.[0].input.Item).toEqual({
      pk: 'SYSTEM#CONNECTION_HEALTH',
      sk: 'CURSOR',
      value: { lastEvaluatedKey: { pk: 'OWNER#hash', sk: 'CONNECTION#connection-one' } },
    });
  });
});

function connection(): IntegrationConnection {
  return {
    version: '1',
    connectionId: 'connection-one',
    ownerId: 'owner-one',
    pluginId: 'slack',
    alias: 'slack-one',
    label: 'Slack One',
    authorization: { scheme: 'oauth2', access: 'full', scopeModel: 'granular', scopes: [] },
    status: 'active',
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
  };
}

function binding(
  bindingId: string,
  ownerId: string,
  sourceKind: 'api' | 'slack',
): SourceCapabilityBinding {
  return {
    version: '1',
    bindingId,
    ownerId,
    sourceKind,
    selector: sourceKind === 'api' ? { kind: 'api' } : { teamId: 'T1', channelId: 'C1' },
    capabilityProfile: 'small-business',
  };
}
