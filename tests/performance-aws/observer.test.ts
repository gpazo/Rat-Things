import { expect, it } from 'vitest';
import { Frames, frameActivity, observeActivity } from '../../testing/performance-aws/observer.js';
import type { Activity } from '../../testing/performance-aws/measurements.js';

const snapshot = { cursor: 'cursor-fixture', session: { id: 'session-fixture' }, items: [], turns: [], inputs: [] } as unknown as Activity;

it('counts bytes received before a snapshot body fails', async () => {
  let first = true;
  const watcher = observeActivity({ peer: 'viewer-0', sessionId: 'session-fixture', mode: 'persistent', now: () => performance.now(), signal: new AbortController().signal,
    onActivity: () => undefined, request: async () => new Response(new ReadableStream({ pull(controller) {
      if (first) { first = false; controller.enqueue(Buffer.from('partial')); }
      else controller.error(new Error('network failure'));
    } })) });
  await watcher.done;
  expect(watcher.measure.connections[0]).toMatchObject({ bytes: 7, outcome: 'failed' });
  expect(watcher.measure.errors).toEqual(['observer_failure']);
});

it('parses split UTF-8 and CRLF boundaries and ignores permission/heartbeat frames', () => {
  const frames = new Frames();
  const bytes = Buffer.from(`: heartbeat\r\n\r\ndata: ${JSON.stringify({ type: 'rat.space.permissions' })}\r\n\r\ndata: ${JSON.stringify({ activity: { ...snapshot, cursor: 'résumé' } })}\r\n\r\n`);
  const output = [...bytes].flatMap(byte => frames.push(Uint8Array.of(byte))).map(frameActivity).filter(Boolean);
  expect(output).toEqual([{ ...snapshot, cursor: 'résumé' }]);
});

it('measures body bytes and closes a persistent stream on controller stop', async () => {
  let ticks = 0; let cancelled = false;
  let delivered!: () => void;
  const received = new Promise<void>(resolve => { delivered = resolve; });
  const data = Buffer.from(`data: ${JSON.stringify({ activity: snapshot })}\n\n`);
  const watcher = observeActivity({ peer: 'viewer-0', sessionId: 'session-fixture', mode: 'persistent', now: () => ticks++, signal: new AbortController().signal,
    onActivity: (_value, _now) => { delivered(); },
    request: async (path, signal) => path.endsWith('/events')
      ? new Response(new ReadableStream({ start(controller) { controller.enqueue(data); signal.addEventListener('abort', () => controller.close(), { once: true }); }, cancel() { cancelled = true; } }))
      : new Response(JSON.stringify(snapshot)),
  });
  await watcher.ready; await received;
  await watcher.stop();
  expect(watcher.measure.initialSnapshotBytes).toBe(Buffer.byteLength(JSON.stringify(snapshot)));
  expect(watcher.measure.connections.find(value => value.kind === 'stream')).toMatchObject({ bytes: data.byteLength, outcome: 'controller_stop' });
  expect(watcher.measure.connections.every(value => value.occupancyMs !== undefined)).toBe(true);
  expect(watcher.measure.errors).toEqual([]);
  // A closed body may already have delivered EOF; either cancellation or clean abort closes it.
  expect(cancelled || watcher.measure.connections.at(-1)?.endedMs !== undefined).toBe(true);
});

it('retains unexpected clean EOF as an error, not a successful observation period', async () => {
  const watcher = observeActivity({ peer: 'viewer-0', sessionId: 'session-fixture', mode: 'persistent', now: () => 1, signal: new AbortController().signal,
    onActivity: () => undefined, request: async path => new Response(path.endsWith('/events') ? '' : JSON.stringify(snapshot)) });
  await watcher.ready; await watcher.done;
  expect(watcher.measure.errors).toContain('unexpected_stream_end');
  await watcher.stop();
});

it('plays back one-frame desktop reconnects with separate space authority and runtime reads', async () => {
  const paths: string[] = []; const cursors: string[] = [];
  let streams = 0; let cancelled = 0;
  let secondResolve!: () => void;
  const second = new Promise<void>(resolve => { secondResolve = resolve; });
  const watcher = observeActivity({ peer: 'viewer-0', sessionId: 'session-fixture', mode: 'desktop', now: () => performance.now(), signal: new AbortController().signal,
    onActivity: value => { cursors.push(value.cursor); },
    request: async (path, signal) => {
      paths.push(path);
      if (!path.endsWith('/events')) return new Response(JSON.stringify(path.endsWith('/activity') ? snapshot : {}));
      streams += 1;
      if (streams === 2) secondResolve();
      return new Response(new ReadableStream({ start(controller) {
        if (streams === 1) controller.enqueue(Buffer.from(['first', 'ignored'].map(cursor => `data: ${JSON.stringify({ activity: { ...snapshot, cursor } })}\n\n`).join('')));
        else signal.addEventListener('abort', () => controller.close(), { once: true });
      }, cancel() { cancelled += 1; } }));
    },
  });
  await watcher.ready; await second; await watcher.stop();
  expect(paths).toContain('/rat/spaces');
  expect(paths).toContain('/agents/sessions/session-fixture/runtime');
  expect(cursors).toEqual(['cursor-fixture', 'first']);
  expect(cancelled).toBeGreaterThanOrEqual(1);
  expect(watcher.measure.connections.filter(value => value.kind === 'stream')[0]?.outcome).toBe('one_activity_frame');
  expect(watcher.measure.errors).toEqual([]);
});
