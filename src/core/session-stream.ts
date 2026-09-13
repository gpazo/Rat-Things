import type { AgentSession, AgentSessionEnvironmentState, AgentSessionEvent, AgentSessionItem, Subagent, Turn } from '../domain/agents-api.js';
import { canonicalJson } from '../domain/json.js';

export interface SessionStreamSnapshot {
  /** Private subscription cursor, never serialized as a public resource. */
  eventRevision?: number;
  session: AgentSession; turns: Turn[]; items: AgentSessionItem[];
  failures?: Array<{ id: string; code: string; message: string }>;
  environment?: AgentSessionEnvironmentState;
  subagents?: Subagent[];
}
type WithoutId<T> = T extends AgentSessionEvent ? Omit<T, 'event_id'> : never;
export type PlannedSessionEvent = WithoutId<AgentSessionEvent>;

/** Calculate stream changes from snapshots. Ordering puts output before terminal turn events. */
export function planSessionStream(previous: SessionStreamSnapshot | undefined, current: SessionStreamSnapshot, created = false): PlannedSessionEvent[] {
  const events: PlannedSessionEvent[] = [];
  const session_id = current.session.id;
  for (const failure of current.failures ?? []) {
    if (!(previous?.failures ?? []).some((old) => old.id === failure.id)) events.push({ type: 'error', session_id, error: { code: failure.code, message: failure.message, type: 'invalid_request_error', param: null } });
  }
  if (created) events.push({ type: 'agent.session.created', session: current.session });
  for (const subagent of current.subagents ?? []) {
    const old = previous?.subagents?.find((candidate) => candidate.id === subagent.id);
    if (!old) events.push({ type: 'agent.session.subagent.created', subagent });
    if (old?.status !== subagent.status && (old || subagent.status === 'closed')) events.push({ type: `agent.session.subagent.${subagent.status}`, subagent });
  }
  if (current.environment && current.environment.status !== previous?.environment?.status) events.push({ type: `agent.session.environment.${current.environment.status}`, session_id, turn_id: current.turns.find((turn) => !['completed', 'cancelled', 'failed'].includes(turn.status))?.id ?? null, environment: current.environment });
  for (const turn of current.turns) {
    const old = previous?.turns.find((candidate) => candidate.id === turn.id);
    if (!old) events.push({ type: 'agent.session.turn.created', session_id, turn_id: turn.id, turn });
    if (turn.status === 'in_progress' && old?.status !== turn.status) events.push({ type: 'agent.session.turn.in_progress', session_id, turn_id: turn.id, turn });
  }
  const outputIndexes = new Map<string, number>();
  for (const item of current.items) {
    const output = item.type !== 'function_call_output' && 'status' in item && (item.type !== 'message' || item.role === 'assistant');
    const output_index = output ? outputIndexes.get(item.turn_id) ?? 0 : null;
    if (output_index !== null) outputIndexes.set(item.turn_id, output_index + 1);
    const old = previous?.items.find((candidate) => candidate.id === item.id && candidate.turn_id === item.turn_id);
    if (!old) events.push({ type: 'agent.session.turn.item.added', session_id, turn_id: item.turn_id, item, output_index });
    if (item.type === 'message' && item.role === 'assistant' && item.id !== null && output_index !== null) {
      item.content.forEach((part, content_index) => {
        if (part.type !== 'output_text') return;
        const before = old?.type === 'message' ? old.content[content_index] : undefined;
        const text = before?.type === 'output_text' ? before.text : '';
        const address = { session_id, turn_id: item.turn_id, item_id: item.id!, output_index, content_index };
        if (!before) events.push({ type: 'agent.session.turn.content_part.added', ...address, part: { type: 'output_text', text: '' } });
        if (part.text !== text && part.text.startsWith(text)) events.push({ type: 'agent.session.turn.output_text.delta', ...address, delta: part.text.slice(text.length) });
        if (item.status !== 'in_progress' && (old?.type !== 'message' || old.status === 'in_progress')) {
          events.push({ type: 'agent.session.turn.output_text.done', ...address, text: part.text });
          events.push({ type: 'agent.session.turn.content_part.done', ...address, part });
        }
      });
      if (item.status !== 'in_progress' && (old?.type !== 'message' || old.status === 'in_progress')) events.push({
        type: 'agent.session.turn.item.done', session_id, turn_id: item.turn_id, output_index,
        item: { ...item, id: item.id, role: 'assistant', content: item.content.flatMap((part) => part.type === 'output_text' ? [part] : []) },
      });
    } else if (output_index !== null && item.type !== 'message' && item.type !== 'function_call_output' && 'status' in item) {
      if (item.type === 'command_execution') {
        const before = old?.type === 'command_execution' ? old.output ?? '' : '';
        const output = item.output ?? '';
        if (output !== before && output.startsWith(before)) events.push({ type: 'agent.output.command_execution_output.delta', session_id, turn_id: item.turn_id, item_id: item.id, output_index, delta: output.slice(before.length) });
      }
      if (item.type === 'reasoning') {
        item.summary.forEach((part, summary_index) => {
          const before = old?.type === 'reasoning' ? old.summary[summary_index] : undefined;
          const address = { session_id, turn_id: item.turn_id, item_id: item.id, output_index, summary_index };
          if (!before) events.push({ type: 'agent.session.turn.reasoning_summary_part.added', ...address, part: { type: 'summary_text', text: '' } });
          const text = before?.text ?? '';
          if (part.text !== text && part.text.startsWith(text)) events.push({ type: 'agent.session.turn.reasoning_summary_text.delta', ...address, delta: part.text.slice(text.length) });
          if (item.status !== 'in_progress' && item.status !== null && !itemFinished(old)) {
            events.push({ type: 'agent.session.turn.reasoning_summary_text.done', ...address, text: part.text });
            events.push({ type: 'agent.session.turn.reasoning_summary_part.done', ...address, part, status: item.status === 'incomplete' ? 'incomplete' : null });
          }
        });
      }
      if (item.status !== 'in_progress' && item.status !== null && !itemFinished(old)) events.push({ type: 'agent.session.turn.item.done', session_id, turn_id: item.turn_id, output_index, item });
    }
  }
  for (const turn of current.turns) {
    if (previous?.turns.find((candidate) => candidate.id === turn.id)?.status === turn.status) continue;
    const common = { session_id, turn_id: turn.id, turn, usage: turn.usage };
    if (turn.status === 'completed') events.push({ type: 'agent.session.turn.completed', ...common });
    if (turn.status === 'failed') events.push({ type: 'agent.session.turn.failed', ...common });
    if (turn.status === 'cancelled') events.push({ type: 'agent.session.turn.cancelled', ...common });
  }
  if (previous?.session.status !== current.session.status || canonicalJson(previous.session.required_actions) !== canonicalJson(current.session.required_actions)) {
    events.push({ type: `agent.session.${current.session.status}`, session: current.session });
  }
  return events;
}

function itemFinished(item: AgentSessionItem | undefined): boolean {
  return item !== undefined && 'status' in item && item.status !== null && item.status !== 'in_progress';
}
