import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import { DynamoIntegrationStore } from '../../src/adapters/dynamo-integration-store.js';
import type { SourceCapabilityBinding } from '../../src/domain/capabilities.js';

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
});

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
