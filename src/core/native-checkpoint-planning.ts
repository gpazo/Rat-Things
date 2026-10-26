import { canonicalJson, sha256Hex } from '../domain/json.js';
import { nativeThreadHistory, type NativeCheckpointManifest } from '../domain/native-checkpoint.js';
import type { SessionRuntimeState } from './session-runtime-planning.js';
import { projectSessionItems } from './session-run-projection.js';

/** Native disk data alone cannot certify that acknowledged public work survived. */
export function planNativeCheckpoint(state: SessionRuntimeState, histories: unknown[]): NativeCheckpointManifest {
  const expectedIds = new Set([state.rootThreadId, ...state.subagents.map(agent => agent.id), ...state.turns.map(turn => turn.threadId)]);
  if (!state.turns.length || state.requiredActions.length || state.turns.some(binding => binding.turn.status !== 'completed')) throw new Error('Native checkpoint requires completed Session history');
  const threads = histories.map(nativeThreadHistory);
  for (const thread of threads) {
    const agent = state.subagents.find(agent => agent.id === thread.id);
    const parent = agent?.parent_agent_id === state.agentId ? state.rootThreadId : agent?.parent_agent_id;
    if (thread.id !== state.rootThreadId && (!agent || thread.parentThreadId !== parent)) throw new Error('Native checkpoint parent differs from the Session journal');
  }
  if (threads.length !== expectedIds.size || new Set(threads.map(thread => thread.id)).size !== expectedIds.size || threads.some(thread => !expectedIds.has(String(thread.id)))) throw new Error('Native checkpoint thread identities differ from the Session journal');
  const agentIds = { [state.rootThreadId]: state.agentId, ...Object.fromEntries(state.subagents.map(agent => [agent.id, agent.id])) };
  for (const binding of state.turns) {
    const thread = threads.find(thread => thread.id === binding.threadId)!;
    const turn = (thread.turns as Array<Record<string, unknown>>).find(turn => turn.id === binding.nativeTurnId);
    if (!turn) throw new Error('Native checkpoint is missing an acknowledged Session turn');
    const projected = projectSessionItems(binding.turn.id, (turn.items as unknown[]).map(item => ({ method: 'item/completed', params: { item } })), undefined, { includeUser: true, agentIds });
    let projectedIndex = 0;
    for (const item of binding.items) {
      if (item.type === 'agent_message') {
        // Raw inter-agent payloads are omitted by public thread/read. They remain
        // in the host journal; cold evidence does not claim hidden mailbox fidelity.
        if (![state.agentId, ...expectedIds].includes(item.sender_agent_id) || ![state.agentId, ...expectedIds].includes(item.recipient_agent_id)) throw new Error('Native checkpoint has an unknown coordination recipient');
        continue;
      }
      if (['create_subagent_call', 'send_subagent_input_call', 'interrupt_subagent_call'].includes(item.type)) {
        const call = item.id ? state.coordinationCalls?.[item.id] : undefined;
        const activity = (turn.items as Array<Record<string, unknown>>).find(native => native.type === 'subAgentActivity' && native.id === item.id);
        if (call && activity) {
          const kind = item.type === 'create_subagent_call' ? 'started' : item.type === 'interrupt_subagent_call' ? 'interrupted' : 'interacted';
          if (call.threadId !== binding.threadId || call.turnId !== binding.nativeTurnId || call.recipients.length !== 1 || activity.agentThreadId !== call.recipients[0] || activity.kind !== kind) throw new Error('Native checkpoint coordination recipients differ from the Session journal');
          if (item.type === 'create_subagent_call' && ((item.model !== null && activity.model !== item.model) || (item.reasoning_effort !== null && activity.reasoningEffort !== item.reasoning_effort))) throw new Error('Native checkpoint coordination settings differ from the Session journal');
          continue;
        }
      }
      // Legacy rollout hydration synthesizes display Item IDs, while preserving
      // native Turn IDs and content. Paginated history retains its Item IDs.
      const semantic = (value: unknown) => thread.historyMode === 'legacy' && typeof value === 'object' && value !== null ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'id')) : value;
      const index = projected.findIndex((native, index) => index >= projectedIndex && canonicalJson(semantic(native)) === canonicalJson(semantic(item)));
      if (index < 0) throw new Error('Native checkpoint is missing acknowledged Session item content');
      projectedIndex = index + 1;
    }
  }
  const ordered: Record<string, unknown>[] = [];
  const pending = [...threads];
  while (pending.length) {
    const index = pending.findIndex(thread => thread.id === state.rootThreadId ? thread.parentThreadId === null || thread.parentThreadId === undefined : ordered.some(parent => parent.id === thread.parentThreadId));
    if (index < 0) throw new Error('Native checkpoint parent identities are incomplete');
    ordered.push(pending.splice(index, 1)[0]!);
  }
  return { rootThreadId: state.rootThreadId, hostJournalDigest: nativeHostJournalDigest(state), threads: ordered };
}

export function nativeHostJournalDigest(state: SessionRuntimeState): string {
  return sha256Hex(canonicalJson({ rootThreadId: state.rootThreadId, turns: state.turns, subagents: state.subagents.map(agent => ({ id: agent.id, parent_agent_id: agent.parent_agent_id })), coordinationCalls: state.coordinationCalls ?? {} }));
}
