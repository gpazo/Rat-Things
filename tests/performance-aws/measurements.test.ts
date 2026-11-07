import { describe, expect, it } from 'vitest';
import { distribution, finishSample, observePeer, receiptFor, settled, summarize, type Activity, type PeerSample, type Sample, type Workload } from '../../testing/performance-aws/measurements.js';

const work: Workload = { id: 'fixture-1', subject: 'writer-a', text: 'Sample fixture-1. Reply OK.', startedMs: 100, baselineTurns: ['old-turn'], baselineItems: ['old-turn:old-output'] };
const peer: PeerSample = { peer: 'viewer-0', input: { state: 'pending' }, progress: { state: 'pending' } };
export function activity(): Activity {
  return {
    cursor: 'cursor-1', session: { id: 'session-fixture' },
    turns: [{ id: 'new-turn', status: 'completed', usage: null }],
    inputs: [{ id: 'receipt-a', actor: { id: 'actor-a', subject: work.subject }, sequence: 1, status: 'dispatched', accepted_at: 1, turn_ids: ['new-turn'], message_ids: ['input-a'] }],
    items: [
      { id: 'input-a', type: 'message', role: 'user', turn_id: 'new-turn', content: [{ type: 'input_text', text: work.text }] },
      { id: 'old-output', type: 'message', role: 'assistant', turn_id: 'old-turn', content: [{ type: 'output_text', text: 'Old output.' }] },
      { id: 'new-output', type: 'message', role: 'assistant', turn_id: 'new-turn', content: [{ type: 'output_text', text: 'OK' }] },
    ],
  } as Activity;
}
function sample(overrides: Partial<Sample> = {}): Sample {
  return { id: work.id, writer: 'writer-0', round: 1, startedMs: 100, payloadBytes: 10, textSha256: 'hash', acknowledgement: { state: 'accepted', latencyMs: 3, httpStatus: 204 }, peers: [peer], ...overrides };
}

describe('exact client observations', () => {
  it('requires both actor and exact receipt-linked message, not a substring elsewhere', () => {
    const snapshot = activity();
    expect(receiptFor(snapshot, work)).toHaveLength(1);
    expect(receiptFor(snapshot, { ...work, subject: 'other' })).toHaveLength(0);
    expect(receiptFor(snapshot, { ...work, text: 'fixture-1' })).toHaveLength(0);
    snapshot.inputs[0]!.message_ids = ['unrelated'];
    expect(observePeer(peer, snapshot, work, 104)).toEqual(peer);
  });

  it('excludes prior Turns, empty new assistant messages and reasoning-only state', () => {
    const snapshot = activity();
    snapshot.items = snapshot.items.filter(item => item.id !== 'new-output');
    snapshot.items.push({ id: 'empty', type: 'message', role: 'assistant', turn_id: 'new-turn', content: [{ type: 'output_text', text: '' }] } as Activity['items'][number]);
    snapshot.items.push({ id: 'reason', type: 'reasoning', turn_id: 'new-turn', status: 'in_progress', summary: [] });
    expect(observePeer(peer, snapshot, work, 105)).toMatchObject({ input: { state: 'observed', latencyMs: 5 }, progress: { state: 'pending' } });
    snapshot.inputs[0]!.turn_ids = ['old-turn'];
    expect(observePeer(peer, snapshot, work, 106).progress).toEqual({ state: 'pending' });
  });

  it('keeps first observed timings and labels a Turn shared by multiple receipts ambiguous', () => {
    const snapshot = activity();
    const first = observePeer(peer, snapshot, work, 108);
    expect(observePeer(first, snapshot, work, 200)).toEqual(first);
    snapshot.inputs.push({ ...snapshot.inputs[0]!, id: 'receipt-b', message_ids: ['input-b'] });
    const complete = finishSample(sample({ peers: [first] }), 220, snapshot, 'timeout');
    expect(complete.peers[0]?.progress).toMatchObject({ state: 'observed', latencyMs: 8, attribution: 'ambiguous_same_turn' });
  });

  it('retains rejection, error and censored denominators separately from success percentiles', () => {
    const observed = sample({ peers: [observePeer(peer, activity(), work, 110)] });
    const rejected = finishSample(sample({ id: 'rejected', acknowledgement: { state: 'rejected', latencyMs: 7, httpStatus: 429 } }), 150, activity(), 'submission_rejected');
    const timeout = finishSample(sample({ id: 'timeout', acknowledgement: { state: 'timeout', latencyMs: 50, error: 'request_timeout' } }), 150, activity(), 'timeout');
    const summary = summarize([observed, rejected, timeout]);
    expect(summary).toMatchObject({ submissions: 3, accepted: 1, rejected: 1, errors: 1, censoredPeerInputs: 2, censoredProgress: 2,
      acknowledgementMs: { count: 1, p95: 3 }, rejectedAcknowledgementMs: { count: 1, p95: 7 }, peerInputMs: { count: 1, p95: 10 } });
    expect(rejected.peers[0]?.input).toEqual({ state: 'censored', elapsedMs: 50, reason: 'submission_rejected' });
  });

  it('uses nearest rank without inventing zero for missing observations and waits for receipts', () => {
    expect(distribution([]).p95).toBeNull();
    expect(distribution([0, 1, 2, 10]).p95).toBe(10);
    const snapshot = activity();
    expect(settled(snapshot)).toBe(true);
    snapshot.inputs[0]!.status = 'accepted';
    expect(settled(snapshot)).toBe(false);
  });
});
