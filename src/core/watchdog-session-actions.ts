import { createHash } from 'node:crypto';
import type { AgentsStore } from './agents-ports.js';
import type { OwnerRateLimit } from './owner-rate-limiter.js';
import type { SessionStreamSnapshot } from './session-stream.js';
import type { SessionState } from './session-ports.js';
import { observeSession, planSessionInput, terminalTurn } from './session-planning.js';
import { watchdogDigest, watchdogRetryEligible, watchdogRetryKey } from './watchdog-planning.js';
import type { WatchdogCandidate, WatchdogPolicy } from '../domain/watchdog.js';
import type { SessionIntegrationState } from '../domain/session-integrations.js';
import { canonicalJson } from '../domain/json.js';

export async function applyWatchdogAction(store: AgentsStore, rateLimit: OwnerRateLimit, candidate: WatchdogCandidate, action: 'retry' | 'cancel', now: number, policy: WatchdogPolicy): Promise<boolean> {
  if (!candidate.sessionId || !candidate.turnId) return false;
  const resource = await store.get<SessionState>(candidate.ownerId, 'sessions', candidate.sessionId);
  if (!resource) return false;
  const state = resource.value;
  const key = `watchdog_${hash(action === 'retry' ? watchdogRetryKey(candidate.turnId) : `watchdog-cancel:${candidate.turnId}`)}`;
  if (state.receipts[key]) return true;
  const binding = state.turns.find(entry => entry.turn.id === candidate.turnId);
  let observationRevision: number | undefined;
  if (action === 'retry') {
    if (!watchdogRetryEligible(state, binding, now, policy)) return false;
  } else {
    const snapshot = await store.get<SessionStreamSnapshot>(candidate.ownerId, 'session_observations', candidate.sessionId);
    if (!snapshot || !candidate.digest || canonicalJson(watchdogDigest(snapshot.value.items.filter(item => item.turn_id === candidate.turnId))) !== canonicalJson(candidate.digest)) return false;
    if (!store.commitAtObservation) return false;
    observationRevision = snapshot.revision;
    const integration = await store.get<SessionIntegrationState>(candidate.ownerId, 'session_integrations', candidate.sessionId);
    if (!policy.allowCancel || !integration?.value.target.watchdog?.cancelLoops || !binding || terminalTurn(binding.turn) || state.turns.at(-1)?.turn.id !== binding.turn.id || state.closing || state.forkLock) return false;
  }
  const events = action === 'cancel' ? [{ type: 'agent.session.input.cancel' as const }]
    : [{ type: 'agent.session.input.message' as const, input: binding!.input.map(({ role, content }) => ({ role, content })) }];
  const plan = planSessionInput(state, observeSession(state, state.turns.map(({ turn }) => ({ turn, requiredActions: [] }))), events, {
    turnIds: [`turn_${hash(key).slice(0, 32)}`], messageIds: binding?.input.map((_, index) => `msg_${hash(`${key}:${index}`).slice(0, 32)}`) ?? [], operationIds: [key],
  }, now);
  const next = { ...plan.state, receipts: { ...state.receipts, [key]: { digest: hash(canonicalJson(events)), commands: plan.commands, dispatched: false } } };
  const write = { resource: { ...resource, revision: resource.revision + 1, value: next }, expectedRevision: resource.revision };
  if (action === 'retry') await rateLimit.admit(candidate.ownerId, `input:${candidate.sessionId}:${key}`);
  if (observationRevision !== undefined) await store.commitAtObservation!([write], { ownerId: candidate.ownerId, id: candidate.sessionId, revision: observationRevision });
  else await store.commit([write]);
  return true;
}
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
