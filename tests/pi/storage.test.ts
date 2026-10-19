import { describe, expect, it } from 'vitest';
import { registerStorageConformance } from '@earendil-works/pi-durable/testing';
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { MemoryAgentsStore } from '../agents/fixtures.js';
import { SessionRuntimeStore } from '../../src/core/session-runtime-store.js';
import { nativeLease, nativeDigest, type NativeCommit } from '../../src/core/session-native-store.js';
import { openPiStorage } from '../../src/runner/pi/storage.js';

async function fixture() {
  const store = new MemoryAgentsStore();
  const runtime = new SessionRuntimeStore(store);
  await runtime.claim('owner', 'session', 'run', 1);
  const lease = nativeLease(store, 'owner', 'session', 'run', 0);
  return { store, runtime, lease, storage: await openPiStorage(lease) };
}
registerStorageConformance({ describe, expect, it }, 'Pi host storage conformance', async use => {
  const { storage } = await fixture();
  try { await use(storage); } finally { await storage.close(context); }
});

describe('host acknowledged native storage', () => {
  const change: NativeCommit = { schema: 1, commitId: 'fixed-commit', parent: null, seq: 1, idHighWater: 7, writes: [{ type: 'conversation', value: { id: 1 } }] };

  it('replays reservation receipts and rejects a reused identity with a different count', async () => {
    const f = await fixture();
    expect(await f.lease.reserveIds(3, 'fixed-request')).toEqual({ first: 2, last: 4, count: 3 });
    expect(await f.lease.reserveIds(3, 'fixed-request')).toEqual({ first: 2, last: 4, count: 3 });
    await expect(f.lease.reserveIds(2, 'fixed-request')).rejects.toThrow('ownership');
    expect(await f.lease.reserveIds(1, 'next-request')).toEqual({ first: 5, last: 5, count: 1 });
  });

  it.each(['commit', 'reserve'] as const)('retries four failed %s writes with the same identity and propagates the last failure', async operation => {
    const f = await fixture();
    const failures = Array.from({ length: 4 }, (_, index) => new Error(`failure ${index + 1}`));
    const writes: unknown[] = [];
    f.store.commit = async changes => { writes.push(structuredClone(changes)); throw failures[writes.length - 1]; };
    await expect(operation === 'commit' ? f.lease.commit(change) : f.lease.reserveIds(3, 'fixed-request')).rejects.toBe(failures[3]);
    expect(writes).toHaveLength(4);
    expect(writes).toEqual(Array.from({ length: 4 }, () => writes[0]));
    expect((await f.lease.load()).commits).toEqual([]);
  });

  it('attaches an identical detached commit without rewriting it and preserves reserved high water', async () => {
    const f = await fixture();
    await f.lease.reserveIds(20, 'reservation');
    await f.store.commit([{ resource: { ownerId: 'owner', collection: 'session_native', id: 'session:commit:fixed-commit', createdAt: 0, revision: 1, value: change }, expectedRevision: 0 }]);
    const commit = f.store.commit.bind(f.store);
    const writes: unknown[][] = [];
    f.store.commit = async changes => { writes.push(structuredClone([...changes])); await commit(changes); };
    const head = { seq: 1, commitId: 'fixed-commit', digest: nativeDigest(change) };
    expect(await f.lease.commit(change)).toEqual(head);
    expect(await f.lease.commit(change)).toEqual(head);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toHaveLength(1);
    expect(await f.lease.load()).toEqual({ head, highWater: 21, commits: [change] });
  });

  it('rejects a wrong parent before reading or writing a second immutable commit', async () => {
    const f = await fixture();
    await f.lease.commit(change);
    const read = f.store.get.bind(f.store);
    const reads: string[] = [];
    f.store.get = async (...args) => { reads.push(`${args[1]}:${args[2]}`); return read(...args); };
    f.store.commit = async () => { throw new Error('unexpected write'); };
    await expect(f.lease.commit({ ...change, commitId: 'other' })).rejects.toThrow('ownership');
    expect(reads).toEqual(['session_runtime:session']);
  });

  it('abandons unused durable ID reservations across replacement', async () => {
    const f = await fixture();
    expect(await f.storage.mintId()).toBe(2);
    await f.runtime.claim('owner', 'session', 'replacement', 2, await f.runtime.get('owner', 'session'));
    const next = await openPiStorage(nativeLease(f.store, 'owner', 'session', 'replacement', 1));
    expect(await next.mintId()).toBe(258);
    await expect(f.lease.assertActive()).rejects.toThrow('ownership');
  });
  it('reconciles a lost acknowledgement before applying a committed change', async () => {
    const f = await fixture();
    const commit = f.store.commit.bind(f.store);
    let lose = true;
    f.store.commit = async writes => { await commit(writes); if (lose) { lose = false; throw new Error('lost ack'); } };
    await f.storage.commit([{ type: 'conversation', value: { id: ROOT_CONVERSATION_ID } }], context);
    const recovered = await openPiStorage(f.lease);
    expect(await recovered.conversation(ROOT_CONVERSATION_ID, context)).toEqual({ id: 1 });
    expect((await f.lease.load()).commits).toHaveLength(1);
  });
  it('never applies an unacknowledged commit and poisons the local engine', async () => {
    const f = await fixture();
    f.store.commit = async () => { throw new Error('storage unavailable'); };
    await expect(f.storage.commit([{ type: 'conversation', value: { id: ROOT_CONVERSATION_ID } }], context)).rejects.toThrow('unavailable');
    await expect(f.storage.conversation(ROOT_CONVERSATION_ID, context)).rejects.toThrow('unavailable');
    expect((await f.lease.load()).commits).toEqual([]);
  });
  it('fences late writes and token/effect admission after closure', async () => {
    const f = await fixture();
    await f.runtime.close('owner', 'session');
    await expect(f.lease.reserveIds(1, 'reserve')).rejects.toThrow('ownership');
    await expect(f.lease.assertActive()).rejects.toThrow('ownership');
  });
});
