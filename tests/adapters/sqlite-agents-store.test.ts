import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SqliteAgentsStore } from '../../src/adapters/sqlite-agents-store.js';

describe('local durable storage', () => {
  it('preserves encrypted owner-scoped resources, ordered pagination and atomic revision checks across restarts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rat-local-store-'));
    let store = new SqliteAgentsStore(directory);
    const resource = (id: string, ownerId = 'alice') => ({ id, ownerId, collection: 'agents', createdAt: 10, revision: 1, value: { prompt: 'PRIVATE_LOCAL_PROMPT' } });
    try {
      await store.commit(['a', 'b', 'c'].map(id => ({ resource: resource(id), expectedRevision: 0 })));
      await store.put(resource('a', 'bob'), 0);
      await expect(store.commit([
        { resource: resource('d'), expectedRevision: 0 },
        { resource: { ...resource('a'), revision: 1 }, expectedRevision: 0 },
      ])).rejects.toMatchObject({ status: 409 });
      expect(await store.get('alice', 'agents', 'd')).toBeUndefined();
      await expect(store.delete({ ...resource('a'), revision: 2 })).rejects.toMatchObject({ status: 409 });
      expect((await store.list('alice', 'agents', { limit: 2, order: 'asc' })).data.map(row => row.id)).toEqual(['a', 'b']);
      expect((await store.list('alice', 'agents', { after: 'b', order: 'asc' })).data.map(row => row.id)).toEqual(['c']);
      expect((await store.list('alice', 'agents', { after: 'c' })).data.map(row => row.id)).toEqual(['b', 'a']);
      await expect(store.list('alice', 'agents', { after: 'missing' })).rejects.toMatchObject({ status: 400 });
      store.close();
      expect((await readFile(join(directory, 'agents.sqlite'))).toString()).not.toContain('PRIVATE_LOCAL_PROMPT');
      expect((await stat(join(directory, 'agents.sqlite'))).mode & 0o777).toBe(0o600);
      store = new SqliteAgentsStore(directory);
      expect((await store.get('alice', 'agents', 'a'))?.value).toEqual({ prompt: 'PRIVATE_LOCAL_PROMPT' });
      expect(await store.get('mallory', 'agents', 'a')).toBeUndefined();
      await store.delete(resource('a'), [{ resource: resource('d'), expectedRevision: 0 }]);
      expect(await store.get('alice', 'agents', 'a')).toBeUndefined();
      expect(await store.get('bob', 'agents', 'a')).toBeDefined();
    } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('fences a second dispatcher and permits a clean restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rat-local-lease-'));
    const first = new SqliteAgentsStore(directory);
    const second = new SqliteAgentsStore(directory);
    try {
      first.acquireServerLease();
      expect(() => second.acquireServerLease()).toThrow('already running');
      first.close(true);
      second.acquireServerLease();
    } finally { second.close(true); await rm(directory, { recursive: true, force: true }); }
  });

  it('does not replace a missing key when an encrypted workspace already exists', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rat-local-key-'));
    try {
      new SqliteAgentsStore(directory).close();
      await rm(join(directory, 'storage.key'));
      expect(() => new SqliteAgentsStore(directory)).toThrow('storage key is missing');
      await expect(stat(join(directory, 'storage.key'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('retains the dispatcher lease until admitted installation work settles', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rat-local-drain-'));
    const first = new SqliteAgentsStore(directory);
    const second = new SqliteAgentsStore(directory);
    let finish!: () => void;
    const blocked = new Promise<void>(resolve => { finish = resolve; });
    try {
      await expect(first.runWhileServerLeaseHeld(async () => {})).rejects.toThrow('lease');
      first.acquireServerLease();
      const work = first.runWhileServerLeaseHeld(async () => {
        await blocked;
        first.assertServerLease();
        return 'installed';
      });
      const draining = first.drainServerLease();
      await expect(first.runWhileServerLeaseHeld(async () => {})).rejects.toThrow('shutting down');
      expect(() => first.close(true)).toThrow('still running');
      expect(() => second.acquireServerLease()).toThrow('already running');
      finish();
      expect(await work).toBe('installed');
      await draining;
      first.close(true);
      expect(() => first.assertServerLease()).toThrow('lease');
      second.acquireServerLease();
    } finally { finish(); first.close(true); second.close(true); await rm(directory, { recursive: true, force: true }); }
  });

  it('drains failed retained work and does not release another store instance’s lease', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rat-local-failed-work-'));
    const owner = new SqliteAgentsStore(directory);
    const other = new SqliteAgentsStore(directory);
    try {
      owner.acquireServerLease();
      other.close(true);
      owner.assertServerLease();
      const failed = owner.runWhileServerLeaseHeld(async () => { throw new Error('probe failed'); });
      const draining = owner.drainServerLease();
      await expect(failed).rejects.toThrow('probe failed');
      await draining;
      owner.assertServerLease();
      owner.close(true);
    } finally { owner.close(true); other.close(); await rm(directory, { recursive: true, force: true }); }
  });
});
