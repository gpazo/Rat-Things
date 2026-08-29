import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DeleteCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import { DynamoOAuthAuthorizationStore } from '../../src/adapters/dynamo-oauth-store.js';
import type { OAuthAuthorizationRecord } from '../../src/plugins/oauth.js';

describe('Dynamo OAuth authorization state and refresh leases', () => {
  it('stores only a pre-hashed state key with TTL and atomically returns the deleted record', async () => {
    const record = authorizationRecord();
    const send = vi.fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Attributes: { value: record } });
    const store = new DynamoOAuthAuthorizationStore(
      { send } as unknown as DynamoDBDocumentClient,
      'integrations',
    );

    await store.create('a'.repeat(64), record);
    await expect(store.consume('a'.repeat(64))).resolves.toEqual(record);
    const create = send.mock.calls[0]?.[0] as PutCommand;
    expect(create).toBeInstanceOf(PutCommand);
    expect(create.input).toMatchObject({
      TableName: 'integrations',
      Item: {
        pk: `OAUTH#${'a'.repeat(64)}`,
        sk: 'AUTHORIZATION',
        expiresAt: record.expiresAt,
      },
      ConditionExpression: 'attribute_not_exists(pk)',
    });
    expect(JSON.stringify(create.input)).not.toContain('provider-state-in-browser');
    const consume = send.mock.calls[1]?.[0] as DeleteCommand;
    expect(consume).toBeInstanceOf(DeleteCommand);
    expect(consume.input).toMatchObject({
      Key: { pk: `OAUTH#${'a'.repeat(64)}`, sk: 'AUTHORIZATION' },
      ReturnValues: 'ALL_OLD',
    });
  });

  it('classifies a contested refresh lease and conditionally releases only its own token', async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new ConditionalCheckFailedException({ message: 'contested', $metadata: {} }))
      .mockResolvedValueOnce({});
    const store = new DynamoOAuthAuthorizationStore(
      { send } as unknown as DynamoDBDocumentClient,
      'integrations',
    );

    await expect(store.acquireRefreshLock('owner-1', 'connection-1', 'lock-1', 1_800_000_030))
      .resolves.toBe(false);
    await store.releaseRefreshLock('owner-1', 'connection-1', 'lock-1');
    const release = send.mock.calls[1]?.[0] as DeleteCommand;
    expect(release.input).toMatchObject({
      ConditionExpression: '#value.#token = :token',
      ExpressionAttributeValues: { ':token': 'lock-1' },
    });
    expect(String(release.input.Key?.pk)).toMatch(/^OAUTH_REFRESH#[a-f0-9]{64}$/);
  });
});

function authorizationRecord(): OAuthAuthorizationRecord {
  return {
    version: '1',
    ownerId: 'owner-1',
    pluginId: 'slack',
    callbackUrl: 'https://api.example/v1/integrations/oauth/callback',
    codeVerifier: 'verifier-not-browser-state',
    grant: { preset: 'read-only' },
    createdAt: '2026-08-27T20:00:00.000Z',
    expiresAt: 1_800_000_000,
  };
}
