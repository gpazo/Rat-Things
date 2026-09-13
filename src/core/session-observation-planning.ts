import type { AgentSessionEnvironmentState } from '../domain/agents-api.js';
import type { StoredEnvironment } from './environment-service.js';
import type { SessionState } from './session-ports.js';
import type { StoredSessionRuntime } from './session-runtime-store.js';
import { observeSession, orderedTurnItems, terminalTurn } from './session-planning.js';
import { runtimeSubagents } from './session-runtime-planning.js';
import type { SessionStreamSnapshot } from './session-stream.js';

/** A public observation from committed values; no live worker, clock or database reads. */
export function savedSessionObservation(state: SessionState, runtime: StoredSessionRuntime | undefined, environment: StoredEnvironment | undefined, now: number): SessionStreamSnapshot {
  const native = runtime?.snapshot;
  const subagents = native ? runtimeSubagents(native) : state.subagents ?? [];
  const status = environment?.retired ? 'expired' : environment?.status === 'connected' && (environment.connectedUntil ?? 0) <= now ? 'disconnected' : environment?.status;
  const environmentState: AgentSessionEnvironmentState | undefined = environment && status ? {
    id: environment.environment.id, type: environment.environment.type, status: status === 'expired' ? 'failed' : status,
    error: status === 'expired' || status === 'failed' ? { code: 'environment_unavailable', type: 'server_error', message: 'The environment is unavailable.' } : null,
  } : undefined;
  const observations = state.turns.map((binding) => {
    const saved = native?.turns.find((candidate) => candidate.turn.id === binding.turn.id);
    const turn = terminalTurn(binding.turn) ? binding.turn : saved?.turn ?? binding.turn;
    const requiredActions = terminalTurn(turn) ? [] : saved ? (native?.requiredActions ?? []).filter((action) => action.type === 'function_call' && action.turn_id === turn.id)
      : environmentState && environmentState.type === 'self_hosted' && environmentState.status !== 'connected' && !binding.cancelRequested ? [{ type: 'environment_connection' as const, environment_id: environmentState.id }] : [];
    return { turn, requiredActions };
  });
  const current = environmentState?.status === 'failed' && !environment?.retired ? { ...state, session: { ...state.session, status: 'failed' as const, error: 'The execution environment is unavailable. Create a new session.' } } : state;
  const observation = observeSession(current, [...observations, ...subagents.flatMap((entry) => entry.turns.map((turn) => ({ turn, requiredActions: (entry.requiredActions ?? []).filter((action) => action.type === 'function_call' && action.turn_id === turn.id) })))]);
  return {
    session: observation.session, turns: observation.turns.map(({ turn }) => turn),
    items: [...state.turns.flatMap((binding) => orderedTurnItems(state, binding, binding.savedItems ?? native?.turns.find((entry) => entry.turn.id === binding.turn.id)?.items ?? [])), ...subagents.flatMap((entry) => entry.items)],
    subagents: subagents.map((entry) => entry.subagent),
    failures: Object.entries(state.receipts).flatMap(([id, receipt]) => receipt.failure ? [{ id, ...receipt.failure }] : []),
    ...(environmentState ? { environment: environmentState } : {}),
  };
}
