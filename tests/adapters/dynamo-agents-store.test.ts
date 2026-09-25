import { expect, it, vi } from 'vitest';
import { GetCommand, TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DynamoAgentsStore } from '../../src/adapters/dynamo-agents-store.js';
import { SessionEventStore } from '../../src/core/session-event-store.js';

const resource = { ownerId: 'alice', id: 'agent', collection: 'agents', revision: 1, createdAt: 1, value: { name: 'fixture' } };
const cancelled = (codes?: string[]) => Object.assign(new Error('transaction cancelled'), {
  name: 'TransactionCanceledException', ...(codes ? { CancellationReasons: codes.map(Code => ({ Code })) } : {}),
});

function fixture(failure: Error, sourceChanged = false) {
  let writes = 0;
  const send = vi.fn(async (command: unknown) => {
    if (command instanceof TransactWriteCommand) {
      if (++writes === 1) throw failure;
      return {};
    }
    if (command instanceof GetCommand) return sourceChanged ? { Item: { ...resource, reference: {} } } : {};
    throw new Error('Unexpected command');
  });
  const store = new SessionEventStore(new DynamoAgentsStore({ send } as unknown as DynamoDBDocumentClient, 'agents', {
    putJson: async key => ({ bucket: 'private', key, sha256: 'fixture', bytes: 1, contentType: 'application/json' }),
    getJson: async <T>() => resource.value as T,
  }));
  return { store, writes: () => writes };
}

it.each([
  cancelled(['None', 'TransactionConflict', 'TransactionConflict', 'None']),
  cancelled(['None', 'ConditionalCheckFailed']),
  Object.assign(new Error('conflict'), { name: 'TransactionConflictException' }),
])('retries confirmed contention after checking the original revision: $name', async failure => {
  const f = fixture(failure);
  await f.store.put(resource, 0);
  expect(f.writes()).toBe(2);
});

it('does not overwrite a source changed by the competing transaction', async () => {
  const f = fixture(cancelled(['TransactionConflict']), true);
  await expect(f.store.put(resource, 0)).rejects.toMatchObject({ status: 409, code: 'conflict' });
  expect(f.writes()).toBe(1);
});

it.each([
  new Error('acknowledgement lost'), cancelled(), cancelled([]),
  cancelled(['TransactionConflict', 'ValidationError']), cancelled(['TransactionConflict', 'Unknown']),
])('does not replay ambiguous or non-contention failures: $message', async failure => {
  const f = fixture(failure);
  await expect(f.store.put(resource, 0)).rejects.toBe(failure);
  expect(f.writes()).toBe(1);
});
