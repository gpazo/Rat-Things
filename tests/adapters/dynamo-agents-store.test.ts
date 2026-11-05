import { ConfigurationHistory, configurationRef, planConfigurationRevision } from '../../src/core/configuration-history.js';
import type { ArtifactReference } from '../../src/domain/contracts.js';
import { expect, it, vi } from 'vitest';
import { GetCommand, QueryCommand, TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DynamoAgentsStore } from '../../src/adapters/dynamo-agents-store.js';
import { SessionEventStore } from '../../src/core/session-event-store.js';
import { AgentsResourceConflictError } from '../../src/domain/agents-api-validation.js';

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
  await expect(f.store.put(resource, 0)).rejects.toBeInstanceOf(AgentsResourceConflictError);
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


it('atomically guards observed legacy revisions without mutating the source head', async () => {
  const send = vi.fn(async (_command: unknown) => ({}));
  const store = new DynamoAgentsStore({ send } as unknown as DynamoDBDocumentClient, 'agents', {
    putJson: async key => ({ bucket: 'private', key, sha256: 'fixture', bytes: 1, contentType: 'application/json' }),
    getJson: async <T>() => ({}) as T,
  });
  const observed = { ownerId: 'alice', collection: 'agents', id: 'legacy', revision: 9 };
  await store.commit([{ resource: { ...resource, id: 'history', collection: 'configuration_revisions/agent/legacy' }, expectedRevision: 0 }], [observed]);
  const transaction = send.mock.calls[0]![0] as unknown as TransactWriteCommand;
  expect(transaction.input.TransactItems).toHaveLength(3);
  expect(transaction.input.TransactItems?.[2]?.ConditionCheck).toMatchObject({
    TableName: 'agents', ConditionExpression: '#revision = :expected AND attribute_not_exists(deleted)',
    ExpressionAttributeValues: { ':expected': 9 },
  });
});

it('keeps legacy zero-prefix and new timestamped history on the same bounded native pages and cursors', async () => {
  const indexes = new Map<string, Record<string, unknown>>();
  const values = new Map<string, unknown>();
  const key = (item: { scope?: unknown; key?: unknown }) => JSON.stringify([item.scope, item.key]);
  const send = vi.fn(async (command: GetCommand | QueryCommand | TransactWriteCommand) => {
    if (command instanceof TransactWriteCommand) {
      for (const item of command.input.TransactItems ?? []) if (item.Put?.Item) indexes.set(key(item.Put.Item), item.Put.Item);
      return {};
    }
    if (command instanceof GetCommand) return { Item: indexes.get(key(command.input.Key!)) };
    const query = command.input;
    const ascending = query.ScanIndexForward;
    const selected = [...indexes.values()].filter(item => item.scope === query.ExpressionAttributeValues![':scope'])
      .sort((a, b) => (ascending ? 1 : -1) * String(a.key).localeCompare(String(b.key)))
      .filter(item => !query.ExclusiveStartKey || (ascending ? String(item.key) > String(query.ExclusiveStartKey.key) : String(item.key) < String(query.ExclusiveStartKey.key)));
    // Model a byte-limited DynamoDB page smaller than the requested item limit.
    const page = selected.slice(0, 1);
    return { Items: page, ...(selected.length > 1 ? { LastEvaluatedKey: { scope: page[0]!.scope, key: page[0]!.key } } : {}) };
  });
  const store = new DynamoAgentsStore({ send } as unknown as DynamoDBDocumentClient, 'agents', {
    putJson: async (path, value) => { values.set(path, value); return { bucket: 'private', key: path, sha256: 'fixture' }; },
    getJson: async <T>(reference: ArtifactReference) => values.get(reference.key) as T,
  });
  const subject = { kind: 'agent' as const, id: 'legacy' };
  const rows = [1, 8, 9, 10, 11].map((revision, index) => planConfigurationRevision('alice', configurationRef(subject, revision), null, null, 200 - index * 10, 'deleted').resource);
  for (const [index, row] of rows.entries()) {
    const { listOrder: _mode, ...legacy } = row;
    await store.put(index < 3 ? { ...legacy, createdAt: 0 } : row, 0);
  }
  await store.put({ ...rows[0]!, ownerId: 'bob' }, 0);
  const history = new ConfigurationHistory(new SessionEventStore(store));
  for (const order of ['asc', 'desc'] as const) {
    const ordered = order === 'asc' ? rows : [...rows].reverse();
    let after: string | undefined;
    for (const [index, row] of ordered.entries()) {
      const page = await history.list('alice', subject, { order, limit: 1, ...(after ? { after } : {}) });
      expect(page.data.map(value => value.id)).toEqual([row.id]);
      expect(page.has_more).toBe(index < ordered.length - 1);
      after = page.last_id!;
    }
    expect((await history.list('alice', subject, { order, after })).data).toEqual([]);
  }
  for (const row of rows.slice(3)) {
    expect(await store.get('alice', row.collection, row.id)).toEqual(row);
    expect([...indexes.values()].find(item => String(item.scope).startsWith('list:') && item.id === row.id)).toMatchObject({ key: `0000000000000000:${row.id}`, createdAt: row.createdAt, listOrder: 'id' });
  }
  const queries = send.mock.calls.map(([command]) => command).filter(command => command instanceof QueryCommand);
  expect(queries.length).toBeGreaterThan(rows.length * 2);
  expect(queries.every(command => command.input.ConsistentRead === true && command.input.Limit! <= 21)).toBe(true);
  expect(queries.filter(command => command.input.ExclusiveStartKey).every(command => String(command.input.ExclusiveStartKey!.key).startsWith('0000000000000000:'))).toBe(true);
  await expect(history.list('mallory', subject, { after: rows[0]!.id })).rejects.toMatchObject({ status: 400 });
});

it.each([undefined, 'createdAt', 'id'] as const)('guards the fixed ordering mode atomically on update and delete (%s)', async listOrder => {
  const send = vi.fn(async (_command: unknown) => ({}));
  const store = new DynamoAgentsStore({ send } as unknown as DynamoDBDocumentClient, 'agents', {
    putJson: async key => ({ bucket: 'private', key, sha256: 'fixture' }),
    getJson: async <T>() => ({}) as T,
  });
  const saved = { ...resource, ...(listOrder ? { listOrder } : {}) };
  await store.put({ ...saved, revision: 2 }, 1);
  await store.delete(saved);
  const update = (send.mock.calls[0]![0] as TransactWriteCommand).input.TransactItems![0]!.Put!;
  const remove = (send.mock.calls[1]![0] as TransactWriteCommand).input.TransactItems![0]!.Update!;
  for (const condition of [update, remove]) {
    expect(condition.ExpressionAttributeNames).toMatchObject({ '#listOrder': 'listOrder' });
    expect(condition.ExpressionAttributeValues).toMatchObject({ ':listOrder': listOrder ?? 'createdAt', ':expected': 1 });
    expect(condition.ConditionExpression).toContain('#revision = :expected AND attribute_not_exists(deleted)');
    expect(condition.ConditionExpression).toContain(listOrder === 'id' ? 'AND #listOrder = :listOrder' : 'AND (attribute_not_exists(#listOrder) OR #listOrder = :listOrder)');
  }
});
