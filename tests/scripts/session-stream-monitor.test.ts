import { expect, it } from 'vitest';
import { monitorSessionStream } from '../../testing/aws/session-stream-monitor.js';

it('retains observed events but rejects an unexpected clean stream end', async () => {
  const received: number[] = [];
  const monitor = monitorSessionStream((async function* () { yield 1; })(), new AbortController().signal, value => received.push(value));
  await monitor.done;
  expect(received).toEqual([1]);
  expect(monitor.check).toThrow('ended before the probe cancelled it');
});

it('preserves a transport failure for the probe to report', async () => {
  const failure = new Error('Disconnected');
  const monitor = monitorSessionStream((async function* () { yield 1; throw failure; })(), new AbortController().signal, () => {});
  await monitor.done;
  expect(monitor.check).toThrow(failure);
});

it('allows the probe to close its own subscription', async () => {
  const abort = new AbortController();
  const monitor = monitorSessionStream((async function* () { yield 1; })(), abort.signal, () => abort.abort());
  await monitor.done;
  expect(monitor.check).not.toThrow();
});

it('does not confuse an undefined rejection with the absence of failure', async () => {
  const monitor = monitorSessionStream((async function* () { yield 1; throw undefined; })(), new AbortController().signal, () => {});
  await monitor.done;
  expect(monitor.check).toThrow('Live Session stream failed.');
});
