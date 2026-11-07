import { createHash } from 'node:crypto';
import type { SessionActivity } from '../../src/core/session-activity.js';
import type { AgentSessionItem } from '../../src/domain/agents-api.js';

export type Activity = SessionActivity;
export interface Workload {
  id: string;
  subject: string;
  text: string;
  startedMs: number;
  deadlineMs?: number;
  baselineTurns: readonly string[];
  baselineItems: readonly string[];
}
export type Observation =
  | { state: 'pending' }
  | { state: 'observed'; latencyMs: number; receiptId: string; turnIds: string[] }
  | { state: 'censored'; elapsedMs: number; reason: string };
export type Progress =
  | { state: 'pending' }
  | { state: 'observed'; latencyMs: number; turnId: string; itemId: string; kind: string; attribution: 'unclassified' | 'unique_receipt_for_turn' | 'ambiguous_same_turn' }
  | { state: 'censored'; elapsedMs: number; reason: string };
export interface PeerSample { peer: string; input: Observation; progress: Progress }
export interface Sample {
  id: string;
  writer: string;
  round: number;
  startedMs: number;
  deadlineMs?: number;
  payloadBytes: number;
  textSha256: string;
  acknowledgement: { state: 'pending' } | { state: 'accepted' | 'rejected'; latencyMs: number; httpStatus: number }
    | { state: 'error' | 'timeout'; latencyMs: number; error: string };
  peers: PeerSample[];
}

export const itemKey = (item: AgentSessionItem) => `${item.turn_id}:${item.id}`;
export const digest = (text: string) => createHash('sha256').update(text).digest('hex');
export function receiptFor(activity: Activity, work: Workload) {
  return activity.inputs.filter(receipt => receipt.actor.subject === work.subject &&
    activity.items.flatMap(item => item.type === 'message' && item.role === 'user' && item.id !== null && receipt.message_ids.includes(item.id)
      ? item.content.flatMap(part => part.type === 'input_text' ? [part.text] : []) : []).join('\n') === work.text);
}

export function actualProgress(item: AgentSessionItem): boolean {
  if (item.type === 'message') return item.role === 'assistant' && item.content.some(part => part.type === 'output_text' && part.text.length > 0);
  return item.type !== 'reasoning';
}

/** Full snapshots are inspected, but only exact attributed receipts and fresh output qualify. */
export function observePeer(previous: PeerSample, activity: Activity, work: Workload, nowMs: number): PeerSample {
  if (work.deadlineMs !== undefined && nowMs > work.deadlineMs) return previous;
  const receipts = receiptFor(activity, work);
  if (receipts.length !== 1 || nowMs < work.startedMs) return previous;
  const receipt = receipts[0]!;
  const input: Observation = previous.input.state === 'pending'
    ? { state: 'observed', latencyMs: nowMs - work.startedMs, receiptId: receipt.id, turnIds: [...receipt.turn_ids] } : previous.input;
  const item = activity.items.find(item => item.id !== null && receipt.turn_ids.includes(item.turn_id)
    && !work.baselineTurns.includes(item.turn_id) && !work.baselineItems.includes(itemKey(item)) && actualProgress(item));
  const progress: Progress = previous.progress.state === 'pending' && item?.id
    ? { state: 'observed', latencyMs: nowMs - work.startedMs, turnId: item.turn_id, itemId: item.id,
      kind: item.type, attribution: 'unclassified' } : previous.progress;
  return { ...previous, input, progress };
}

export function finishSample(sample: Sample, nowMs: number, activity: Activity | undefined, reason: string): Sample {
  const finishedMs = Math.min(nowMs, sample.deadlineMs ?? nowMs);
  const attribution = (progress: Extract<Progress, { state: 'observed' }>): typeof progress.attribution => {
    const count = activity?.inputs.filter(input => input.turn_ids.includes(progress.turnId)).length ?? 0;
    return count === 0 ? 'unclassified' : count === 1 ? 'unique_receipt_for_turn' : 'ambiguous_same_turn';
  };
  return { ...sample, peers: sample.peers.map(peer => ({ ...peer,
    input: peer.input.state === 'pending' ? { state: 'censored', elapsedMs: Math.max(0, finishedMs - sample.startedMs), reason } : peer.input,
    progress: peer.progress.state === 'pending' ? { state: 'censored', elapsedMs: Math.max(0, finishedMs - sample.startedMs), reason }
      : peer.progress.state === 'observed' ? { ...peer.progress, attribution: attribution(peer.progress) } : peer.progress,
  })) };
}

export const settled = (activity: Activity) => activity.turns.every(turn => ['completed', 'failed', 'cancelled'].includes(turn.status))
  && activity.inputs.every(input => input.status !== 'accepted');

export function distribution(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) => sorted.length ? sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]! : null;
  return { count: sorted.length, min: sorted[0] ?? null, p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), max: sorted.at(-1) ?? null };
}

export function summarize(samples: readonly Sample[], expectedSubmissions = samples.length) {
  const peers = samples.flatMap(sample => sample.peers);
  return {
    submissions: samples.length,
    expectedSubmissions,
    notStartedSubmissions: Math.max(0, expectedSubmissions - samples.length),
    accepted: samples.filter(sample => sample.acknowledgement.state === 'accepted').length,
    rejected: samples.filter(sample => sample.acknowledgement.state === 'rejected').length,
    errors: samples.filter(sample => ['error', 'timeout', 'pending'].includes(sample.acknowledgement.state)).length,
    acknowledgementMs: distribution(samples.flatMap(sample => sample.acknowledgement.state === 'accepted' ? [sample.acknowledgement.latencyMs] : [])),
    rejectedAcknowledgementMs: distribution(samples.flatMap(sample => sample.acknowledgement.state === 'rejected' ? [sample.acknowledgement.latencyMs] : [])),
    peerInputMs: distribution(peers.flatMap(peer => peer.input.state === 'observed' ? [peer.input.latencyMs] : [])),
    firstProgressMs: distribution(peers.flatMap(peer => peer.progress.state === 'observed' ? [peer.progress.latencyMs] : [])),
    ambiguousProgressSamples: peers.filter(peer => peer.progress.state === 'observed' && peer.progress.attribution === 'ambiguous_same_turn').length,
    censoredPeerInputs: peers.filter(peer => peer.input.state === 'censored').length,
    censoredProgress: peers.filter(peer => peer.progress.state === 'censored').length,
    percentileMethod: 'nearest-rank; observed samples only; rejected/error/censored counts must be reported alongside percentiles',
  };
}
