import { setTimeout as delay } from 'node:timers/promises';
import type { SessionActivity } from '../../src/core/session-activity.js';
import { actorId, errorCode, outputPrefix, type PerformanceFixture } from './fixture.js';

export interface ExpectedInput { correlation: string; writer: number }
export function inspectActivity(activity: SessionActivity, expected: readonly ExpectedInput[]) {
  const expectations = new Map(expected.map(input => [input.correlation, input]));
  const accepted: Array<{ correlation: string; messageId: string; receiptId: string }> = [];
  const outputs: string[] = [];
  const errors: string[] = [];
  for (const item of activity.items) {
    if (item.type !== 'message') continue;
    const texts = item.content.flatMap(part => part.type === 'input_text' || part.type === 'output_text' ? [part.text] : []);
    for (const text of texts) {
      const input = expectations.get(text);
      if (item.role === 'user' && input) {
        if (!item.id) { errors.push(`missing_message_id:${input.correlation}`); continue; }
        const id = item.id;
        const receipts = activity.inputs.filter(receipt => receipt.message_ids.includes(id));
        if (receipts.length !== 1 || receipts[0]!.actor.id !== actorId(`writer-${input.writer}`) || receipts[0]!.provenance?.kind !== 'authenticated') errors.push(`wrong_attribution:${input.correlation}`);
        else accepted.push({ correlation: input.correlation, messageId: item.id, receiptId: receipts[0]!.id });
      }
      if (item.role === 'assistant' && text.startsWith(outputPrefix) && expectations.has(text.slice(outputPrefix.length))) outputs.push(text.slice(outputPrefix.length));
    }
  }
  for (const correlation of expectations.keys()) {
    if (accepted.filter(value => value.correlation === correlation).length > 1) errors.push(`duplicate_input:${correlation}`);
    if (outputs.filter(value => value === correlation).length > 1) errors.push(`duplicate_output:${correlation}`);
  }
  return { accepted, outputs, errors };
}

export interface Observer {
  viewer: number; ready: boolean; bytes: number; connections: number; authRefreshes: number; frames: number; cursor?: string;
  accepted: Map<string, { at: number; messageId: string; receiptId: string }>; outputs: Map<string, number>;
  errors: string[]; semanticErrors: Set<string>; done: Promise<void>; stop(): void;
}

/** Playback of current desktop subscription behavior, not an execution of the native UI. */
export function observe(fixture: PerformanceFixture, viewer: number, expected: ExpectedInput[], mode: 'persistent' | 'desktop', deadline: AbortSignal): Observer {
  const stop = new AbortController();
  const signal = AbortSignal.any([deadline, stop.signal]);
  const state: Observer = { viewer, ready: false, bytes: 0, connections: 0, authRefreshes: 0, frames: 0, accepted: new Map(), outputs: new Map(), errors: [], semanticErrors: new Set(), done: Promise.resolve(), stop: () => stop.abort() };
  const actor = `viewer-${viewer}`;
  const consume = (data: string) => {
    const event = JSON.parse(data) as { type: string; event_id?: string; activity?: SessionActivity };
    state.frames++;
    if (event.type !== 'rat.session.activity' || !event.activity) return false;
    if (event.event_id !== event.activity.cursor || event.activity.session.id !== fixture.sessionId) throw new Error('Activity cursor or Session mismatch');
    const proofs = inspectActivity(event.activity, expected);
    for (const error of proofs.errors) state.semanticErrors.add(error);
    for (const proof of proofs.accepted) {
      const previous = state.accepted.get(proof.correlation);
      if (previous && (previous.messageId !== proof.messageId || previous.receiptId !== proof.receiptId)) state.semanticErrors.add(`changed_identity:${proof.correlation}`);
      if (!previous) state.accepted.set(proof.correlation, { at: performance.now(), messageId: proof.messageId, receiptId: proof.receiptId });
    }
    for (const correlation of proofs.outputs) if (!state.outputs.has(correlation)) state.outputs.set(correlation, performance.now());
    state.cursor = event.activity.cursor; state.ready = true; return true;
  };
  const refresh = mode === 'desktop' ? (async () => {
    while (!signal.aborted) {
      await delay(2000, undefined, { signal });
      const response = await fixture.request('/v1/rat/spaces', actor, { signal });
      state.authRefreshes++; await response.arrayBuffer();
      if (!response.ok) throw new Error(`Permission refresh HTTP ${response.status}`);
    }
  })().catch(error => { if (!signal.aborted) { state.errors.push(`auth:${errorCode(error)}`); stop.abort(); } }) : Promise.resolve();
  const stream = (async () => {
    let nextSnapshot = performance.now() + 15_000;
    while (!signal.aborted) {
      if (mode === 'desktop' && performance.now() >= nextSnapshot) { delete state.cursor; nextSnapshot = performance.now() + 15_000; }
      const connection = new AbortController();
      const idle = mode === 'desktop' ? AbortSignal.timeout(20_000) : undefined;
      const connectionSignal = AbortSignal.any([signal, connection.signal, ...(idle ? [idle] : [])]);
      let readActivity = false;
      try {
        state.connections++;
        const response = await fixture.request(`/v1/rat/sessions/${fixture.sessionId}/activity/events`, actor, { signal: connectionSignal, ...(state.cursor ? { cursor: state.cursor } : {}) });
        if (!response.ok || !response.body) throw new Error(`Stream HTTP ${response.status}`);
        const reader = response.body.getReader();
        const decoder = new TextDecoder(); let buffer = '';
        try {
          while (!connectionSignal.aborted) {
            const next = await reader.read();
            if (next.done) throw new Error('Unexpected stream closure');
            state.bytes += next.value.byteLength; buffer += decoder.decode(next.value, { stream: true });
            if (buffer.length > 8 * 1024 * 1024) throw new Error('Oversized activity frame');
            let boundary: number;
            while ((boundary = buffer.indexOf('\n\n')) >= 0) {
              const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
              const data = frame.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n');
              if (data) readActivity = consume(data) || readActivity;
              if (mode === 'desktop' && readActivity) break;
            }
            if (mode === 'desktop' && readActivity) break;
          }
        } finally { connection.abort(); await reader.cancel().catch(() => {}); }
      } catch (error) {
        if (signal.aborted) break;
        if (!(mode === 'desktop' && idle?.aborted)) throw error;
      } finally { connection.abort(); }
      if (mode === 'desktop' && !signal.aborted) {
        if (!readActivity) delete state.cursor;
        await delay(readActivity ? 50 : 1000, undefined, { signal });
      }
    }
  })().catch(error => { if (!signal.aborted) state.errors.push(`stream:${errorCode(error)}`); stop.abort(); });
  state.done = Promise.all([stream, refresh]).then(() => undefined);
  return state;
}
