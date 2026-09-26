import { projectSessionItems } from '../../src/core/session-run-projection.js';
import { describe, expect, it } from 'vitest';
import { bindSessionTurn, initialSessionRuntime, reduceSessionRuntime, runtimeSubagents } from '../../src/core/session-runtime-planning.js';
import { parseAgentsContract } from '../../src/domain/agents-api-validation.js';
import { planSessionStream } from '../../src/core/session-stream.js';
import { sessionAgent } from '../../src/core/session-planning.js';
import type { AgentSession, Turn } from '../../src/domain/agents-api.js';

const publicTurn: Turn = { id: 'public_turn', object: 'agent.session.turn', session_id: 'session', agent_id: 'agent', subagent_id: null,
  status: 'in_progress', created_at: 1, started_at: 1, completed_at: null, usage: null, error: null };
const rawMessage = (threadId: string, turnId: string, author: string, recipient: string) => ({
  method: 'rawResponseItem/completed', observedAt: 2, params: { threadId, turnId, item: {
    type: 'agent_message', id: 'amsg', author, recipient,
    content: [{ type: 'input_text', text: '' }, { type: 'encrypted_content', encrypted_content: 'opaque' }],
    internal_chat_message_metadata_passthrough: { private_marker: 'must not escape' },
  } },
});

describe('inter-agent message history', () => {
  it('projects a completed close and retains child closure through replay', () => {
    let state = bindSessionTurn(initialSessionRuntime('session', 'agent', 'root-thread'), 'native', publicTurn);
    state = reduceSessionRuntime(state, { method: 'thread/started', observedAt: 1, params: { thread: { id: 'child', parentThreadId: 'root-thread' } } });
    const event = { method: 'item/completed', observedAt: 2, params: { threadId: 'root-thread', turnId: 'native', item: {
      id: 'close', type: 'collabAgentToolCall', tool: 'closeAgent', status: 'completed', senderThreadId: 'root-thread', receiverThreadIds: ['child'],
    } } };
    state = reduceSessionRuntime(state, event);
    state = reduceSessionRuntime(state, { method: 'thread/closed', observedAt: 3, params: { threadId: 'child' } });
    const restored = JSON.parse(JSON.stringify(state));
    const replayed = reduceSessionRuntime(restored, event);
    expect(replayed.turns[0]!.items).toEqual([{ id: 'close', type: 'close_subagent_call', sender_agent_id: 'agent', recipient_agent_id: 'child', status: 'completed', turn_id: 'public_turn' }]);
    expect(replayed.subagents).toEqual(state.subagents);
    expect(replayed.subagents[0]).toMatchObject({ status: 'closed', closed_at: 2 });
    parseAgentsContract('Item', replayed.turns[0]!.items[0]);
  });
  it('preserves historical user images through snapshot and item replay', () => {
    const event = { method: 'item/completed', params: { item: { id: 'user', type: 'userMessage', content: [
      { type: 'text', text: 'Describe this' }, { type: 'image', url: 'data:image/png;base64,aGVsbG8=' },
    ] } } };
    const items = projectSessionItems('public_turn', [event], undefined, { includeUser: true });
    expect(items[0]).toMatchObject({ role: 'user', content: [{ type: 'input_text', text: 'Describe this' }, { type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=' }] });
    parseAgentsContract('Item', items[0]);
    expect(projectSessionItems('public_turn', [event], undefined, { includeUser: true, initial: JSON.parse(JSON.stringify(items)) })).toEqual(items);
  });

  it.each(['spawn_agent', 'send_message', 'followup_task'])('keeps %s content typed through completion and restored history', name => {
    for (const encryptedArgs of [undefined, null, [], ['message']]) {
      const plaintext = Array.isArray(encryptedArgs) && encryptedArgs.length === 0;
      const text = 'pv_this_prefix_does_not_determine_the_content_type';
      let state = bindSessionTurn(initialSessionRuntime('session', 'agent', 'root-thread'), 'native', publicTurn);
      state = reduceSessionRuntime(state, { method: 'thread/started', observedAt: 1, params: { thread: { id: 'child', parentThreadId: 'root-thread' } } });
      const before = structuredClone(state);
      const call = { method: 'rawResponseItem/completed', observedAt: 2, params: { threadId: 'root-thread', turnId: 'native', item: {
        type: 'function_call', namespace: 'collaboration', call_id: 'call', name,
        arguments: JSON.stringify({ message: text, target: 'child', task_name: 'child' }),
        ...(encryptedArgs !== undefined ? { encrypted_function_args: encryptedArgs } : {}),
      } } };
      const started = reduceSessionRuntime(state, call);
      expect(state).toEqual(before);
      state = JSON.parse(JSON.stringify(started));
      state = reduceSessionRuntime(state, { method: 'item/completed', observedAt: 3, params: { threadId: 'root-thread', turnId: 'native', item: {
        type: 'subAgentActivity', id: 'call', agentThreadId: 'child', agentPath: '/root/child', kind: name === 'spawn_agent' ? 'started' : 'interacted',
      } } });
      const complete = { method: 'rawResponseItem/completed', observedAt: 4, params: { threadId: 'root-thread', turnId: 'native', item: {
        type: 'function_call_output', call_id: 'call', output: name === 'spawn_agent' ? '{"agent_id":"child"}' : '',
      } } };
      state = reduceSessionRuntime(state, complete);
      const item = state.turns.find(binding => binding.turn.id === publicTurn.id)!.items.find(item => item.id === 'call');
      expect(item).toMatchObject({ status: 'completed', content: plaintext
        ? [{ type: 'output_text', text }] : [{ type: 'encrypted_content', encrypted_content: text }] });
      parseAgentsContract('Item', item);
      if (name === 'spawn_agent') expect(state.subagents[0]?.instructions).toEqual(plaintext
        ? [{ type: 'output_text', text }] : [{ type: 'encrypted_content', encrypted_content: text }]);
      expect(reduceSessionRuntime(JSON.parse(JSON.stringify(state)), complete).turns).toEqual(state.turns);
    }
  });
  it('retains initial task, creator and opening time when another owned agent resumes a child', () => {
    let state = bindSessionTurn(initialSessionRuntime('session', 'agent', 'root-thread'), 'native', publicTurn);
    for (const [id, parentThreadId, preview] of [['child', 'root-thread', 'Original task'], ['sibling', 'root-thread', 'Other task']]) {
      state = reduceSessionRuntime(state, { method: 'thread/started', observedAt: 10, params: { thread: { id, parentThreadId, preview } } });
    }
    state = reduceSessionRuntime(state, { method: 'thread/closed', observedAt: 20, params: { threadId: 'child' } });
    const before = structuredClone(state);
    const next = reduceSessionRuntime(state, { method: 'item/completed', observedAt: 30, params: { threadId: 'sibling', turnId: 'sibling-turn', item: {
      id: 'resume', type: 'collabAgentToolCall', tool: 'resumeAgent', status: 'completed', senderThreadId: 'sibling', receiverThreadIds: ['child'], prompt: 'Later task',
    } } });
    expect(state).toEqual(before);
    expect(next.subagents[0]).toMatchObject({ parent_agent_id: 'agent', opened_at: 10, closed_at: null, status: 'active', instructions: [{ type: 'output_text', text: 'Original task' }] });
    const item = next.turns.find(binding => binding.threadId === 'sibling')?.items[0];
    expect(item).toMatchObject({ type: 'resume_subagent_call', sender_agent_id: 'sibling', recipient_agent_id: 'child', status: 'completed' });
    parseAgentsContract('Subagent', next.subagents[0]);
    parseAgentsContract('Item', item);
  });

  it('preserves typed content and public root identity across early binding, restore and replay', () => {
    const initial = initialSessionRuntime('session', 'agent', 'root-thread');
    const event = rawMessage('root-thread', 'native', '/root/child', '/root');
    const observed = reduceSessionRuntime({ ...initial, agentPaths: { child: '/root/child' }, subagents: [{
      id: 'child', object: 'agent.session.subagent', session_id: 'session', parent_agent_id: 'agent', name: null, instructions: null,
      opened_at: 1, closed_at: null, status: 'active',
    }] }, event);
    const bound = bindSessionTurn(observed, 'native', publicTurn);
    const restored = JSON.parse(JSON.stringify(bound)) as typeof bound;
    const before = structuredClone(restored);
    const replayed = reduceSessionRuntime(restored, event);
    expect(restored).toEqual(before);
    expect(replayed.turns[0]!.items).toEqual([{
      id: 'amsg', type: 'agent_message', turn_id: 'public_turn', sender_agent_id: 'child', recipient_agent_id: 'agent',
      content: [{ type: 'output_text', text: '' }, { type: 'encrypted_content', encrypted_content: 'opaque' }],
    }]);
    const session: AgentSession = { id: 'session', object: 'agent.session', agent: sessionAgent({ model: 'test' }, 'agent', 1),
      environment: { type: 'none' }, created_at: 1, last_active_at: 1, error: null, required_actions: [], metadata: {}, status: 'in_progress', usage: null, vault_ids: [] };
    const snapshot = { session, turns: [publicTurn], items: replayed.turns[0]!.items };
    const events = planSessionStream({ ...snapshot, items: [] }, snapshot);
    expect(events).toEqual([expect.objectContaining({ type: 'agent.session.turn.item.added', output_index: null })]);
    events.forEach((event, index) => parseAgentsContract('SessionEvent', { ...event, event_id: `evt_${index}` }));
    expect(planSessionStream(snapshot, { ...snapshot, items: restored.turns[0]!.items })).toEqual([]);
    expect(JSON.stringify(snapshot)).not.toContain('must not escape');
  });

  it('keeps nested recipient history on its own Turn and rejects unowned threads', () => {
    let state = initialSessionRuntime('session', 'agent', 'root-thread');
    for (const [id, parentThreadId] of [['child', 'root-thread'], ['nested', 'child']]) state = reduceSessionRuntime(state, {
      method: 'thread/started', params: { thread: { id, parentThreadId } }, observedAt: 1,
    });
    state = { ...state, agentPaths: { child: '/root/child', nested: '/root/child/nested' } };
    const next = reduceSessionRuntime(state, rawMessage('nested', 'nested-turn', '/root/child', '/root/child/nested'));
    expect(next.turns.filter(binding => binding.turn.subagent_id === null)).toEqual([]);
    expect(runtimeSubagents(next).find(entry => entry.subagent.id === 'nested')?.items[0]).toMatchObject({ sender_agent_id: 'child', recipient_agent_id: 'nested' });
    expect(reduceSessionRuntime(next, rawMessage('unowned', 'other', '/root', '/root'))).toBe(next);
  });

  it('preserves unresolved names without treating object properties as identities', () => {
    const state = reduceSessionRuntime(initialSessionRuntime('session', 'agent', 'root-thread'), rawMessage('root-thread', 'native', 'constructor', '__proto__'));
    const item = state.turns[0]!.items[0]!;
    expect(item).toMatchObject({ sender_agent_id: 'constructor', recipient_agent_id: '__proto__' });
    parseAgentsContract('Item', item);
  });
});
