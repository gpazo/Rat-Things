import type { SessionRuntimeEvent, SessionRuntimeState } from './session-runtime-planning.js';
import { initialSessionRuntime, reduceSessionRuntime, stoppedSessionRuntime } from './session-runtime-planning.js';
import { projectSessionTraces } from './session-trace-planning.js';
import type { OtlpTraceData } from '../domain/session-traces.js';

export function recordLocalTrace(state: SessionRuntimeState | undefined, sessionId: string, event: SessionRuntimeEvent): SessionRuntimeState | undefined {
  const thread = event.params.thread as { id?: unknown } | undefined;
  const threadId = event.params.threadId ?? thread?.id;
  if (!state && typeof threadId !== 'string') return state;
  return reduceSessionRuntime(state ?? initialSessionRuntime(sessionId, 'local', threadId as string), event);
}

export function localTraceExport(state: SessionRuntimeState | undefined, sessionId: string, model: string | undefined, start: number, end: number, outcome: 'completed' | 'failed' | 'interrupted'): OtlpTraceData {
  const finished = state ? stoppedSessionRuntime(state, end) : undefined;
  const turns = finished?.turns.length ? finished.turns.map(binding => ({
    parentTurnId: binding.traceParentTurnId, turn: binding.turn, steps: binding.traceSteps ?? [], model,
    parentAgentId: finished.subagents.find(agent => agent.id === binding.turn.agent_id)?.parent_agent_id,
  })) : [{ turn: { id: 'local', object: 'agent.session.turn' as const, session_id: sessionId, agent_id: 'local', subagent_id: null,
    status: outcome === 'interrupted' ? 'cancelled' as const : outcome, created_at: start, started_at: start, completed_at: end, usage: null, error: null }, steps: [], model }];
  return { resourceSpans: projectSessionTraces({ id: sessionId }, turns).flatMap(trace => trace.otlp.resourceSpans) };
}
