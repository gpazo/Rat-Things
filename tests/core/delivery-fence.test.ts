import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it, vi } from 'vitest';

import { DeliveryFence, DeliveryInProgressError } from '../../src/core/delivery-fence.js';
import type { RunRecord } from '../../src/domain/contracts.js';

const now = Date.parse('2026-08-02T12:00:00.000Z');
const run = {
  runId: 'run-1',
  expiresAt: Math.floor(now / 1_000) + 3_600,
} as RunRecord;

function conditionalFailure(): Error {
  const error = new Error('conditional');
  error.name = 'ConditionalCheckFailedException';
  return error;
}

describe('DeliveryFence', () => {
  it('creates a bounded initial lease', async () => {
    const send = vi.fn().mockResolvedValue({});
    const fence = new DeliveryFence({ send } as unknown as DynamoDBDocumentClient, 'runs', () => now, 120);

    await expect(fence.claim(run, 'source:default')).resolves.toBe(true);
    expect(send.mock.calls[0]?.[0].input.Item).toMatchObject({
      status: 'sending',
      leaseUntil: Math.floor(now / 1_000) + 120,
    });
  });

  it('suppresses a destination that already reached a terminal fence state', async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(conditionalFailure())
      .mockResolvedValueOnce({ Item: { status: 'delivered' } });
    const fence = new DeliveryFence({ send } as unknown as DynamoDBDocumentClient, 'runs', () => now);

    await expect(fence.claim(run, 'source:default')).resolves.toBe(false);
  });

  it('throws while another delivery owns the lease so EventBridge keeps retrying', async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(conditionalFailure())
      .mockResolvedValueOnce({
        Item: { status: 'sending', leaseUntil: Math.floor(now / 1_000) + 60 },
      });
    const fence = new DeliveryFence({ send } as unknown as DynamoDBDocumentClient, 'runs', () => now);

    await expect(fence.claim(run, 'source:default')).rejects.toBeInstanceOf(DeliveryInProgressError);
  });

  it('reclaims an expired sending lease', async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(conditionalFailure())
      .mockResolvedValueOnce({
        Item: { status: 'sending', leaseUntil: Math.floor(now / 1_000) - 1 },
      })
      .mockResolvedValueOnce({});
    const fence = new DeliveryFence({ send } as unknown as DynamoDBDocumentClient, 'runs', () => now, 120);

    await expect(fence.claim(run, 'source:default')).resolves.toBe(true);
    expect(send.mock.calls[2]?.[0].input.ExpressionAttributeValues).toMatchObject({
      ':leaseUntil': Math.floor(now / 1_000) + 120,
    });
  });
});
