import { createHash } from 'node:crypto';
import { canonicalJson } from '../domain/json.js';
import type { AgentSessionInputParam } from '../domain/agents-api.js';
import type { AgentResource } from './agents-ports.js';
import type { SessionActor } from './session-caller.js';
import type { SessionMessage, SessionObservation, SessionState } from './session-ports.js';
import { planSessionInput } from './session-planning.js';

export type FeedbackEvent = Extract<AgentSessionInputParam, { type: 'agent.session.input.message' }>;
export interface SessionFeedback {
  sessionId: string;
  digest: string;
  events: FeedbackEvent[];
  actor: SessionActor;
  acceptedAtMs: number;
  messages: SessionMessage[];
  turnId: string;
  operationId: string;
}
export const feedbackCollection = (sessionId: string) => `session_feedback:${sessionId}`;
export const feedbackSessionId = (collection: string) => collection.startsWith('session_feedback:') ? collection.slice('session_feedback:'.length) : undefined;
export const feedbackDigest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');

/** Time only controls dispatch eligibility; durable receipt acceptance never waits for this window. */
export function feedbackWindow(inputs: readonly AgentResource<SessionFeedback>[], nowMs: number, force = false) {
  const ordered = [...inputs].sort((a, b) => a.value.acceptedAtMs - b.value.acceptedAtMs || a.id.localeCompare(b.id));
  if (!ordered.length) return { inputs: [], readyAtMs: nowMs, waitMs: 0 };
  const first = ordered[0]!.value.acceptedAtMs;
  const candidates = ordered.filter(input => input.value.acceptedAtMs <= first + 1_000);
  const selected: AgentResource<SessionFeedback>[] = [];
  let bytes = 0;
  for (const input of candidates) {
    const size = Buffer.byteLength(canonicalJson(input.value.messages));
    if (selected.length && (selected.length >= 32 || bytes + size > 256 * 1024)) break;
    selected.push(input); bytes += size;
  }
  const last = selected.at(-1)!.value.acceptedAtMs;
  const full = selected.length < candidates.length || selected.length === 32;
  const readyAtMs = force || full ? nowMs : Math.min(last + 300, first + 1_000);
  return { inputs: selected, readyAtMs, waitMs: Math.max(0, readyAtMs - nowMs) };
}

/** One durable dispatch command carries the batch; every contribution keeps its own receipt and message IDs. */
export function planFeedbackBatch(state: SessionState, observation: SessionObservation, inputs: readonly AgentResource<SessionFeedback>[], now: number, anchors: Record<string, string | null>): SessionState {
  const pending = inputs.filter(input => !state.receipts[input.id]);
  if (!pending.length) return state;
  const leader = pending[0]!;
  const messages = pending.flatMap(input => input.value.messages);
  const failed = observation.session.status === 'failed';
  const planned = planSessionInput(state, failed ? { ...observation, session: { ...observation.session, status: 'idle' }, turns: observation.turns.map(entry => ({ ...entry, turn: { ...entry.turn, status: 'failed' } })) } : observation, [{ type: 'agent.session.input.message', input: messages }], {
    turnIds: [leader.value.turnId], operationIds: [leader.value.operationId], messageIds: messages.map(message => message.id), itemAnchors: anchors,
  }, now);
  const commands = planned.commands;
  let sequence = state.inputSequence ?? 0;
  const receipts = { ...state.receipts };
  for (const input of pending) receipts[input.id] = {
    digest: input.value.digest, commands: !failed && input.id === leader.id ? commands : [], dispatched: failed,
    ...(failed ? { failure: { code: 'session_failed', message: 'The Session failed before this input could be delivered.' } } : {}),
    actor: input.value.actor, provenance: { kind: 'authenticated' }, sequence: ++sequence,
    acceptedAt: input.value.acceptedAtMs / 1_000, batchLeader: leader.id,
    messageIds: input.value.messages.map(message => message.id), turnIds: [...new Set(commands.map(command => command.turnId))],
  };
  if (!failed) return { ...planned.state, receipts, inputSequence: sequence };
  // Preserve accepted contributions in history without restarting a failed Session.
  return { ...planned.state, session: observation.session, receipts, inputSequence: sequence,
    turns: planned.state.turns.map(binding => binding.turn.id === leader.value.turnId ? { ...binding,
      turn: { ...binding.turn, status: 'failed', completed_at: now, error: { code: 'invalid_request', message: 'The Session failed before this input could be delivered.' } },
    } : state.turns.find(previous => previous.turn.id === binding.turn.id) ?? binding) };
}
