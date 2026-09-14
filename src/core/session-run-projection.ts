import type { AgentFunctionCallStatus, AgentSessionItem, AgentSessionMessageContent, Turn, WebSearchAction } from '../domain/agents-api.js';
import type { RunRecord } from '../domain/contracts.js';
import type { AgentRuntimeSnapshot } from '../domain/interaction.js';
import type { SessionTurnObservation } from './session-ports.js';

/** Public lifecycle is independent of private dispatch states. */
export function projectSessionTurn(turn: Turn, run: RunRecord, snapshot?: AgentRuntimeSnapshot): SessionTurnObservation {
  const requiredActions: SessionTurnObservation['requiredActions'] = (snapshot?.pendingRequests ?? []).flatMap((request) => request.method === 'item/tool/call' && typeof request.params.tool === 'string' ? [{
    type: 'function_call' as const, turn_id: turn.id, call_id: typeof request.params.callId === 'string' ? request.params.callId : request.requestId,
    name: request.params.tool, arguments: request.params.arguments,
  }] : []);
  const status: Turn['status'] = run.status === 'succeeded' ? 'completed' : run.status === 'failed' ? 'failed' : run.status === 'cancelled' ? 'cancelled' : run.status === 'running' || run.status === 'cancelling' ? requiredActions.length ? 'waiting' : 'in_progress' : 'queued';
  const usage = run.result?.usage;
  return {
    turn: {
      ...turn, status,
      started_at: run.execution?.startedAt ? seconds(run.execution.startedAt) : turn.started_at,
      completed_at: ['completed', 'failed', 'cancelled'].includes(status) ? seconds(run.updatedAt) : null,
      error: run.error ? { code: 'internal_error', message: 'The agent could not complete this turn.' } : null,
      usage: usage ? { input_tokens: usage.inputTokens ?? 0, output_tokens: usage.outputTokens ?? 0, total_tokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0), input_tokens_details: { cached_tokens: usage.cachedInputTokens ?? 0 }, output_tokens_details: { reasoning_tokens: usage.reasoningOutputTokens ?? 0 } } : null,
    },
    requiredActions,
  };
}

/** Project selected app-server fields. RPC envelopes and host credentials never leave the backend. */
export function projectSessionItems(turnId: string, events: unknown[], fallbackText?: string, options: { initial?: AgentSessionItem[]; includeUser?: boolean; agentIds?: Record<string, string> } = {}): AgentSessionItem[] {
  const items = new Map<string, AgentSessionItem>((options.initial ?? []).flatMap((item) => item.id === null ? [] : [[item.id, item]]));
  for (const event of events) {
    if (!record(event)) continue;
    const params = record(event.params) ? event.params : {};
    if ((event.method === 'item/reasoning/summaryPartAdded' || event.method === 'item/reasoning/summaryTextDelta' && typeof params.delta === 'string') && typeof params.itemId === 'string') {
      const previous = items.get(params.itemId);
      if (finalItem(previous)) continue;
      const summary = previous?.type === 'reasoning' ? [...previous.summary] : [];
      const index = typeof params.summaryIndex === 'number' ? params.summaryIndex : 0;
      if (!Number.isSafeInteger(index) || index < 0) continue;
      while (summary.length <= index) summary.push({ type: 'summary_text', text: '' });
      if (event.method === 'item/reasoning/summaryTextDelta') summary[index] = { type: 'summary_text', text: summary[index]!.text + params.delta };
      items.set(params.itemId, { id: params.itemId, type: 'reasoning', turn_id: turnId, status: 'in_progress', summary });
      continue;
    }
    if (event.method === 'item/commandExecution/outputDelta' && typeof params.itemId === 'string' && typeof params.delta === 'string') {
      const previous = items.get(params.itemId);
      if (finalItem(previous)) continue;
      if (previous?.type === 'command_execution') items.set(params.itemId, { ...previous, output: (previous.output ?? '') + params.delta });
      continue;
    }
    if (event.method === 'item/agentMessage/delta' && typeof params.itemId === 'string' && typeof params.delta === 'string') {
      const previous = items.get(params.itemId);
      if (finalItem(previous)) continue;
      const text = previous?.type === 'message' ? previous.content.flatMap((part) => part.type === 'output_text' ? [part.text] : []).join('') : '';
      items.set(params.itemId, { id: params.itemId, type: 'message', role: 'assistant', turn_id: turnId, phase: previous?.type === 'message' ? previous.phase : null, status: 'in_progress', content: [{ type: 'output_text', text: text + params.delta }] });
      continue;
    }
    const item = record(params.item) ? params.item : record(event.item) ? event.item : undefined;
    if (event.method === 'rawResponseItem/completed' && item?.type === 'agent_message') {
      if (typeof item.id !== 'string' || typeof item.author !== 'string' || typeof item.recipient !== 'string' || !Array.isArray(item.content)) continue;
      const content = item.content.flatMap<Extract<AgentSessionItem, { type: 'agent_message' }>['content'][number]>(part => {
        if (!record(part)) return [];
        if (part.type === 'input_text' && typeof part.text === 'string') return [{ type: 'output_text' as const, text: part.text }];
        if (part.type === 'encrypted_content' && typeof part.encrypted_content === 'string') return [{ type: 'encrypted_content' as const, encrypted_content: part.encrypted_content }];
        return [];
      });
      items.set(item.id, { id: item.id, type: 'agent_message', turn_id: turnId,
        sender_agent_id: publicAgentId(item.author, options.agentIds),
        recipient_agent_id: publicAgentId(item.recipient, options.agentIds), content });
      continue;
    }
    if (!item || !['item/started', 'item/completed', 'item.completed'].includes(String(event.method ?? event.type))) continue;
    const id = typeof item.id === 'string' ? item.id : `${turnId}_output`;
    const done = event.method === 'item/completed' || event.type === 'item.completed';
    if (['agentMessage', 'agent_message'].includes(String(item.type)) && typeof item.text === 'string') {
      items.set(id, { id, type: 'message', role: 'assistant', turn_id: turnId,
        content: [{ type: 'output_text', text: item.text }],
        phase: item.phase === 'commentary' || item.phase === 'final_answer' ? item.phase : null,
        status: done ? 'completed' : 'in_progress',
      });
    } else if (item.type === 'userMessage' && options.includeUser && Array.isArray(item.content)) {
      items.set(id, { id, type: 'message', role: 'user', turn_id: turnId, phase: null, status: 'completed', content: item.content.flatMap((part): AgentSessionMessageContent[] => {
        if (!record(part)) return [];
        if (part.type === 'text' && typeof part.text === 'string') return [{ type: 'input_text' as const, text: part.text }];
        if (part.type === 'image' && typeof part.url === 'string') return [{ type: 'input_image' as const, image_url: part.url }];
        return [];
      }) });
    } else if (item.type === 'collabAgentToolCall') {
      const sender = typeof item.senderThreadId === 'string' ? options.agentIds?.[item.senderThreadId] ?? item.senderThreadId : '';
      const receivers = strings(item.receiverThreadIds).map((id) => options.agentIds?.[id] ?? id);
      const common = { id, turn_id: turnId, status: callStatus(item.status, done) };
      const content = typeof item.prompt === 'string' ? [{ type: 'output_text' as const, text: item.prompt }] : [];
      if (item.tool === 'spawnAgent') items.set(id, { ...common, type: 'create_subagent_call', agent_id: sender, content, model: stringOrNull(item.model), reasoning_effort: stringOrNull(item.reasoningEffort) });
      if (item.tool === 'wait') items.set(id, { ...common, type: 'wait_for_subagents_call', sender_agent_id: sender, recipient_agent_ids: receivers });
      if (['sendInput', 'sendMessage', 'followupTask'].includes(String(item.tool)) && receivers[0]) items.set(id, { ...common, type: 'send_subagent_input_call', sender_agent_id: sender, recipient_agent_id: receivers[0], content });
      if (item.tool === 'interruptAgent' && receivers[0]) items.set(id, { ...common, type: 'interrupt_subagent_call', sender_agent_id: sender, recipient_agent_id: receivers[0] });
      if (item.tool === 'resumeAgent' && receivers[0]) items.set(id, { ...common, type: 'resume_subagent_call', sender_agent_id: sender, recipient_agent_id: receivers[0] });
      if (item.tool === 'closeAgent' && receivers[0]) items.set(id, { ...common, type: 'close_subagent_call', sender_agent_id: sender, recipient_agent_id: receivers[0] });
    } else if (item.type === 'dynamicToolCall' && typeof item.tool === 'string') {
      const call_id = typeof item.callId === 'string' ? item.callId : id;
      items.set(id, { id, type: 'function_call', turn_id: turnId, call_id, name: item.tool, arguments: item.arguments, status: callStatus(item.status, done) });
      const output = nativeFunctionOutput(item.contentItems);
      if (done && typeof item.success === 'boolean' && output !== undefined) {
        const outputId = `fresult_native_${id}`;
        items.set(outputId, { id: outputId, type: 'function_call_output', turn_id: turnId, call_id,
          status: item.success ? 'completed' : 'failed', output,
          error: item.success ? null : output.flatMap(part => part.type === 'input_text' ? [part.text] : []).join('\n') || null });
      }
    } else if (item.type === 'reasoning') {
      // Only the model's public reasoning summary belongs in API history.
      items.set(id, { id, type: 'reasoning', turn_id: turnId, status: done ? 'completed' : 'in_progress', summary: strings(item.summary).map((text) => ({ type: 'summary_text', text })) });
    } else if (item.type === 'webSearch') {
      items.set(id, { id, type: 'web_search_call', turn_id: turnId, status: done ? 'completed' : 'in_progress', action: searchAction(item.action) });
    } else if (item.type === 'commandExecution' && typeof item.command === 'string') {
      items.set(id, { id, type: 'command_execution', turn_id: turnId, command: item.command, cwd: stringOrNull(item.cwd), duration_ms: numberOrNull(item.durationMs), exit_code: numberOrNull(item.exitCode), output: stringOrNull(item.aggregatedOutput), status: callStatus(item.status, done) });
    } else if (item.type === 'mcpToolCall' && typeof item.tool === 'string' && typeof item.server === 'string') {
      items.set(id, { id, type: 'mcp_call', turn_id: turnId, name: item.tool, server_label: item.server, arguments: item.arguments ?? null, output: item.result ?? null, error: item.error ?? null, status: callStatus(item.status, done) });
    }
  }
  if (!items.size && fallbackText) items.set(`${turnId}_output`, {
    id: `${turnId}_output`, type: 'message', role: 'assistant', turn_id: turnId,
    content: [{ type: 'output_text', text: fallbackText }], phase: 'final_answer', status: 'completed',
  });
  return [...items.values()];
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function finalItem(item: AgentSessionItem | undefined): boolean { return item !== undefined && 'status' in item && item.status !== null && item.status !== 'in_progress'; }
function publicAgentId(value: string, ids?: Record<string, string>): string { return typeof ids?.[value] === 'string' ? ids[value] : value; }
type FunctionOutputContent = Exclude<Extract<AgentSessionItem, { type: 'function_call_output' }>['output'], string | null>;
function nativeFunctionOutput(value: unknown): FunctionOutputContent | undefined {
  if (!Array.isArray(value)) return undefined;
  const output: FunctionOutputContent = [];
  for (const part of value) {
    if (!record(part)) return undefined;
    if (part.type === 'inputText' && typeof part.text === 'string') output.push({ type: 'input_text', text: part.text });
    else if (part.type === 'inputImage' && typeof part.imageUrl === 'string') output.push({ type: 'input_image', image_url: part.imageUrl });
    else return undefined; // Do not present a partial result for unsupported native content.
  }
  return output;
}
function seconds(value: string): number { return Math.floor(Date.parse(value) / 1000); }
function stringOrNull(value: unknown): string | null { return typeof value === 'string' ? value : null; }
function numberOrNull(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((part): part is string => typeof part === 'string') : []; }
function callStatus(status: unknown, done: boolean): AgentFunctionCallStatus {
  return !done ? 'in_progress' : status === 'failed' ? 'failed' : status === 'declined' || status === 'interrupted' ? 'incomplete' : 'completed';
}
function searchAction(action: unknown): WebSearchAction | null {
  if (!record(action)) return null;
  if (action.type === 'search') return { type: 'search', query: stringOrNull(action.query), queries: Array.isArray(action.queries) ? strings(action.queries) : null };
  if (action.type === 'openPage') return { type: 'open_page', url: stringOrNull(action.url) };
  if (action.type === 'findInPage') return { type: 'find_in_page', url: stringOrNull(action.url), pattern: stringOrNull(action.pattern) };
  return { type: 'other' };
}
