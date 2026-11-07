import { expect, it, vi } from 'vitest';
import { GetCommand, TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DynamoOwnerRateLimit } from '../../src/adapters/dynamo-owner-rate-limit.js';

function fixture(maximum = 60, now = 1_800) {
  const rows = new Map<string, Record<string, unknown>>();
  const mapKey = (key: { scope?: string; key?: string }) => `${key.scope}/${key.key}`;
  let loseAck = false;
  const send = vi.fn(async (command: GetCommand | TransactWriteCommand) => {
    if (command instanceof GetCommand) return { Item: rows.get(mapKey(command.input.Key!)) };
    const [counter, receipt] = command.input.TransactItems!;
    const update = counter!.Update!; const put = receipt!.Put!; const ck = mapKey(update.Key as { scope: string; key: string }); const rk = mapKey(put.Item as { scope: string; key: string });
    const prior = rows.get(ck); const minute = Number(update.ExpressionAttributeValues?.[':minute']);
    const sameBucket = update.ConditionExpression?.includes('#requests <= :remaining');
    const valid = sameBucket ? Number(prior?.minute) === minute && Number(prior?.requests) <= Number(update.ExpressionAttributeValues?.[':remaining'])
      : (!prior || Number(prior.minute) < minute) && !rows.has(rk);
    if (!valid || rows.has(rk)) throw Object.assign(new Error('conditional race'), { name: 'TransactionCanceledException', CancellationReasons: [{ Code: valid ? 'None' : 'ConditionalCheckFailed' }, { Code: rows.has(rk) ? 'ConditionalCheckFailed' : 'None' }] });
    const add = Number(update.ExpressionAttributeValues?.[':requests']);
    rows.set(ck, { scope: update.Key?.scope, key: update.Key?.key, minute, requests: sameBucket ? Number(prior!.requests) + add : add });
    rows.set(rk, put.Item as Record<string, unknown>);
    if (loseAck) { loseAck = false; throw new Error('acknowledgement lost'); }
    return {};
  });
  const limiter = () => new DynamoOwnerRateLimit({ send } as unknown as DynamoDBDocumentClient, 'agents', () => maximum, () => now);
  return { limiter, rows, send, loseNextAck: () => { loseAck = true; } };
}

it('admits at most the configured requests under concurrent writes to one owner', async () => {
  const f = fixture(60);
  const results = await Promise.allSettled(Array.from({ length: 70 }, (_, i) => f.limiter().admit('owner', `op-${i}`)));
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(60);
  expect(results.filter(result => result.status === 'rejected' && (result.reason as { status?: number }).status === 429)).toHaveLength(10);
  expect([...f.rows.values()].find(row => row.key === 'current')).toMatchObject({ requests: 60, minute: 30 });
});

it('preserves operation idempotency and rejects changed request counts', async () => {
  const f = fixture(); const limiter = f.limiter();
  await limiter.admit('owner', 'same', 3); await limiter.admit('owner', 'same', 3);
  await expect(limiter.admit('owner', 'same', 2)).rejects.toMatchObject({ status: 409, code: 'idempotency_conflict' });
  expect([...f.rows.values()].find(row => row.key === 'current')).toMatchObject({ requests: 3 });
});

it('resets on a later minute but never moves the counter backward under clock skew', async () => {
  let now = 1_800; const f = fixture(60, now); const limit = new DynamoOwnerRateLimit({ send: f.send } as unknown as DynamoDBDocumentClient, 'agents', () => 60, () => now);
  await limit.admit('owner', 'a', 4); now = 1_740; await limit.admit('owner', 'b', 2);
  expect([...f.rows.values()].find(row => row.key === 'current')).toMatchObject({ requests: 6, minute: 30 });
  now = 1_860; await limit.admit('owner', 'c', 1);
  expect([...f.rows.values()].find(row => row.key === 'current')).toMatchObject({ requests: 1, minute: 31 });
});

it('rereads a receipt after an ambiguous acknowledgement and returns success if committed', async () => {
  const f = fixture(); f.loseNextAck();
  await expect(f.limiter().admit('owner', 'uncertain')).resolves.toBeUndefined();
  expect(f.send.mock.calls.filter(([command]) => command instanceof TransactWriteCommand)).toHaveLength(1);
});

it('returns the real retry-after value on exhaustion and does not retry a non-contention error', async () => {
  const f = fixture(1, 1_799); const limiter = f.limiter();
  await limiter.admit('owner', 'one');
  await expect(limiter.admit('owner', 'two')).rejects.toMatchObject({ status: 429, retryAfterSeconds: 1 });
  const error = new Error('bad request'); const send = vi.fn(async (command: GetCommand | TransactWriteCommand) => { if (command instanceof GetCommand) return {}; throw error; });
  await expect(new DynamoOwnerRateLimit({ send } as unknown as DynamoDBDocumentClient, 'agents').admit('owner', 'third')).rejects.toBe(error);
  expect(send.mock.calls.filter(([command]) => command instanceof TransactWriteCommand)).toHaveLength(1);
});
