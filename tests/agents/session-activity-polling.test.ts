import { expect, it, vi } from 'vitest';
import { SessionActivityPolling } from '../../src/core/session-activity-polling.js';
import type { SessionActivity } from '../../src/core/session-activity.js';

it('coalesces projection work and releases cached history when the last viewer leaves', async () => {
  const polling = new SessionActivityPolling();
  const load = vi.fn(async () => ({ cursor: 'one' }) as SessionActivity);
  const a = polling.subscribe('session', 500, load);
  const b = polling.subscribe('session', 500, load);
  expect(await Promise.all([a.read(), b.read()])).toEqual([{ cursor: 'one' }, { cursor: 'one' }]);
  expect(load).toHaveBeenCalledTimes(1);
  (await a.read()).cursor = 'mutated';
  expect((await b.read()).cursor).toBe('one');
  a.release(); b.release();
  const next = polling.subscribe('session', 500, load);
  await next.read();
  expect(load).toHaveBeenCalledTimes(2);
  next.release();
});

it('never retains failed reads or unbounded large projections', async () => {
  const polling = new SessionActivityPolling();
  const load = vi.fn<() => Promise<SessionActivity>>().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ cursor: 'x'.repeat(1024 * 1024 + 1) } as SessionActivity);
  const stream = polling.subscribe('session', 500, load);
  await expect(stream.read()).rejects.toThrow('offline');
  await stream.read(); await stream.read();
  expect(load).toHaveBeenCalledTimes(3);
  stream.release();
});
