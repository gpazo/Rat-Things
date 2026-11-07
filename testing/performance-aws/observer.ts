import { setTimeout as delay } from 'node:timers/promises';
import type { Activity } from './measurements.js';

export interface ConnectionMeasurement {
  kind: 'stream' | 'snapshot' | 'runtime' | 'authority'; startedMs: number; endedMs?: number;
  occupancyMs?: number; bytes: number; status?: number; outcome?: string;
}
export interface ObserverMeasurement {
  peer: string; mode: 'persistent' | 'desktop'; connections: ConnectionMeasurement[];
  initialSnapshotBytes: number | null; activityFrames: number; errors: string[]; auxiliaryErrors: string[];
}
export type Request = (path: string, signal: AbortSignal, headers?: Record<string, string>) => Promise<Response>;

/** Accept LF and CRLF, including a CRLF split across network chunks. */
export class Frames {
  private pending = '';
  private decoder = new TextDecoder();
  push(bytes: Uint8Array): string[] {
    this.pending += this.decoder.decode(bytes, { stream: true });
    const frames: string[] = [];
    for (;;) {
      const match = /\r?\n\r?\n/.exec(this.pending);
      if (!match || match.index === undefined) break;
      frames.push(this.pending.slice(0, match.index));
      this.pending = this.pending.slice(match.index + match[0].length);
    }
    if (this.pending.length > 32 * 1024 * 1024) throw new Error('frame_limit');
    return frames;
  }
}

export function frameActivity(frame: string): Activity | undefined {
  const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
  if (!data || data === '[DONE]') return;
  const event = JSON.parse(data) as { activity?: Activity; session?: unknown; error?: unknown };
  if (event.error) throw new Error('activity_error_event');
  return event.activity ?? (event.session ? event as Activity : undefined);
}

export function observeActivity(options: {
  peer: string; sessionId: string; mode: 'persistent' | 'desktop'; request: Request; now: () => number;
  onActivity: (activity: Activity, nowMs: number) => void; signal: AbortSignal;
}) {
  const stop = new AbortController();
  const signal = AbortSignal.any([stop.signal, options.signal]);
  const measure: ObserverMeasurement = { peer: options.peer, mode: options.mode, connections: [], initialSnapshotBytes: null, activityFrames: 0, errors: [], auxiliaryErrors: [] };
  let latest: Activity | undefined;
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  // The caller awaits ready, but attach immediately so a second observer's failure cannot become unhandled.
  void ready.catch(() => undefined);
  const path = `/rat/sessions/${options.sessionId}/activity`;
  const accept = (activity: Activity) => { latest = activity; measure.activityFrames += 1; options.onActivity(activity, options.now()); };
  const request = async (kind: ConnectionMeasurement['kind'], url: string, requestSignal: AbortSignal, headers?: Record<string, string>) => {
    const record: ConnectionMeasurement = { kind, startedMs: options.now(), bytes: 0 };
    measure.connections.push(record);
    const close = (outcome: string) => { record.endedMs = options.now(); record.occupancyMs = record.endedMs - record.startedMs; record.outcome = outcome; };
    const headerTimeout = new AbortController();
    const timer = setTimeout(() => headerTimeout.abort(), 30_000);
    try { const response = await options.request(url, AbortSignal.any([requestSignal, headerTimeout.signal]), headers); record.status = response.status; return { response, record, close }; }
    catch (error) { close(requestSignal.aborted ? 'aborted' : 'network_error'); throw error; }
    finally { clearTimeout(timer); }
  };
  const jsonRequest = async (kind: 'snapshot' | 'runtime' | 'authority', url: string) => {
    const call = await request(kind, url, AbortSignal.any([signal, AbortSignal.timeout(30_000)]));
    try {
      const chunks: Uint8Array[] = [];
      const reader = call.response.body?.getReader();
      if (reader) try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          call.record.bytes += chunk.value.byteLength;
          if (call.record.bytes > 32 * 1024 * 1024) throw new Error('frame_limit');
          chunks.push(chunk.value);
        }
      } finally { await reader.cancel().catch(() => undefined); }
      const bytes = Buffer.concat(chunks);
      if (!call.response.ok) throw new Error(`http_${call.response.status}`);
      call.close('complete');
      if (kind === 'snapshot') {
        measure.initialSnapshotBytes ??= bytes.byteLength;
        return JSON.parse(new TextDecoder().decode(bytes)) as Activity;
      }
    } catch (error) { call.close('failed'); throw error; }
  };
  const authority = options.mode === 'desktop' ? (async () => {
    while (!signal.aborted) {
      try { await jsonRequest('authority', '/rat/spaces'); await delay(2_000, undefined, { signal }); }
      catch { if (!signal.aborted) { measure.errors.push('authority_refresh_failed'); stop.abort(); } }
    }
  })() : Promise.resolve();
  const done = (async () => {
    let cursor: string | undefined;
    let lastSnapshot = -Infinity;
    try {
      while (!signal.aborted) {
        if (cursor === undefined || options.mode === 'desktop' && options.now() - lastSnapshot >= 15_000) {
          const activity = (await jsonRequest('snapshot', path))!;
          accept(activity); cursor = activity.cursor; lastSnapshot = options.now();
          // Native activity remains usable when optional runtime metadata fails.
          if (options.mode === 'desktop') await jsonRequest('runtime', `/agents/sessions/${options.sessionId}/runtime`).catch(() => {
            if (!signal.aborted) measure.auxiliaryErrors.push('runtime_snapshot_failed');
          });
        }
        const timeout = options.mode === 'desktop' ? AbortSignal.timeout(20_000) : undefined;
        const requestSignal = AbortSignal.any([signal, ...(timeout ? [timeout] : [])]);
        const call = await request('stream', `${path}/events`, requestSignal, { 'Last-Event-ID': cursor });
        if ([409, 410].includes(call.response.status) && options.mode === 'desktop') {
          await call.response.body?.cancel(); call.close('cursor_reset'); cursor = undefined; continue;
        }
        if (!call.response.ok || !call.response.body) { await call.response.body?.cancel(); call.close('http_error'); throw new Error(`http_${call.response.status}`); }
        readyResolve();
        const reader = call.response.body.getReader();
        const frames = new Frames();
        let received = false;
        let outcome = 'stream_error';
        try {
          loop: while (!signal.aborted) {
            const chunk = await reader.read();
            if (chunk.done) break;
            call.record.bytes += chunk.value.byteLength;
            for (const frame of frames.push(chunk.value)) {
              const activity = frameActivity(frame);
              if (!activity) continue;
              accept(activity); cursor = activity.cursor; received = true;
              if (options.mode === 'desktop') break loop;
            }
          }
          outcome = signal.aborted ? 'controller_stop' : received && options.mode === 'desktop' ? 'one_activity_frame' : 'eof';
        } catch (error) {
          outcome = signal.aborted ? 'controller_stop' : timeout?.aborted ? 'idle_timeout' : 'stream_error';
          if (!signal.aborted && !timeout?.aborted) throw error;
        } finally { await reader.cancel().catch(() => undefined); call.close(outcome); }
        if (signal.aborted) break;
        if (options.mode === 'persistent') throw new Error('unexpected_stream_end');
        if (!received) cursor = undefined;
        await delay(received ? 50 : 1_000, undefined, { signal });
      }
    } catch (error) {
      if (!signal.aborted) {
        // Never persist exception messages: a remote body or URL could contain private data.
        measure.errors.push(error instanceof Error && /^(http_\d{3}|unexpected_stream_end|activity_error_event|frame_limit)$/.test(error.message) ? error.message : 'observer_failure');
      }
    } finally { readyReject(new Error('Observer stopped before ready.')); stop.abort(); await authority; }
  })();
  return { ready, done, measure, latest: () => latest, stop: async () => { stop.abort(); await done; } };
}
