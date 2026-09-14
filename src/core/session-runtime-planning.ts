import type { AgentSession, AgentSessionItem, Subagent, TokenUsage, Turn } from '../domain/agents-api.js';
import type { SavedSessionArtifact, SessionSubagentSnapshot } from './session-ports.js';
import { projectSessionItems } from './session-run-projection.js';
import { terminalTurn } from './session-planning.js';
import { planNativeCoordination, type NativeCoordinationCall } from './session-coordination-planning.js';
import { totalUsage } from './session-ports.js';

/** Private native coordinates stay out of the public turn and subagent resources. */
export interface NativeTurnBinding {
  threadId: string;
  nativeTurnId: string;
  turn: Turn;
  items: AgentSessionItem[];
  artifacts?: SavedSessionArtifact[];
  /** Exact response accounting survives journal recovery and native Turn binding. */
  usageResponseIds?: string[];
}
export interface SessionRuntimeState {
  sessionId: string;
  agentId: string;
  rootThreadId: string;
  subagents: Subagent[];
  turns: NativeTurnBinding[];
  requiredActions: AgentSession['required_actions'];
  coordinationCalls?: Record<string, NativeCoordinationCall>;
  agentPaths?: Record<string, string>;
  threadUsage?: Record<string, TokenUsage>;
}
export interface SessionRuntimeEvent { method: string; params: Record<string, unknown>; observedAt: number; requestId?: string | number }

export function initialSessionRuntime(sessionId: string, agentId: string, rootThreadId: string): SessionRuntimeState {
  return { sessionId, agentId, rootThreadId, subagents: [], turns: [], requiredActions: [] };
}

/** A child may keep working while the root admits its next Turn. */
export function rootTurnBusy(state: SessionRuntimeState, starting: boolean): boolean {
  return starting || state.turns.some((binding) => binding.threadId === state.rootThreadId && !terminalTurn(binding.turn));
}

export function stoppedSessionRuntime(state: SessionRuntimeState, now: number): SessionRuntimeState {
  return {
    ...state, requiredActions: [],
    subagents: state.subagents.map((agent) => agent.status === 'closed' ? agent : { ...agent, status: 'closed', closed_at: now }),
    turns: state.turns.map((binding) => terminalTurn(binding.turn) ? binding : { ...binding, items: incompleteItems(binding.items), turn: {
      ...binding.turn, status: 'failed', completed_at: now,
      error: { code: 'connection_failed', message: 'The session harness stopped before this turn completed.' },
    } }),
  };
}

export function bindSessionTurn(state: SessionRuntimeState, nativeTurnId: string, turn: Turn): SessionRuntimeState {
  const existing = state.turns.find((binding) => binding.turn.id === turn.id);
  if (existing) {
    if (existing.nativeTurnId !== nativeTurnId) throw new Error('A session turn cannot change its native execution identity');
    return state;
  }
  // Native notifications can arrive before the turn/start response. Attach the API ID once.
  const previous = state.turns.find((binding) => binding.threadId === state.rootThreadId && binding.nativeTurnId === nativeTurnId);
  const binding = { ...previous, threadId: state.rootThreadId, nativeTurnId, turn: { ...turn, ...previous?.turn, id: turn.id, created_at: turn.created_at }, items: (previous?.items ?? []).map((item) => ({ ...item, turn_id: turn.id })) };
  return { ...state, turns: previous ? state.turns.map((entry) => entry === previous ? binding : entry) : [...state.turns, binding], requiredActions: state.requiredActions.map((action) => action.type === 'function_call' && action.turn_id === previous?.turn.id ? { ...action, turn_id: turn.id } : action) };
}

/** Each notification affects only its native thread/turn; child output never becomes root output. */
export function reduceSessionRuntime(state: SessionRuntimeState, event: SessionRuntimeEvent): SessionRuntimeState {
  ({ state, event } = planNativeCoordination(state, event));
  const { method, params, observedAt } = event;
  // The stock harness announces spawned children through the parent's completed
  // coordination item; it need not emit thread/started for the child.
  const item = record(params.item) ? params.item : undefined;
  if (method === 'item/completed' && item?.type === 'collabAgentToolCall' && item.status === 'completed' && Array.isArray(item.receiverThreadIds)) {
    const parentId = string(item.senderThreadId);
    if (parentId && (parentId === state.rootThreadId || state.subagents.some((agent) => agent.id === parentId))) {
      for (const id of item.receiverThreadIds.filter((id): id is string => typeof id === 'string')) {
        if (item.tool === 'spawnAgent' || item.tool === 'resumeAgent') {
          state = reduceSessionRuntime(state, { method: 'thread/started', params: { thread: { id, parentThreadId: parentId, preview: item.prompt, agentNickname: state.agentPaths?.[id]?.split('/').at(-1) } }, observedAt });
        } else if (item.tool === 'closeAgent') {
          state = reduceSessionRuntime(state, { method: 'thread/closed', params: { threadId: id }, observedAt });
        }
      }
    }
  }
  if (method === 'thread/started' && record(params.thread) && typeof params.thread.id === 'string') {
    const thread = params.thread;
    const source = record(thread.source) && record(thread.source.subAgent) && record(thread.source.subAgent.thread_spawn) ? thread.source.subAgent.thread_spawn : {};
    const parentId = string(thread.parentThreadId) ?? string(source.parent_thread_id);
    if (thread.id === state.rootThreadId || !parentId || parentId !== state.rootThreadId && !state.subagents.some((agent) => agent.id === parentId)) return state;
    const previous = state.subagents.find((agent) => agent.id === thread.id);
    const subagent: Subagent = {
      id: String(thread.id), object: 'agent.session.subagent', session_id: state.sessionId,
      parent_agent_id: parentId === state.rootThreadId ? state.agentId : parentId,
      name: string(thread.agentNickname) ?? string(source.agent_nickname) ?? previous?.name ?? null,
      instructions: typeof thread.preview === 'string' && thread.preview ? [{ type: 'output_text', text: thread.preview }] : previous?.instructions ?? null,
      opened_at: previous?.opened_at ?? number(thread.createdAt) ?? observedAt, closed_at: null, status: 'active',
    };
    return { ...state, subagents: previous ? state.subagents.map((agent) => agent.id === subagent.id ? subagent : agent) : [...state.subagents, subagent] };
  }
  const threadId = string(params.threadId);
  if (!threadId || threadId !== state.rootThreadId && !state.subagents.some((agent) => agent.id === threadId)) return state;
  if (method === 'thread/closed' || method === 'thread/archived') return {
    ...state, subagents: state.subagents.map((agent) => agent.id === threadId ? { ...agent, status: 'closed', closed_at: observedAt } : agent),
    turns: state.turns.map((binding) => binding.threadId === threadId && !terminalTurn(binding.turn) ? { ...binding, items: incompleteItems(binding.items), turn: { ...binding.turn, status: 'cancelled', completed_at: observedAt } } : binding),
    requiredActions: state.requiredActions.filter((action) => action.type !== 'function_call' || !state.turns.some((binding) => binding.threadId === threadId && binding.turn.id === action.turn_id)),
  };
  const nativeTurn = record(params.turn) ? params.turn : undefined;
  const nativeTurnId = string(nativeTurn?.id) ?? string(params.turnId) ?? (method === 'thread/tokenUsage/updated' ? [...state.turns].reverse().find((turn) => turn.threadId === threadId)?.nativeTurnId ?? null : null);
  if (!nativeTurnId) return state;
  const agentMessage = method === 'rawResponseItem/completed' && item?.type === 'agent_message';
  if (!agentMessage && !['turn/started', 'turn/completed', 'thread/tokenUsage/updated', 'rawResponse/completed', 'item/tool/call', 'error'].includes(method) && !method.startsWith('item/')) return state;
  if (method === 'rawResponse/completed' && (typeof params.responseId !== 'string' || !record(params.usage))) return state;
  const previous = state.turns.find((binding) => binding.nativeTurnId === nativeTurnId && binding.threadId === threadId);
  // Attachment replay may report a historical Turn's cumulative snapshot.
  // It must not rewind the baseline or charge that snapshot a second time.
  if (method === 'thread/tokenUsage/updated' && previous &&
    [...state.turns].reverse().find((binding) => binding.threadId === threadId) !== previous) return state;
  let binding = previous ?? newTurn(state, threadId, nativeTurnId, observedAt);
  let requiredActions = state.requiredActions;
  if (method === 'error') {
    if (params.willRetry === true) return state;
    binding = { ...binding, turn: { ...binding.turn, status: 'failed', completed_at: observedAt, error: { code: 'internal_error', message: 'The agent could not complete this turn.' } } };
    requiredActions = requiredActions.filter((action) => action.type !== 'function_call' || action.turn_id !== binding.turn.id);
  }
  if (method === 'turn/started' || method === 'turn/completed') {
    const status: Turn['status'] = method === 'turn/started' ? 'in_progress' : nativeTurn?.status === 'completed' ? 'completed' : nativeTurn?.status === 'interrupted' ? 'cancelled' : 'failed';
    binding = { ...binding, turn: {
      ...binding.turn, status, started_at: number(nativeTurn?.startedAt) ?? binding.turn.started_at ?? observedAt,
      completed_at: method === 'turn/completed' ? number(nativeTurn?.completedAt) ?? observedAt : null,
      error: status === 'failed' ? { code: 'internal_error', message: 'The agent could not complete this turn.' } : null,
    } };
    if (method === 'turn/completed') requiredActions = requiredActions.filter((action) => action.type !== 'function_call' || action.turn_id !== binding.turn.id);
  }
  if (method === 'rawResponse/completed' && typeof params.responseId === 'string' && record(params.usage)) {
    if (binding.usageResponseIds?.includes(params.responseId)) return state;
    // The pinned harness emits exact response usage before cumulative updates.
    // Remote compaction appears only in this feed; summing both would double
    // count ordinary requests. Exact responses replace the fallback estimate.
    binding = {
      ...binding,
      usageResponseIds: [...binding.usageResponseIds ?? [], params.responseId],
      turn: { ...binding.turn, usage: totalUsage([
        binding.usageResponseIds ? binding.turn.usage : null, publicUsage(params.usage),
      ]) },
    };
  }
  if (method === 'thread/tokenUsage/updated') {
    const totals = record(params.tokenUsage) && record(params.tokenUsage.total) ? publicUsage(params.tokenUsage.total) : undefined;
    const last = record(params.tokenUsage) && record(params.tokenUsage.last) ? publicUsage(params.tokenUsage.last) : undefined;
    if (totals) {
      const delta = usageDifference(totals, state.threadUsage?.[threadId]);
      if (!binding.usageResponseIds) binding = { ...binding, turn: { ...binding.turn, usage: totalUsage([binding.turn.usage, delta]) } };
      state = { ...state, threadUsage: { ...state.threadUsage, [threadId]: totals } };
    } else if (last && !binding.usageResponseIds) binding = { ...binding, turn: { ...binding.turn, usage: last } };
  }
  const agentIds = { [state.rootThreadId]: state.agentId, '/root': state.agentId,
    ...Object.fromEntries(state.subagents.flatMap(agent => [[agent.id, agent.id], ...(state.agentPaths?.[agent.id] ? [[state.agentPaths[agent.id]!, agent.id]] : [])])),
  };
  const completedItems = method === 'turn/completed' && Array.isArray(nativeTurn?.items) ? nativeTurn.items.map((item) => ({ method: 'item/completed', params: { threadId, turnId: nativeTurnId, item } })) : [];
  binding = { ...binding, items: projectSessionItems(binding.turn.id, [event, ...completedItems], undefined, { initial: binding.items, includeUser: threadId !== state.rootThreadId, agentIds }) };
  if (binding.turn.status === 'failed' || binding.turn.status === 'cancelled') binding = { ...binding, items: incompleteItems(binding.items) };
  if (method === 'item/tool/call' && typeof params.tool === 'string' && typeof params.callId === 'string') {
    if (!requiredActions.some((action) => action.type === 'function_call' && action.call_id === params.callId && action.turn_id === binding.turn.id)) requiredActions = [...requiredActions, { type: 'function_call', call_id: params.callId, turn_id: binding.turn.id, name: params.tool, arguments: params.arguments }];
    binding = { ...binding, turn: { ...binding.turn, status: 'waiting' } };
  }
  return { ...state, turns: previous ? state.turns.map((turn) => turn === previous ? binding : turn) : [...state.turns, binding], requiredActions };
}

export function resolveSessionFunction(state: SessionRuntimeState, turnId: string, callId: string): SessionRuntimeState {
  const requiredActions = state.requiredActions.filter((action) => action.type !== 'function_call' || action.turn_id !== turnId || action.call_id !== callId);
  return { ...state, requiredActions, turns: state.turns.map((binding) => binding.turn.id === turnId && binding.turn.status === 'waiting' && !requiredActions.some((action) => action.type === 'function_call' && action.turn_id === turnId) ? { ...binding, turn: { ...binding.turn, status: 'in_progress' } } : binding) };
}

export function runtimeSubagents(state: SessionRuntimeState): SessionSubagentSnapshot[] {
  return state.subagents.map((subagent) => {
    const bindings = state.turns.filter((binding) => binding.threadId === subagent.id);
    return { subagent, turns: bindings.map((binding) => binding.turn), items: bindings.flatMap((binding) => binding.items), artifacts: bindings.flatMap((binding) => binding.artifacts ?? []), requiredActions: state.requiredActions.filter((action) => action.type === 'function_call' && bindings.some((binding) => binding.turn.id === action.turn_id)) };
  });
}

/** Missing completion is incomplete work, not evidence that a tool failed. */
function incompleteItems(items: AgentSessionItem[]): AgentSessionItem[] {
  return items.map(item => 'status' in item && item.status === 'in_progress' ? { ...item, status: 'incomplete' } : item);
}

function newTurn(state: SessionRuntimeState, threadId: string, nativeTurnId: string, now: number): NativeTurnBinding {
  const child = threadId !== state.rootThreadId;
  return { threadId, nativeTurnId, items: [], turn: {
    id: child ? `turn_${threadId}_${nativeTurnId}` : nativeTurnId,
    object: 'agent.session.turn', session_id: state.sessionId, agent_id: child ? threadId : state.agentId,
    subagent_id: child ? threadId : null, status: 'in_progress', created_at: now, started_at: now, completed_at: null, usage: null, error: null,
  } };
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function string(value: unknown): string | null { return typeof value === 'string' ? value : null; }
function number(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null; }

function publicUsage(value: Record<string, unknown>): TokenUsage {
  const input_tokens = number(value.inputTokens) ?? 0;
  const output_tokens = number(value.outputTokens) ?? 0;
  return { input_tokens, output_tokens, total_tokens: input_tokens + output_tokens,
    input_tokens_details: { cached_tokens: number(value.cachedInputTokens) ?? 0 }, output_tokens_details: { reasoning_tokens: number(value.reasoningOutputTokens) ?? 0 } };
}
function usageDifference(total: TokenUsage, before?: TokenUsage): TokenUsage {
  const delta = (value: number, previous = 0) => value >= previous ? value - previous : value;
  const input_tokens = delta(total.input_tokens, before?.input_tokens);
  const output_tokens = delta(total.output_tokens, before?.output_tokens);
  return { input_tokens, output_tokens, total_tokens: input_tokens + output_tokens,
    input_tokens_details: { cached_tokens: delta(total.input_tokens_details.cached_tokens, before?.input_tokens_details.cached_tokens) },
    output_tokens_details: { reasoning_tokens: delta(total.output_tokens_details.reasoning_tokens, before?.output_tokens_details.reasoning_tokens) } };
}
