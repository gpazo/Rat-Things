import type { SessionRuntimeEvent, SessionRuntimeState } from './session-runtime-planning.js';

export interface NativeCoordinationCall {
  threadId: string; turnId: string; name: string; arguments: Record<string, unknown>; recipients: string[];
}
const tools: Record<string, string> = { spawn_agent: 'spawnAgent', send_message: 'sendMessage', followup_task: 'followupTask', interrupt_agent: 'interruptAgent', wait_agent: 'wait' };

/** Select collaboration metadata only; raw model reasoning and unrelated protocol items stay private. */
export function planNativeCoordination(state: SessionRuntimeState, event: SessionRuntimeEvent): { state: SessionRuntimeState; event: SessionRuntimeEvent } {
  const item = record(event.params.item) ? event.params.item : undefined;
  const threadId = typeof event.params.threadId === 'string' ? event.params.threadId : undefined;
  const turnId = typeof event.params.turnId === 'string' ? event.params.turnId : undefined;
  if (!item || !threadId || !turnId || threadId !== state.rootThreadId && !state.subagents.some((agent) => agent.id === threadId)) return { state, event };
  if (event.method === 'rawResponseItem/completed' && item.type === 'function_call' && item.namespace === 'collaboration' && typeof item.name === 'string' && tools[item.name] && typeof item.call_id === 'string') {
    const args = parsedObject(item.arguments) ?? {};
    const target = typeof args.target === 'string' ? args.target : undefined;
    const parentPath = state.agentPaths?.[threadId] ?? '/root';
    const fullPath = target?.startsWith('/') ? target : `${parentPath}/${target}`;
    const recipient = state.subagents.find((agent) => agent.id === target || state.agentPaths?.[agent.id] === fullPath);
    const recipients = recipient ? [recipient.id] : item.name === 'wait_agent' ? state.subagents.filter((agent) => agent.status === 'active').map((agent) => agent.id) : [];
    const call: NativeCoordinationCall = { threadId, turnId, name: item.name, arguments: args, recipients };
    const next = { ...state, coordinationCalls: { ...state.coordinationCalls, [item.call_id]: call } };
    return { state: next, event: coordinationEvent(event, item.call_id, call, 'inProgress') };
  }
  if (item.type === 'subAgentActivity' && typeof item.id === 'string' && typeof item.agentThreadId === 'string' && ['started', 'interacted', 'interrupted'].includes(String(item.kind))) {
    const saved = state.coordinationCalls?.[item.id];
    const name = saved?.name ?? (item.kind === 'started' ? 'spawn_agent' : item.kind === 'interrupted' ? 'interrupt_agent' : 'send_message');
    const call: NativeCoordinationCall = { threadId, turnId, name, arguments: saved?.arguments ?? {}, recipients: [item.agentThreadId] };
    const next = { ...state, coordinationCalls: { ...state.coordinationCalls, [item.id]: call }, agentPaths: { ...state.agentPaths, ...(typeof item.agentPath === 'string' ? { [item.agentThreadId]: item.agentPath } : {}) } };
    return { state: next, event: coordinationEvent(event, item.id, call, 'completed') };
  }
  if (event.method === 'rawResponseItem/completed' && item.type === 'function_call_output' && typeof item.call_id === 'string') {
    const call = state.coordinationCalls?.[item.call_id];
    if (!call || call.threadId !== threadId || call.turnId !== turnId) return { state, event };
    const result = parsedObject(item.output);
    // Native v2 message delivery intentionally acknowledges success with empty
    // output. Its preceding activity event supplies the recipient identity.
    const delivered = item.output === '' && ['send_message', 'followup_task'].includes(call.name) && call.recipients.length > 0;
    const status = delivered || result && !('error' in result) ? 'completed' : 'failed';
    return { state, event: coordinationEvent(event, item.call_id, call, status) };
  }
  return { state, event };
}

function coordinationEvent(event: SessionRuntimeEvent, id: string, call: NativeCoordinationCall, status: string): SessionRuntimeEvent {
  return { ...event, method: status === 'inProgress' ? 'item/started' : 'item/completed', params: {
    threadId: call.threadId, turnId: call.turnId, item: {
      id, type: 'collabAgentToolCall', tool: tools[call.name], status, senderThreadId: call.threadId,
      receiverThreadIds: call.recipients, prompt: typeof call.arguments.message === 'string' ? call.arguments.message : null,
      model: typeof call.arguments.model === 'string' ? call.arguments.model : null,
      reasoningEffort: typeof call.arguments.reasoning_effort === 'string' ? call.arguments.reasoning_effort : null,
    },
  } };
}
function parsedObject(value: unknown): Record<string, unknown> | undefined {
  if (record(value)) return value;
  if (typeof value !== 'string') return undefined;
  try { const parsed: unknown = JSON.parse(value); return record(parsed) ? parsed : undefined; } catch { return undefined; }
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
