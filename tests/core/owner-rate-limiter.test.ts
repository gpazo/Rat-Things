import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { OwnerRateLimiter } from '../../src/core/owner-rate-limiter.js';
import { ownerRateLimits } from '../../src/app/owner-rate-limits.js';
import { SqliteAgentsStore } from '../../src/adapters/sqlite-agents-store.js';
import { MemoryAgentsStore } from '../agents/fixtures.js';

it('atomically limits concurrent owners, survives restart and retains idempotency across windows', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rat-rate-limit-'));
  let store = new SqliteAgentsStore(root);
  let now = 61;
  const limiter = () => new OwnerRateLimiter(store, () => 3, { now: () => now });
  try {
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => limiter().admit('alice', `request-${i}`)));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(3);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(9);
    await limiter().admit('bob', 'request-0');
    store.close(); store = new SqliteAgentsStore(root);
    await limiter().admit('alice', 'request-0');
    await expect(limiter().admit('alice', 'new')).rejects.toMatchObject({ status: 429, retryAfterSeconds: 59 });
    now = 59;
    await expect(limiter().admit('alice', 'clock-backwards')).rejects.toMatchObject({ status: 429 });
    now = 120;
    await limiter().admit('alice', 'request-0');
    await limiter().admit('alice', 'new', 3);
    await expect(limiter().admit('alice', 'new', 1)).rejects.toMatchObject({ code: 'idempotency_conflict' });
    await expect(limiter().admit('alice', 'excess')).rejects.toMatchObject({ status: 429 });
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

it('recovers lost transaction acknowledgements and fails closed on storage failure', async () => {
  const store = new MemoryAgentsStore();
  const commit = store.commit.bind(store);
  vi.spyOn(store, 'commit').mockImplementationOnce(async writes => { await commit(writes); throw new Error('Lost acknowledgement'); });
  const limiter = new OwnerRateLimiter(store, () => 1);
  await limiter.admit('alice', 'first');
  await limiter.admit('alice', 'first');
  await expect(limiter.admit('alice', 'second')).rejects.toMatchObject({ status: 429 });
  vi.spyOn(store, 'get').mockRejectedValue(new Error('Storage unavailable'));
  await expect(limiter.admit('bob', 'first')).rejects.toThrow('Storage unavailable');
});

it('takes per-owner limits only from validated operator configuration', () => {
  const limits = ownerRateLimits('{"default":12,"owners":{"alice":0,"bob":30}}');
  expect([limits('alice'), limits('bob'), limits('carol')]).toEqual([0, 30, 12]);
  for (const input of ['null', '{"default":-1}', '{"default":"100"}', '{"owners":{"alice":1.5}}', '{"ignored":true}']) {
    expect(() => ownerRateLimits(input)).toThrow();
  }
});

it('preserves absent defaults, zero limits and literal owner names', () => {
  for (const input of [undefined, '', '{}', '{"default":null}']) {
    expect(ownerRateLimits(input)('alice')).toBe(60);
  }
  const limits = ownerRateLimits('{"default":0,"owners":{"alice":12,"__proto__":3,"constructor":4}}');
  expect(['alice', '__proto__', 'constructor', 'bob'].map(limits)).toEqual([12, 3, 4, 0]);
  expect(ownerRateLimits('{"default":9007199254740991}')('alice')).toBe(Number.MAX_SAFE_INTEGER);
});

it('distinguishes invalid configuration shapes from invalid counts', () => {
  for (const input of ['[]', 'false', '{"owners":null}', '{"owners":[]}', '{"owners":true}']) {
    expect(() => ownerRateLimits(input)).toThrow('Invalid OWNER_RATE_LIMITS_JSON');
  }
  for (const input of ['{"default":false}', '{"default":9007199254740992}', '{"owners":{"alice":null}}', '{"owners":{"alice":"0"}}']) {
    expect(() => ownerRateLimits(input)).toThrow('Owner rate limits must be nonnegative integers');
  }
});
