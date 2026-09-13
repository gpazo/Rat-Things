import type {
  Agent, AgentSession, AgentSessionInputMessageParam, AgentSessionInputParam,
  AgentSessionItem, SessionCreateParams, Turn,
} from '../domain/agents-api.js';
import { resolveAgentConfiguration } from '../domain/agent-configuration.js';
import { AgentsApiError, invalid } from '../domain/agents-api-validation.js';
import type { SessionCommand, SessionObservation, SessionState, SessionTurnBinding, SessionTurnObservation } from './session-ports.js';
import { totalUsage } from './session-ports.js';

export const terminalTurn = (turn: Turn): boolean => ['completed', 'failed', 'cancelled'].includes(turn.status);

/** Snapshot saved settings once; session overrides replace complete fields. */
export function sessionAgent(input: SessionCreateParams['agent'], id: string, now: number, saved?: Agent): AgentSession['agent'] {
  const publicInput = input ? { ...input, ...(input.tools ? { tools: input.tools.map((tool) => tool.type !== 'mcp' ? tool : {
    ...tool, transport: tool.transport.type === 'http' ? { type: 'http' as const, server_url: tool.transport.server_url } : {
      type: 'stdio' as const, command: tool.transport.command, args: tool.transport.args ?? [], cwd: tool.transport.cwd, env_vars: tool.transport.env_vars ?? [],
    },
  }) } : {}) } : {};
  const configured = resolveAgentConfiguration(publicInput, {
    id: saved?.id ?? id, created_at: now, updated_at: now,
  }, saved);
  if (configured.tools.some((tool) => tool.type === 'function' && tool.defer_loading) && !configured.tools.some((tool) => tool.type === 'tool_search')) invalid('Deferred functions require tool_search', 'agent.tools');
  return {
    id: configured.id, name: configured.name, model: configured.model,
    instructions: configured.instructions, reasoning: configured.reasoning,
    multi_agent: configured.multi_agent, service_tier: configured.service_tier, text: configured.text,
    // The upstream resolved AgentTool union omits the tool_search configuration switch.
    tools: configured.tools.flatMap((tool) => tool.type === 'tool_search' ? [] : [{
      ...tool,
      ...(tool.type === 'mcp' && tool.transport.type === 'http' ? { transport: { type: 'http' as const, server_url: tool.transport.server_url } } : {}),
    }]),
  };
}

export function initialMessages(input: SessionCreateParams['input']): AgentSessionInputMessageParam[] {
  if (typeof input === 'string') return [{ role: 'user', content: [{ type: 'input_text', text: input }] }];
  return input ?? [];
}

export function observeSession(state: SessionState, observations: SessionTurnObservation[]): SessionObservation {
  const completedCalls = new Set(functionResultItems(state).map((item) => item.type === 'function_call_output' ? `${item.turn_id}:${item.call_id}` : ''));
  const visible = observations.map((item) => ({ ...item, requiredActions: item.requiredActions.filter((action) => action.type !== 'function_call' || !completedCalls.has(`${action.turn_id}:${action.call_id}`)) }));
  const active = [...visible].reverse().find((item) => !terminalTurn(item.turn));
  const requiredActions = visible.filter((item) => !terminalTurn(item.turn)).flatMap((item) => item.requiredActions);
  const lastActiveAt = Math.max(state.session.last_active_at, ...observations.map(({ turn }) => turn.completed_at ?? turn.started_at ?? turn.created_at));
  return {
    session: {
      ...state.session,
      status: state.session.status === 'failed' ? 'failed' : active ? requiredActions.length ? 'requires_action' : 'in_progress' : 'idle',
      required_actions: requiredActions,
      last_active_at: lastActiveAt,
      usage: totalUsage(observations.map(({ turn }) => turn.usage)),
    },
    turns: visible,
  };
}

export function planSessionInput(
  state: SessionState,
  observation: SessionObservation,
  events: AgentSessionInputParam[],
  ids: { turnIds: string[]; messageIds: string[]; operationIds: string[]; itemAnchors?: Record<string, string | null> },
  now: number,
): { state: SessionState; commands: SessionCommand[] } {
  if (!events.length) invalid('events must not be empty', 'events');
  if (observation.session.status === 'failed') throw new AgentsApiError(409, 'The session has failed.', 'conflict');
  let turns = state.turns.map((binding) => ({
    ...binding,
    turn: observation.turns.find((item) => item.turn.id === binding.turn.id)?.turn ?? binding.turn,
  }));
  const commands: SessionCommand[] = [];
  const completedCalls = new Set(Object.values(state.receipts).flatMap((receipt) => receipt.commands.flatMap((command) => command.type === 'tool_result' ? [`${command.turnId}:${command.event.call_id}`] : [])));
  let messageOffset = 0;
  let acceptedOrdinal = state.turns.reduce((count, binding) => count + binding.input.length, 0) + functionResultItems(state).length;
  for (const [eventIndex, event] of events.entries()) {
    const active = [...turns].reverse().find((binding) => !binding.cancelRequested && !terminalTurn(binding.turn));
    if (event.type === 'agent.session.input.message') {
      if (!event.input.length || event.input.some((message) => !message.content.length)) invalid('input must contain at least one content part', 'events.input');
      let afterItemId = active ? ids.itemAnchors?.[active.turn.id] ?? active.input.at(-1)?.id ?? null : null;
      const messages = event.input.map((message) => {
        const planned = { ...message, id: ids.messageIds[messageOffset++]!, afterItemId, acceptedOrdinal: acceptedOrdinal++ };
        afterItemId = planned.id;
        return planned;
      });
      if (active) {
        turns = turns.map((binding) => binding.turn.id === active.turn.id ? { ...binding, input: [...binding.input, ...messages] } : binding);
        commands.push({ type: 'steer', turnId: active.turn.id, input: event.input, operationId: ids.operationIds[eventIndex]! });
      } else {
        const turn: Turn = {
          id: ids.turnIds[eventIndex]!, object: 'agent.session.turn', session_id: state.session.id,
          agent_id: state.session.agent.id, subagent_id: null, status: 'queued',
          created_at: now, started_at: null, completed_at: null, error: null, usage: null,
        };
        turns = [...turns, { turn, input: messages }];
        commands.push({ type: 'start', turnId: turn.id, input: messages });
      }
    } else if (event.type === 'agent.session.input.cancel') {
      if (active) {
        turns = turns.map((binding) => binding.turn.id === active.turn.id ? { ...binding, cancelRequested: true } : binding);
        commands.push({ type: 'cancel', turnId: active.turn.id });
      }
    } else {
      const pending = !completedCalls.has(`${event.turn_id}:${event.call_id}`) && observation.session.required_actions.some((action) => action.type === 'function_call' && action.turn_id === event.turn_id && action.call_id === event.call_id);
      if (!pending || !observation.turns.some(({ turn }) => turn.id === event.turn_id && !terminalTurn(turn))) {
        invalid('The tool call is not pending on the active turn', 'events.call_id');
      }
      if (event.success && event.output == null) invalid('Successful tool results require output', 'events.output');
      if (!event.success && !event.error) invalid('Failed tool results require error', 'events.error');
      completedCalls.add(`${event.turn_id}:${event.call_id}`);
      commands.push({ type: 'tool_result', turnId: event.turn_id, afterItemId: ids.itemAnchors?.[event.turn_id] ?? null, acceptedOrdinal: acceptedOrdinal++, event });
    }
  }
  return {
    state: { ...state, session: {
      ...observation.session, last_active_at: now,
      status: turns.some(({ turn }) => !terminalTurn(turn)) ? 'in_progress' : 'idle',
    }, turns },
    commands,
  };
}

export function userItems(binding: SessionTurnBinding): AgentSessionItem[] {
  return binding.input.map((message) => ({
    id: message.id, type: 'message', role: 'user', content: message.content,
    phase: null, status: 'completed', turn_id: binding.turn.id,
  }));
}

export function functionResultItems(state: SessionState): AgentSessionItem[] {
  return Object.entries(state.receipts).flatMap(([key, receipt]) => receipt.commands.flatMap((command, index) => command.type === 'tool_result' ? [{
    id: `fresult_${key}_${index}`, type: 'function_call_output' as const,
    turn_id: command.turnId, call_id: command.event.call_id,
    output: command.event.output ?? null, error: command.event.error ?? null,
    status: command.event.success ? 'completed' as const : 'failed' as const,
  }] : []));
}

/** Merge accepted input at its causal position without moving outputs as their text grows. */
export function orderedTurnItems(state: SessionState, binding: SessionTurnBinding, outputs: AgentSessionItem[]): AgentSessionItem[] {
  const inputItems = userItems(binding);
  const insertions: Array<{ item: AgentSessionItem; after: string | null; ordinal: number }> = binding.input.map((message, index) => ({ item: inputItems[index]!, after: message.afterItemId ?? null, ordinal: message.acceptedOrdinal ?? index }));
  const results = new Map(functionResultItems(state).map((item) => [item.id, item]));
  for (const [key, receipt] of Object.entries(state.receipts)) {
    receipt.commands.forEach((command, index) => {
      if (command.type !== 'tool_result' || command.turnId !== binding.turn.id) return;
      insertions.push({ item: results.get(`fresult_${key}_${index}`)!, after: command.afterItemId ?? outputs.find((item) => item.type === 'function_call' && item.call_id === command.event.call_id)?.id ?? null, ordinal: command.acceptedOrdinal ?? insertions.length });
    });
  }
  insertions.sort((a, b) => a.ordinal - b.ordinal);
  // Reverse insertion preserves acceptance order when several inputs share an anchor.
  const items = [...outputs];
  for (const { item, after } of [...insertions].reverse()) {
    if (items.some((candidate) => candidate.id === item.id)) continue;
    const index = after === null ? -1 : items.findIndex((candidate) => candidate.id === after);
    // A preceding input may not have been inserted yet. Resolve these chains below.
    if (after !== null && index < 0 && insertions.some((entry) => entry.item.id === after)) continue;
    items.splice(index + 1, 0, item);
  }
  for (const { item, after } of insertions) {
    if (items.some((candidate) => candidate.id === item.id)) continue;
    const index = items.findIndex((candidate) => candidate.id === after);
    items.splice(index + 1, 0, item);
  }
  return items;
}

/** ID cursors never contain storage coordinates or cross collection boundaries. */
export function cursorPage<T extends { id: string | null }>(
  resources: T[],
  query: { after?: string; limit?: number; order?: 'asc' | 'desc' },
) {
  if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 1)) invalid('limit must be a positive integer', 'limit');
  const sorted = query.order === 'asc' ? resources : [...resources].reverse();
  const index = query.after ? sorted.findIndex((resource) => resource.id === query.after) : -1;
  if (query.after && index < 0) invalid('Invalid pagination cursor', 'after');
  const limit = Math.min(query.limit ?? 20, 100);
  const data = sorted.slice(index + 1, index + 1 + limit);
  return { object: 'list' as const, data, has_more: index + 1 + data.length < sorted.length };
}
