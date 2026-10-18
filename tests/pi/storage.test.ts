import { describe, expect, it } from 'vitest';
import { registerStorageConformance } from '@earendil-works/pi-durable/testing';
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { MemoryAgentsStore } from '../agents/fixtures.js';
import { SessionRuntimeStore } from '../../src/core/session-runtime-store.js';
import { nativeLease } from '../../src/core/session-native-store.js';
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
