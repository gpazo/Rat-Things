import type { JsonValue } from '@earendil-works/chord';
import type { AssistantMessage, ToolCall, ToolResultMessage } from '@earendil-works/pi-ai';
import type { CommitPublication, ConversationRecord, Cursor, DocumentRecord, EntryRecord, JsonObject, LiveState, Page, Storage, SubmissionRecord, TaskRecord } from '@earendil-works/pi-durable';
import type { NativeTurnBinding, SessionRuntimeState } from '../../core/session-runtime-planning.js';
import type { AgentSessionItem, TokenUsage, Turn } from '../../domain/agents-api.js';
import type { SessionLaunch } from '../../domain/session-execution.js';
import { PI_CONTEXT, publicCallId, publicThreadId, type PiEffectDescriptor, type PiEffectTool, type PiFunctions, type PiLinks, type PiTurnLink } from './protocol.js';

type NativeTask = TaskRecord<JsonValue, JsonValue, JsonValue>;
export type PiCommittedImage = { seq: number; conversations: Record<number, ConversationRecord>; entries: Record<number, EntryRecord>; tasks: Record<number, NativeTask>; submissions: Record<number, SubmissionRecord>; documents: Record<string, JsonObject> };
function docKey(record: Pick<DocumentRecord, 'kind' | 'scope' | 'key'>): string {
  return `${record.kind}:${record.scope.kind === 'session' ? 'session' : record.scope.kind === 'conversation' ? record.scope.conversationId : `task:${record.scope.taskId}`}:${record.key ?? ''}`;
}
export function applyPiCommit(image: PiCommittedImage, publication: CommitPublication): PiCommittedImage {
  const next = { seq: publication.seq, conversations: { ...image.conversations }, entries: { ...image.entries }, tasks: { ...image.tasks }, submissions: { ...image.submissions }, documents: { ...image.documents } };
  for (const change of publication.changes) {
    switch (change.type) {
      case 'conversation': next.conversations[change.value.id] = change.value; break;
      case 'entry': next.entries[change.value.id] = change.value; break;
      case 'task': next.tasks[change.value.id] = change.value; break;
      case 'submission': next.submissions[change.value.id] = change.value; break;
      case 'document': if (change.value) next.documents[docKey(change.record)] = change.value; else delete next.documents[docKey(change.record)]; break;
      case 'document.copy': throw new Error('Pi context import must materialize independent documents');
    }
  }
  return next;
}
async function scan<T>(read: (cursor: Cursor | undefined) => Promise<Page<T, Cursor>>): Promise<T[]> {
  const result: T[] = [];
  let cursor: Cursor | undefined;
  do { const page = await read(cursor); result.push(...page.items); cursor = page.next; } while (cursor);
  return result;
}
export async function readPiImage(storage: Storage, nativeSeq: number): Promise<PiCommittedImage> {
  const image: PiCommittedImage = { seq: nativeSeq, conversations: {}, entries: {}, tasks: {}, submissions: {}, documents: {} };
  const conversations = await scan(cursor => storage.scanConversations({}, 1000, cursor, PI_CONTEXT));
  const tasks = await scan(cursor => storage.scanTasks({}, 1000, cursor, PI_CONTEXT));
  for (const value of conversations) image.conversations[value.id] = value;
  for (const value of tasks) image.tasks[value.id] = value;
  for (const value of await scan(cursor => storage.scanSubmissions({}, 1000, cursor, PI_CONTEXT))) image.submissions[value.id] = value;
  for (const conversation of conversations) for (const value of await scan(cursor => storage.scanEntries({ conversationId: conversation.id, order: 'ascending' }, 1000, cursor, PI_CONTEXT))) image.entries[value.id] = value;
  const scopes: DocumentRecord['scope'][] = [{ kind: 'session' }, ...conversations.map(value => ({ kind: 'conversation' as const, conversationId: value.id }))];
  for (const scope of scopes) for (const record of await scan(cursor => storage.scanDocuments({ scope, at: 'current' }, 1000, cursor, PI_CONTEXT))) {
    const document = await storage.document(record.id, 'current', PI_CONTEXT);
    if (document) image.documents[docKey(record)] = document.value;
  }
  return image;
}
export function piImageHasLiveTasks(image: PiCommittedImage): boolean {
  const links = image.documents['rat.links:session:'] as PiLinks | undefined;
  return Object.values(image.tasks).some(task => task.kind !== 'rat.child' && task.state.status !== 'terminal')
    || Object.values(image.submissions).some(submission => submission.status === 'queued' || submission.status === 'placed')
    || Object.values(links?.children ?? {}).some(child => child.closing && child.closedAt === undefined);
}
export async function piHasLiveTasks(storage: Storage): Promise<boolean> {
  return piImageHasLiveTasks(await readPiImage(storage, 0));
}
export async function projectPiStorage(storage: Storage, launch: SessionLaunch, nativeSeq: number, effectTools: readonly PiEffectTool[] = []): Promise<{ snapshot: SessionRuntimeState; nativeSeq: number; hasLiveTasks: boolean }> {
  const image = await readPiImage(storage, nativeSeq);
  return { snapshot: projectPi(image, launch, effectTools), nativeSeq, hasLiveTasks: piImageHasLiveTasks(image) };
}
export function projectPi(image: PiCommittedImage, launch: SessionLaunch, effects: readonly PiEffectTool[] = []): SessionRuntimeState {
  const links = image.documents['rat.links:session:'] as PiLinks | undefined;
  const effectMapping = links?.effects ?? effects;
  const functions = image.documents['rat.functions:session:'] as PiFunctions | undefined;
  const messageIds = assistantMessageIds(image);
  const rootId = links?.rootId ?? 1;
  const agentId = links?.agentId ?? launch.turn?.agent_id ?? launch.agent.id ?? launch.sessionId;
  const bindings = Object.values(links?.turns ?? {}).sort((a, b) => a.submissionId - b.submissionId).map(link => projectTurn(image, link, links!, functions, effectMapping, launch.agent.multi_agent.enabled, messageIds));
  const turns: NativeTurnBinding[] = [...(links?.inherited ?? []) as NativeTurnBinding[], ...bindings];
  const requiredActions: SessionRuntimeState['requiredActions'] = Object.entries(functions?.calls ?? {}).flatMap(([callId, call]) => {
    const turn = turns.find(binding => binding.turn.id === call.turnId)?.turn;
    const task = image.tasks[call.taskId];
    return !call.result && task?.state.status !== 'terminal' && turn && ['in_progress', 'waiting'].includes(turn.status)
      ? [{ type: 'function_call', call_id: callId, turn_id: call.turnId, name: call.name, arguments: call.arguments }] : [];
  });
  return { sessionId: launch.sessionId, agentId, rootThreadId: publicThreadId(rootId), turns, requiredActions,
    ...(links?.inherited.length ? { inheritedNativeTurnIds: links.inherited.map(binding => binding.nativeTurnId) } : {}),
    subagents: Object.values(links?.children ?? {}).map(child => ({ id: child.id, object: 'agent.session.subagent', session_id: launch.sessionId,
      parent_agent_id: child.parentId, name: child.name, instructions: [{ type: 'output_text', text: child.prompt }], opened_at: child.openedAt,
      closed_at: child.closedAt ?? null, status: child.closedAt === undefined ? 'active' : 'closed' })),
  };
}
function projectTurn(image: PiCommittedImage, link: PiTurnLink, links: PiLinks, functions: PiFunctions | undefined, effects: readonly PiEffectDescriptor[], coordination: boolean, messageIds: AssistantMessageIds): NativeTurnBinding {
  const submission = image.submissions[link.submissionId];
  const associated = [link.submissionId, ...link.steerIds ?? []].flatMap(id => image.submissions[id] ? [image.submissions[id]!] : []);
  const activeSubmission = associated.find(submission => submission.status === 'placed' || submission.status === 'queued');
  const lastSubmission = associated.at(-1);
  const entryId = submission?.entry;
  const nextEntry = Object.values(links.turns).filter(other => other.conversationId === link.conversationId && other.submissionId > link.submissionId)
    .map(other => image.submissions[other.submissionId]?.entry).filter((id): id is NonNullable<typeof id> => id !== undefined).sort((a, b) => a - b)[0];
  const entries = entryId === undefined ? [] : Object.values(image.entries).filter(entry => entry.conversationId === link.conversationId && entry.id >= entryId && (nextEntry === undefined || entry.id < nextEntry)).sort((a, b) => a.id - b.id);
  const tasks = Object.values(image.tasks).filter(task => task.conversationId === link.conversationId && entryId !== undefined && task.id > entryId && (nextEntry === undefined || task.id < nextEntry));
  const pending = Object.values(functions?.calls ?? {}).some(call => call.turnId === link.turn.id && !call.result && image.tasks[call.taskId]?.state.status !== 'terminal');
  const status: Turn['status'] = activeSubmission ? activeSubmission.status === 'placed' ? pending ? 'waiting' : 'in_progress' : 'queued'
    : lastSubmission?.status === 'done' ? 'completed' : lastSubmission?.status === 'unanswered' ? lastSubmission.reason === 'aborted' ? 'cancelled' : 'failed' : 'queued';
  const terminal = status === 'completed' || status === 'cancelled' || status === 'failed';
  const lastEnd = tasks.reduce((value, task) => Math.max(value, task.endedAt ?? 0), 0);
  const messages = entries.flatMap(entry => entry.model ?? []);
  const firstMessage = messages[0];
  const completedAt = Math.max(lastEnd, ...messages.map(message => message.timestamp));
  const turn: Turn = { ...link.turn, status, started_at: firstMessage ? Math.floor(firstMessage.timestamp / 1000) : null,
    completed_at: terminal ? Math.floor(completedAt / 1000) : null, usage: usage(messages.filter((message): message is AssistantMessage => message.role === 'assistant')),
    error: status === 'failed' ? { code: 'server_error', message: 'The Pi run ended without an answer.' } : null };
  const items = entries.flatMap(entry => entryItems(image, entry, link, functions, effects, terminal, coordination, messageIds));
  const live = image.documents[`pi.live:${link.conversationId}:`] as LiveState | undefined;
  if (live?.run?.inputs.some(id => id === link.submissionId || link.steerIds?.includes(id)) && live.generation?.message) {
    const text = live.generation.message.content.filter(part => part.type === 'text').map(part => part.text).join('');
    if (text) items.push({ id: messageIds.next[link.conversationId] ?? `pi_message_${link.conversationId}_0`, type: 'message', role: 'assistant', turn_id: turn.id, phase: 'commentary', status: 'in_progress', content: [{ type: 'output_text', text }] });
  }
  const child = Object.values(links.children).find(child => child.conversationId === link.conversationId);
  return { threadId: child?.id ?? publicThreadId(link.conversationId), nativeTurnId: `pi_submission_${link.submissionId}`, turn, items,
    ...(link.parentTurnId ? { traceParentTurnId: link.parentTurnId } : {}) };
}
type AssistantMessageIds = { entries: Record<string, string>; next: Record<number, string> };
function assistantMessageIds(image: PiCommittedImage): AssistantMessageIds {
  const ids: AssistantMessageIds = { entries: {}, next: {} };
  const counts: Record<number, number> = {};
  for (const entry of Object.values(image.entries).sort((a, b) => a.id - b.id)) {
    (entry.model ?? []).forEach((message, index) => {
      if (message.role !== 'assistant') return;
      const ordinal = counts[entry.conversationId] ?? 0;
      ids.entries[`${entry.id}:${index}`] = `pi_message_${entry.conversationId}_${ordinal}`;
      counts[entry.conversationId] = ordinal + 1;
      ids.next[entry.conversationId] = `pi_message_${entry.conversationId}_${ordinal + 1}`;
    });
  }
  return ids;
}
function usage(messages: AssistantMessage[]): TokenUsage | null {
  if (!messages.length) return null;
  const total = messages.reduce((sum, message) => ({ input: sum.input + message.usage.input + message.usage.cacheRead + message.usage.cacheWrite,
    output: sum.output + message.usage.output, cached: sum.cached + message.usage.cacheRead, reasoning: sum.reasoning + (message.usage.reasoning ?? 0) }), { input: 0, output: 0, cached: 0, reasoning: 0 });
  return { input_tokens: total.input, output_tokens: total.output, total_tokens: total.input + total.output,
    input_tokens_details: { cached_tokens: total.cached }, output_tokens_details: { reasoning_tokens: total.reasoning } };
}
function entryItems(image: PiCommittedImage, entry: EntryRecord, link: PiTurnLink, functions: PiFunctions | undefined, effects: readonly PiEffectDescriptor[], terminal: boolean, coordination: boolean, messageIds: AssistantMessageIds): AgentSessionItem[] {
  return (entry.model ?? []).flatMap<AgentSessionItem>((message, index) => {
    const id = messageIds.entries[`${entry.id}:${index}`] ?? `pi_entry_${entry.id}_${index}`;
    if (message.role === 'user') {
      if (link.turn.subagent_id === null) return [];
      const parts = typeof message.content === 'string' ? [{ type: 'text' as const, text: message.content }] : message.content;
      return [{ id, type: 'message', turn_id: link.turn.id, role: 'user', phase: null, status: 'completed', content: parts.map(part => part.type === 'text' ? { type: 'input_text', text: part.text } : { type: 'input_image', image_url: `data:${part.mimeType};base64,${part.data}` }) }];
    }
    if (message.role !== 'assistant') return [];
    const text = message.content.filter(part => part.type === 'text').map(part => part.text).join('');
    const items: AgentSessionItem[] = text ? [{ id, type: 'message', turn_id: link.turn.id, role: 'assistant', phase: message.stopReason === 'stop' ? 'final_answer' : 'commentary',
      status: message.stopReason === 'aborted' || message.stopReason === 'error' ? 'incomplete' : 'completed', content: [{ type: 'output_text', text }] }] : [];
    for (const call of message.content.filter((part): part is ToolCall => part.type === 'toolCall')) {
      const task = Object.values(image.tasks).find(task => task.kind === 'pi.tool' && typeof task.input === 'object' && task.input !== null && !Array.isArray(task.input) && task.input.assistant === entry.id && task.input.callId === call.id);
      const result = Object.values(image.entries).filter(result => result.conversationId === entry.conversationId && result.id > entry.id && (task ? result.byTaskId === task.id : true))
        .flatMap(result => result.model ?? []).find((message): message is ToolResultMessage => message.role === 'toolResult' && message.toolCallId === call.id);
      if (!task && !result) continue;
      const callId = task ? publicCallId(task.id) : `pi_call_${entry.id}_${message.content.indexOf(call)}`;
      const fn = functions?.calls[callId];
      const status = result ? result.isError ? 'failed' : 'completed' : task?.state.status === 'terminal' || terminal ? 'incomplete' : 'in_progress';
      const common = { id: callId, turn_id: link.turn.id, status } as const;
      const effect = effects.find(effect => effect.name === call.name);
      if (coordination && call.name === 'spawn_agent') items.push({ ...common, type: 'create_subagent_call', agent_id: link.turn.agent_id, content: [{ type: 'output_text', text: String(call.arguments.message ?? '') }], model: typeof call.arguments.model === 'string' ? call.arguments.model : null, reasoning_effort: typeof call.arguments.reasoning_effort === 'string' ? call.arguments.reasoning_effort : null });
      else if (coordination && call.name === 'send_input') items.push({ ...common, type: 'send_subagent_input_call', sender_agent_id: link.turn.agent_id, recipient_agent_id: String(call.arguments.id), content: [{ type: 'output_text', text: String(call.arguments.message ?? '') }] });
      else if (coordination && call.name === 'wait_agent') items.push({ ...common, type: 'wait_for_subagents_call', sender_agent_id: link.turn.agent_id, recipient_agent_ids: Array.isArray(call.arguments.ids) ? call.arguments.ids.map(String) : [] });
      else if (coordination && call.name === 'close_agent') items.push({ ...common, type: 'close_subagent_call', sender_agent_id: link.turn.agent_id, recipient_agent_id: String(call.arguments.id) });
      else if (effect?.kind === 'mcp') items.push({ ...common, type: 'mcp_call', name: effect.toolName ?? call.name, arguments: call.arguments, server_label: effect.serverLabel ?? '', output: result?.content ?? null, error: result?.isError ? result.content : null });
      else if (effect?.kind === 'managed') items.push({ ...common, type: 'command_execution', command: JSON.stringify(call.arguments), cwd: typeof call.arguments.cwd === 'string' ? call.arguments.cwd : null, duration_ms: result?.durationMs ?? null, exit_code: result ? result.isError ? 1 : 0 : null, output: result?.content.filter(part => part.type === 'text').map(part => part.text).join('\n') ?? null });
      else {
        items.push({ ...common, type: 'function_call', call_id: callId, name: call.name, arguments: call.arguments });
        if (fn?.result) items.push({ id: `pi_result_${callId}`, type: 'function_call_output', turn_id: link.turn.id, call_id: callId,
          status: fn.result.success ? 'completed' : 'failed', output: fn.result.success ? typeof fn.result.output === 'string' ? fn.result.output : JSON.stringify(fn.result.output ?? null) : null, error: fn.result.success ? null : fn.result.error ?? 'Function failed' });
      }
    }
    return items;
  });
}
