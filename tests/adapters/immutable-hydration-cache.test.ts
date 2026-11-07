import { expect, it, vi } from 'vitest';
import { ImmutableHydrationCache } from '../../src/adapters/immutable-hydration-cache.js';

it('coalesces concurrent loads and returns independently mutable clones', async () => {
  const cache = new ImmutableHydrationCache();
  let release!: (value: { nested: { count: number } }) => void;
  const load = vi.fn(() => new Promise<{ nested: { count: number } }>(resolve => { release = resolve; }));
  const first = cache.get('same', load); const second = cache.get('same', load);
  release({ nested: { count: 1 } });
  const [a, b] = await Promise.all([first, second]);
  a.nested.count = 9;
  expect(b.nested.count).toBe(1); expect(load).toHaveBeenCalledTimes(1);
  expect((await cache.get('same', load)).nested.count).toBe(1);
});

it('does not retain failed promises and retries the reference', async () => {
  const cache = new ImmutableHydrationCache(); const load = vi.fn().mockRejectedValueOnce(new Error('temporary')).mockResolvedValue({ ok: true });
  await expect(cache.get('same', load)).rejects.toThrow('temporary');
  await expect(cache.get('same', load)).resolves.toEqual({ ok: true });
  expect(load).toHaveBeenCalledTimes(2);
});

it('bounds entries and bytes, evicts least recently used values and bypasses oversized values', async () => {
  const cache = new ImmutableHydrationCache({ maxEntries: 1, maxBytes: 40, maxEntryBytes: 20 });
  const read = (key: string, value: unknown) => cache.get(key, async () => value);
  await read('a', { v: 1 }); await read('b', { v: 2 });
  expect(cache.currentBytes).toBeLessThanOrEqual(40);
  await read('large', { value: 'this is much too large' });
  expect(cache.currentBytes).toBeLessThanOrEqual(40);
  expect(await read('b', { v: 3 })).toEqual({ v: 2 });
});

it('separates keys supplied by distinct owners and references', async () => {
  const cache = new ImmutableHydrationCache();
  await cache.get('bucket-a|owner-a|ref-a', async () => 'a');
  await cache.get('bucket-a|owner-b|ref-a', async () => 'b');
  await cache.get('bucket-b|owner-a|ref-a', async () => 'c');
  expect(await cache.get('bucket-a|owner-b|ref-a', async () => 'wrong')).toBe('b');
  expect(await cache.get('bucket-b|owner-a|ref-a', async () => 'wrong')).toBe('c');
});

it('can disable caching and coalescing for matched baseline measurements', async () => {
  const cache = new ImmutableHydrationCache({ enabled: false }); const load = vi.fn(async () => ({ x: 1 }));
  await cache.get('same', load); await cache.get('same', load);
  expect(load).toHaveBeenCalledTimes(2);
});
