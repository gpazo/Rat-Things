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
