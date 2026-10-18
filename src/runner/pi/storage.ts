import { randomUUID } from 'node:crypto';
import { MemoryStorage, type Id, type Seq, type Storage, type StorageWrite } from '@earendil-works/pi-durable';
import type { Context } from '@earendil-works/chord';
import type { NativeHead, NativeLease } from '../../core/session-native-store.js';

export async function openPiStorage(lease: NativeLease): Promise<Storage> {
  const memory = new MemoryStorage();
  const image = await lease.load();
  for (const commit of image.commits) memory.prepareCommit(commit.writes as StorageWrite[], commit.seq as Seq).apply();
  let head: NativeHead | null = image.head;
  let poisoned: unknown;
  let highWater = image.highWater;
  let closed = false;
  let next = 0;
  let last = -1;
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(effect: () => Promise<T>): Promise<T> => {
    const result = queue.then(async () => {
      if (poisoned) throw poisoned;
      if (closed) throw new Error('Storage is closed');
      return effect();
    });
    queue = result.catch(() => undefined);
    return result;
  };
  return new Proxy(memory, {
    get(target, key) {
      if (key === 'commit') return (writes: readonly StorageWrite[], _context: Context) => serialize(async () => {
        const prepared = memory.prepareCommit(writes, ((head?.seq ?? 0) + 1) as Seq);
        const storedMax = Math.max(1, ...prepared.writes.map(write => 'value' in write ? write.value.id : 'record' in write ? write.record.id : write.id));
        highWater = Math.max(highWater, storedMax);
        if (storedMax >= next) { next = storedMax + 1; }
        try { head = await lease.commit({ schema: 1, commitId: randomUUID(), parent: head, seq: prepared.seq, idHighWater: highWater, writes: prepared.writes }); }
        catch (error) { poisoned = error; throw error; }
        return prepared.apply();
      });
      if (key === 'mintId') return <I extends Id<string>>() => serialize(async () => {
        if (next > last) {
          try { const range = await lease.reserveIds(256, randomUUID()); next = range.first; last = range.last; highWater = last; }
          catch (error) { poisoned = error; throw error; }
        }
        return next++ as I;
      });
      if (key === 'close') return async (context: Context) => { closed = true; await memory.close(context); };
      const method: unknown = Reflect.get(target, key);
      return typeof method === 'function' ? (...args: unknown[]) => {
        if (poisoned) return Promise.reject(poisoned);
        return Reflect.apply(method, target, args);
      } : method;
    },
  });
}
