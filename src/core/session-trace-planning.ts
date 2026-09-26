import { createHash } from 'node:crypto';
import type { AgentSession, Turn } from '../domain/agents-api.js';
import type { OtlpAttribute, OtlpSpan, SessionTrace, TraceStep } from '../domain/session-traces.js';
import type { SessionRuntimeEvent } from './session-runtime-planning.js';

/** Only allowlisted structural fields enter the durable trace journal. */
export function recordTraceStep(steps: TraceStep[], event: SessionRuntimeEvent): TraceStep[] {
  const { method, params, observedAt } = event;
  const item = typeof params.item === 'object' && params.item !== null ? params.item as Record<string, unknown> : {};
  const generation = method === 'rawResponse/completed';
  const tools = ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch', 'collabAgentToolCall', 'imageView', 'imageGeneration', 'sleep'];
  const tool = tools.includes(String(item.type));
  const functionCall = method === 'item/tool/call';
  if (!generation && !functionCall && !(tool && ['item/started', 'item/completed'].includes(method))) return steps;
  const rawId = generation ? params.responseId : functionCall ? params.callId : item.id;
  if (typeof rawId !== 'string') return steps;
  const id = `${generation ? 'generation' : 'tool'}:${rawId}`;
  const previous = steps.find(step => step.id === id);
  const completed = generation || method === 'item/completed';
  const usage = generation && typeof params.usage === 'object' && params.usage !== null ? params.usage as Record<string, unknown> : {};
  const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const label = (value: unknown): string | undefined => typeof value === 'string' && /^[a-zA-Z0-9_.:/-]{1,128}$/.test(value) ? value : undefined;
  const toolName = label(functionCall ? params.tool : item.tool);
  const serverLabel = label(item.server);
  const step: TraceStep = {
    ...previous, id, kind: generation ? 'generation' : 'tool',
    name: generation ? 'generation' : toolName ?? (functionCall ? 'function' : String(item.type)),
    ...(toolName ? { toolName } : {}), ...(serverLabel ? { serverLabel } : {}),
    ...(!completed && previous?.startedAt === undefined && previous?.completedAt === undefined ? { startedAt: observedAt } : {}),
    ...(completed ? { completedAt: previous?.completedAt ?? observedAt, failed: item.status === 'failed' || item.error != null || item.success === false || typeof item.exitCode === 'number' && item.exitCode !== 0 } : {}),
    ...(generation ? { inputTokens: count(usage.inputTokens), outputTokens: count(usage.outputTokens) } : {}),
  };
  return previous ? steps.map(entry => entry.id === id ? step : entry) : [...steps, step];
}

export interface TraceTurn { turn: Turn; steps: TraceStep[]; parentAgentId?: string | undefined; parentTurnId?: string | undefined; model?: string | undefined }

/** Deterministic projection makes retries and exports keep the same trace/span identities. */
export function projectSessionTraces(session: Pick<AgentSession, 'id'>, turns: TraceTurn[], namespace = ''): SessionTrace[] {
  const roots = turns.filter(entry => entry.turn.subagent_id === null).sort((a, b) => a.turn.created_at - b.turn.created_at || a.turn.id.localeCompare(b.turn.id));
  return roots.filter(root => root.turn.completed_at !== null).map(root => {
    const rootFor = (entry: TraceTurn, seen = new Set<string>()): string | undefined => {
      if (!entry.turn.subagent_id) return entry.turn.id;
      if (seen.has(entry.turn.id)) return undefined;
      seen.add(entry.turn.id);
      const parent = turns.find(candidate => candidate.turn.id === entry.parentTurnId);
      return parent ? rootFor(parent, seen) : roots.filter(candidate => candidate.turn.created_at <= entry.turn.created_at).at(-1)?.turn.id;
    };
    const children = turns.filter(entry => entry.turn.subagent_id !== null && rootFor(entry) === root.turn.id);
    const traceId = hex(`trace:${namespace}:${session.id}:${root.turn.id}`, 32);
    const entries = [root, ...children.filter(entry => entry.turn.completed_at !== null)];
    const spans = entries.flatMap(entry => {
      const turn = entry.turn;
      const agentSpanId = hex(`agent:${namespace}:${session.id}:${turn.id}`, 16);
      const parent = entries.find(candidate => candidate.turn.id === entry.parentTurnId) ?? (entry.parentAgentId ? entries.filter(candidate => candidate.turn.agent_id === entry.parentAgentId && candidate.turn.created_at <= turn.created_at).at(-1) : undefined);
      const agent: OtlpSpan = {
        traceId, spanId: agentSpanId,
        ...(turn.subagent_id ? { parentSpanId: hex(`agent:${namespace}:${session.id}:${(parent ?? root).turn.id}`, 16) } : {}),
        name: turn.subagent_id ? 'subagent' : 'agent', kind: 1,
        startTimeUnixNano: nanos(turn.started_at ?? turn.created_at), endTimeUnixNano: nanos(turn.completed_at!),
        attributes: attributes({ 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.id': turn.agent_id,
          'gen_ai.conversation.id': session.id, 'rat_things.turn.id': turn.id, 'rat_things.outcome': turn.status,
          'gen_ai.request.model': entry.model,
          'gen_ai.usage.input_tokens': turn.usage?.input_tokens, 'gen_ai.usage.output_tokens': turn.usage?.output_tokens }),
        status: { code: turn.status === 'failed' ? 2 : turn.status === 'completed' ? 1 : 0 },
      };
      return [agent, ...entry.steps.map(step => ({
        traceId, spanId: hex(`${namespace}:${session.id}:${turn.id}:${step.id}`, 16), parentSpanId: agentSpanId,
        name: step.name, kind: step.kind === 'generation' ? 3 : 1,
        // Completion-only observations are zero-duration, explicitly marked; never invent latency.
        startTimeUnixNano: nanos(step.startedAt ?? step.completedAt ?? turn.created_at),
        endTimeUnixNano: nanos(Math.max(step.startedAt ?? step.completedAt ?? turn.created_at, step.completedAt ?? turn.completed_at!)),
        attributes: attributes({ 'gen_ai.operation.name': step.kind === 'generation' ? 'chat' : 'execute_tool',
          'gen_ai.tool.name': step.toolName, 'rat_things.mcp.server_label': step.serverLabel,
          'rat_things.timing': step.startedAt === undefined ? 'completion_only' : step.completedAt === undefined ? 'incomplete' : 'observed',
          'gen_ai.usage.input_tokens': step.inputTokens, 'gen_ai.usage.output_tokens': step.outputTokens }),
        status: { code: step.failed ? 2 : step.completedAt !== undefined ? 1 : 0 },
      }))];
    });
    return { id: `trace_${traceId}`, object: 'agent.session.trace', session_id: session.id, turn_id: root.turn.id,
      otlp: { resourceSpans: [{ resource: { attributes: attributes({ 'service.name': 'rat-things' }) }, scopeSpans: [{ scope: { name: 'rat-things.agents' }, spans }] }] } };
  });
}

function hex(value: string, length: number): string { return createHash('sha256').update(value).digest('hex').slice(0, length); }
function nanos(seconds: number): string { return (BigInt(Math.round(seconds * 1_000_000)) * 1_000n).toString(); }
function attributes(values: Record<string, string | number | null | undefined>): OtlpAttribute[] {
  return Object.entries(values).flatMap(([key, value]) => value == null ? [] : [{ key, value: typeof value === 'number' ? { intValue: String(value) } : { stringValue: value } }]);
}
