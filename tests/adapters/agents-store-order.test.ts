import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SqliteAgentsStore } from '../../src/adapters/sqlite-agents-store.js';
import { ConfigurationHistory, configurationRef, planConfigurationRevision } from '../../src/core/configuration-history.js';
import { SessionEventStore } from '../../src/core/session-event-store.js';
import type { AgentResource, AgentsStore } from '../../src/core/agents-ports.js';
import { MemoryAgentsStore } from '../agents/fixtures.js';

const subject = { kind: 'agent' as const, id: 'saved' };
const historyRow = (revision: number, recordedAt: number) => planConfigurationRevision('alice', configurationRef(subject, revision), null, null, recordedAt, 'deleted').resource;

for (const adapter of ['memory', 'sqlite'] as const) describe(`${adapter} explicit list ordering`, () => {
  async function fixture(run: (store: AgentsStore) => Promise<void>) {
    const directory = await mkdtemp(join(tmpdir(), 'rat-order-'));
    const base = adapter === 'sqlite' ? new SqliteAgentsStore(directory) : new MemoryAgentsStore();
    try { await run(new SessionEventStore(base)); }
    finally { if (base instanceof SqliteAgentsStore) base.close(); await rm(directory, { recursive: true, force: true }); }
  }

  it('pages mixed zero-timestamp legacy and current history across 9/10 in either direction under clock reversal', async () => fixture(async store => {
    const rows = [1, 8, 9, 10, 11].map((revision, index) => historyRow(revision, 200 - index * 10));
    for (const [index, row] of rows.entries()) {
      const { listOrder: _mode, ...legacy } = row;
      await store.put(index < 3 ? { ...legacy, createdAt: 0 } : row, 0);
    }
    await store.put({ ...historyRow(12, 1), ownerId: 'bob' }, 0);
    const history = new ConfigurationHistory(store);
    for (const order of ['asc', 'desc'] as const) {
      const expected = order === 'asc' ? rows : [...rows].reverse();
      let after: string | undefined;
      for (const [index, row] of expected.entries()) {
        const page = await history.list('alice', subject, { limit: 1, order, ...(after ? { after } : {}) });
        expect(page.data.map(value => value.id)).toEqual([row.id]);
        expect(page.has_more).toBe(index < expected.length - 1);
        expect(page.first_id).toBe(row.id);
        expect(page.last_id).toBe(row.id);
        after = page.last_id!;
      }
      expect((await history.list('alice', subject, { limit: 1, order, after })).data).toEqual([]);
    }
    for (const row of rows.slice(3)) expect(await store.get('alice', row.collection, row.id)).toMatchObject({ createdAt: row.createdAt, listOrder: 'id' });
    expect((await history.list('bob', subject)).data.map(value => value.ref.revision)).toEqual([12]);
    await expect(history.list('mallory', subject, { after: rows[0]!.id })).rejects.toMatchObject({ status: 400 });
    await expect(history.list('alice', subject, { orderBy: 'id' })).rejects.toMatchObject({ status: 400 });
  }));

  it('keeps ordinary creation-time order and refuses changes to a resource ordering mode atomically', async () => fixture(async store => {
    const ordinary: AgentResource<unknown>[] = [historyRow(1, 20), historyRow(2, 10)].map(({ listOrder: _mode, ...row }) => ({ ...row, collection: 'ordinary' }));
    for (const row of ordinary) await store.put(row, 0);
    expect((await store.list('alice', 'ordinary', { order: 'asc' })).data.map(row => row.id)).toEqual([ordinary[1]!.id, ordinary[0]!.id]);
    expect((await store.list('alice', 'ordinary', { order: 'desc', after: ordinary[0]!.id })).data.map(row => row.id)).toEqual([ordinary[1]!.id]);
    const indexed = historyRow(9, 9);
    await store.put(indexed, 0);
    for (const row of [ordinary[0]!, indexed]) {
      const changed = { ...row, listOrder: row.listOrder === 'id' ? 'createdAt' as const : 'id' as const, revision: 2 };
      const companion = { ...historyRow(11, 1), collection: 'companion' };
      await expect(store.commit([{ resource: companion, expectedRevision: 0 }, { resource: changed, expectedRevision: 1 }])).rejects.toMatchObject({ status: 409 });
      expect(await store.get('alice', 'companion', companion.id)).toBeUndefined();
      await expect(store.delete({ ...changed, revision: 1 }, [{ resource: companion, expectedRevision: 0 }])).rejects.toMatchObject({ status: 409 });
      expect(await store.get('alice', 'companion', companion.id)).toBeUndefined();
      expect(await store.get('alice', row.collection, row.id)).toEqual(row);
    }
  }));
});
