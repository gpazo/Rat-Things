import { createHash } from 'node:crypto';
import type { SessionActivity } from '../../src/core/session-activity.js';
import type { AgentSessionItem } from '../../src/domain/agents-api.js';

export interface PendingInputMessage {
  id: string;
  role: string;
  content: Array<{ type?: string; text?: string }>;
  actor?: { id?: string; subject?: string };
  provenance?: { kind?: string };
}
export interface PendingInput { receipt_id: string; messages: PendingInputMessage[] }
export type Activity = SessionActivity & { pending_inputs?: PendingInput[] };
export interface Workload {
  id: string;
  subject: string;
  text: string;
  startedMs: number;
  deadlineMs?: number;
  baselineTurns: readonly string[];
  baselineItems: readonly string[];
}
export type Completion =
  | { state: 'pending'; receiptId?: string; receiptStatus?: string; turnIds?: string[]; turns?: Array<{ turnId: string; status: string; observedAtMs: number }> }
  | { state: 'observed'; receiptId: string; receiptStatus: 'dispatched'; turnIds: string[]; turns: Array<{ turnId: string; status: string; observedAtMs: number }>; fromRequestMs: number; fromAcknowledgementMs: number | null }
  | { state: 'failed'; receiptId: string; receiptStatus: 'failed' | 'dispatched'; turnIds: string[]; turns: Array<{ turnId: string; status: string; observedAtMs: number }>; failure: 'receipt_failed' | 'turn_failed'; fromRequestMs: number; fromAcknowledgementMs: number | null }
  | { state: 'censored'; reason: string; elapsedMs: number };
export type Observation =
  | { state: 'pending' }
  | { state: 'observed'; latencyMs: number; receiptId: string; turnIds: string[] }
  | { state: 'censored'; elapsedMs: number; reason: string };
export type Progress =
  | { state: 'pending' }
  | { state: 'observed'; latencyMs: number; turnId: string; itemId: string; kind: string; attribution: 'unclassified' | 'unique_receipt_for_turn' | 'shared_turn_ambiguous' }
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
  completion?: Completion;
  peers: PeerSample[];
}

const terminalStatus = (status: string) => ['completed', 'failed', 'cancelled'].includes(status);

/** Recompute completion against the current receipt mapping; a rehome invalidates old terminal timing. */
export function observeCompletion(previous: Completion | undefined, activity: Activity, work: Workload, nowMs: number, acknowledgementMs: number | null): Completion {
  if (previous?.state === 'censored') return previous;
  if (work.deadlineMs !== undefined && nowMs > work.deadlineMs) return finishCompletion(previous, work.deadlineMs, work.startedMs, 'deadline');
  const receipts = receiptFor(activity, work);
  if (receipts.length !== 1) return { state: 'pending' };
  const receipt = receipts[0]!;
  const mappedTurns = receipt.turn_ids.map(id => activity.turns.find(turn => turn.id === id)).filter((turn): turn is Activity['turns'][number] => Boolean(turn));
  const sameMapping = previous && 'receiptId' in previous && Array.isArray(previous.turnIds) && previous.receiptId === receipt.id
    && previous.turnIds.length === receipt.turn_ids.length && previous.turnIds.every((id, index) => id === receipt.turn_ids[index]);
  const observedAtMs = sameMapping && previous && 'turns' in previous
    ? new Map(previous.turns.map(turn => [turn.turnId, turn.status === turnStatus(activity, turn.turnId) && terminalStatus(turn.status) ? turn.observedAtMs : nowMs])) : new Map<string, number>();
  const turns = mappedTurns.map(turn => ({ turnId: turn.id, status: turn.status, observedAtMs: terminalStatus(turn.status) ? observedAtMs.get(turn.id) ?? nowMs : nowMs }));
  const base = { receiptId: receipt.id, turnIds: [...receipt.turn_ids], turns,
    fromRequestMs: Math.max(0, nowMs - work.startedMs), fromAcknowledgementMs: acknowledgementMs === null ? null : Math.max(0, nowMs - acknowledgementMs) };
  const stableTerminal = sameMapping && previous && previous.state !== 'pending'
    && previous.receiptStatus === receipt.status && previous.turns.length === turns.length
    && previous.turns.every((turn, index) => turn.turnId === turns[index]!.turnId && turn.status === turns[index]!.status);
  if (stableTerminal) return previous;
  if (receipt.status === 'failed') return { ...base, state: 'failed', receiptStatus: 'failed', failure: 'receipt_failed' };
  if (receipt.status !== 'dispatched' || receipt.turn_ids.length === 0 || mappedTurns.length !== receipt.turn_ids.length) return { state: 'pending', receiptId: receipt.id, receiptStatus: receipt.status, turnIds: [...receipt.turn_ids], turns };
  if (turns.some(turn => ['failed', 'cancelled'].includes(turn.status))) return { ...base, state: 'failed', receiptStatus: 'dispatched', failure: 'turn_failed' };
  if (turns.every(turn => terminalStatus(turn.status))) return { ...base, state: 'observed', receiptStatus: 'dispatched' };
  return { state: 'pending', receiptId: receipt.id, receiptStatus: receipt.status, turnIds: [...receipt.turn_ids], turns };
}

const turnStatus = (activity: Activity, id: string) => activity.turns.find(turn => turn.id === id)?.status;

export function finishCompletion(completion: Completion | undefined, nowMs: number, startedMs: number, reason: string): Completion {
  return completion && completion.state !== 'pending' ? completion : { state: 'censored', elapsedMs: Math.max(0, nowMs - startedMs), reason };
}

/** Require manager completion and every observer's historical input/progress observations before draining. */
export function workloadObserved(sample: Sample, work: Workload, activity: Activity): boolean {
  return receiptFor(activity, work).length === 1 && sample.completion?.state !== 'pending'
    && sample.peers.every(peer => peer.input.state === 'observed' && peer.progress.state === 'observed');
}

export const itemKey = (item: AgentSessionItem) => `${item.turn_id}:${item.id}`;
export const digest = (text: string) => createHash('sha256').update(text).digest('hex');
export function receiptFor(activity: Activity, work: Workload) {
  return activity.inputs.filter(receipt => {
    if (receipt.actor.subject !== work.subject) return false;
    const textsById = new Map<string, string>();
    for (const item of activity.items) if (item.type === 'message' && item.role === 'user' && item.id !== null && receipt.message_ids.includes(item.id)) {
      textsById.set(item.id, item.content.flatMap(part => part.type === 'input_text' ? [part.text] : []).join(''));
    }
    for (const input of activity.pending_inputs ?? []) if (input.receipt_id === receipt.id) for (const message of input.messages) {
      if (message.role === 'user' && receipt.message_ids.includes(message.id) && message.actor?.id === receipt.actor.id
        && message.actor.subject === receipt.actor.subject && message.provenance?.kind === receipt.provenance?.kind) {
        textsById.set(message.id, message.content.flatMap(part => part.type === 'input_text' ? [part.text ?? ''] : []).join(''));
      }
    }
    return [...textsById.values()].join('\n') === work.text;
  });
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
    ? { state: 'observed', latencyMs: nowMs - work.startedMs, receiptId: receipt.id, turnIds: [...receipt.turn_ids] }
    : previous.input.state === 'observed' && previous.input.receiptId === receipt.id
      ? { ...previous.input, turnIds: [...receipt.turn_ids] } : previous.input;
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
    return count === 0 ? 'unclassified' : count === 1 ? 'unique_receipt_for_turn' : 'shared_turn_ambiguous';
  };
  return { ...sample, peers: sample.peers.map(peer => ({ ...peer,
    input: peer.input.state === 'pending' ? { state: 'censored', elapsedMs: Math.max(0, finishedMs - sample.startedMs), reason } : peer.input,
    progress: peer.progress.state === 'pending' ? { state: 'censored', elapsedMs: Math.max(0, finishedMs - sample.startedMs), reason }
      : peer.progress.state === 'observed' ? { ...peer.progress, attribution: attribution(peer.progress) } : peer.progress,
  })) };
}

export const settled = (activity: Activity) => activity.turns.every(turn => ['completed', 'failed', 'cancelled'].includes(turn.status))
  && activity.inputs.every(input => input.status !== 'accepted');

export const receiptsSettled = (activity: Activity) => activity.inputs.every(input => input.status === 'dispatched' || input.status === 'failed');

export function distribution(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) => sorted.length ? sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]! : null;
  return { count: sorted.length, min: sorted[0] ?? null, p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), max: sorted.at(-1) ?? null };
}

export function summarize(samples: readonly Sample[], expectedSubmissions = samples.length) {
  const peers = samples.flatMap(sample => sample.peers);
  const progressByTurn = new Map<string, number>();
  for (const peer of peers) if (peer.progress.state === 'observed') {
    const key = `${peer.progress.turnId}:${peer.progress.itemId}`;
    progressByTurn.set(key, Math.min(progressByTurn.get(key) ?? Infinity, peer.progress.latencyMs));
  }
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
    finalReceiptTurnCompletionFromRequestMs: distribution(samples.flatMap(sample => sample.completion?.state === 'observed' ? [sample.completion.fromRequestMs] : [])),
    finalReceiptTurnCompletionFromAcknowledgementMs: distribution(samples.flatMap(sample => sample.completion?.state === 'observed' && sample.completion.fromAcknowledgementMs !== null ? [sample.completion.fromAcknowledgementMs] : [])),
    completedReceiptTurns: samples.filter(sample => sample.completion?.state === 'observed').length,
    failedReceiptTurns: samples.filter(sample => sample.completion?.state === 'failed').length,
    censoredReceiptTurns: samples.filter(sample => sample.completion?.state === 'censored' || !sample.completion).length,
    firstProgressMs: distribution([...progressByTurn.values()]),
    uniqueProgressItems: progressByTurn.size,
    sharedTurnProgressObservations: peers.filter(peer => peer.progress.state === 'observed' && peer.progress.attribution === 'shared_turn_ambiguous').length,
    perSubmissionProgressObservations: peers.filter(peer => peer.progress.state === 'observed').length,
    censoredPeerInputs: peers.filter(peer => peer.input.state === 'censored').length,
    censoredProgress: peers.filter(peer => peer.progress.state === 'censored').length,
    percentileMethod: 'nearest-rank; observed samples only; rejected/error/censored counts must be reported alongside percentiles',
  };
}
