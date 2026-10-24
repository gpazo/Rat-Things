import { expect, it } from 'vitest';
import { LocalRuntimeLifecycle } from '../../src/adapters/local-runtime-lifecycle.js';

it('drains queued storage operations before shutdown and rejects new work', async () => {
  const lifecycle = new LocalRuntimeLifecycle();
  const effects: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = lifecycle.run('session', async () => { effects.push('start'); await gate; throw new Error('Boot failed'); });
  const failure = expect(first).rejects.toThrow('Boot failed');
  const next = lifecycle.run('session', async () => { effects.push('snapshot'); });
  const closed = lifecycle.close(async () => { effects.push('stop'); });
  await expect(lifecycle.run('session', async () => { effects.push('unexpected'); })).rejects.toThrow('shutting down');
  expect(effects).toEqual(['start']);
  release();
  await Promise.all([failure, next, closed]);
  expect(effects).toEqual(['start', 'snapshot', 'stop']);
});
