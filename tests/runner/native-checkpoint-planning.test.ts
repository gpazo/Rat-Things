import { expect, it } from 'vitest';
import { initialSessionRuntime, type SessionRuntimeState } from '../../src/core/session-runtime-planning.js';
import { planNativeCheckpoint } from '../../src/core/native-checkpoint-planning.js';
import { projectSessionItems } from '../../src/core/session-run-projection.js';
import type { Subagent, Turn } from '../../src/domain/agents-api.js';

const publicTurn = { id: 'public-turn', status: 'completed', subagent_id: null } as Turn;
const message = (id: string, text = 'acknowledged') => ({ type: 'agentMessage', id, text, phase: 'final_answer' });
function fixture(items: unknown[], historyMode = 'paginated') {
  const state: SessionRuntimeState = { ...initialSessionRuntime('session', 'agent', 'root'), turns: [{ threadId: 'root', nativeTurnId: 'native-turn', turn: publicTurn,
    items: projectSessionItems(publicTurn.id, items.map(item => ({ method: 'item/completed', params: { item } }))) }] };
  const thread = { id: 'root', parentThreadId: null, sessionId: 'root', ephemeral: false, historyMode, turns: [{ id: 'native-turn', status: 'completed', items }] };
  return { state, thread };
}
it('allows only known legacy display identity normalization while retaining ordered content', () => {
  const f = fixture([message('live-first'), message('live-second', 'second')], 'legacy');
  f.thread.turns[0]!.items = [message('stored-1'), message('stored-2', 'second')];
  const planned = planNativeCheckpoint(f.state, [f.thread]);
  expect(planned.hostJournalDigest).toMatch(/^[a-f0-9]{64}$/);
  f.thread.turns[0]!.items.reverse();
  expect(() => planNativeCheckpoint(f.state, [f.thread])).toThrow('item content');
});
it('does not match two identical acknowledged legacy messages to one stored message', () => {
  const f = fixture([message('first'), message('second')], 'legacy');
  f.thread.turns[0]!.items = [message('stored-1')];
  expect(() => planNativeCheckpoint(f.state, [f.thread])).toThrow('item content');
});
it('does not normalize paginated item identity or native turn identity', () => {
  const f = fixture([message('original')]);
  f.thread.turns[0]!.items = [message('replacement')];
  expect(() => planNativeCheckpoint(f.state, [f.thread])).toThrow('item content');
  f.thread.turns[0]!.id = 'different-turn';
  expect(() => planNativeCheckpoint(f.state, [f.thread])).toThrow('Session turn');
});
it.each(['text', 'tool-output'])('rejects missing acknowledged %s', kind => {
  const item = kind === 'text' ? message('message') : { type: 'dynamicToolCall', id: 'tool', callId: 'call', tool: 'fixture', arguments: {}, status: 'completed', success: true, contentItems: [{ type: 'inputText', text: 'acknowledged tool output' }] };
  const f = fixture([item]);
  f.thread.turns[0]!.items = kind === 'text' ? [message('message', 'different')] : [{ ...item, contentItems: [{ type: 'inputText', text: 'different' }] }];
  expect(() => planNativeCheckpoint(f.state, [f.thread])).toThrow('item content');
});
it('compares persisted coordination recipients while separately digesting host-only prompts', () => {
  const f = fixture([]);
  f.state.subagents = [{ id: 'child', parent_agent_id: 'agent' } as Subagent];
  f.state.coordinationCalls = { call: { threadId: 'root', turnId: 'native-turn', name: 'spawn_agent', arguments: { message: 'journal-owned prompt' }, recipients: ['child'] } };
  f.state.turns[0]!.items = [{ type: 'create_subagent_call', id: 'call', turn_id: publicTurn.id, status: 'completed', agent_id: 'agent', content: [{ type: 'output_text', text: 'journal-owned prompt' }], model: null, reasoning_effort: null }];
  f.thread.turns[0]!.items = [{ type: 'subAgentActivity', id: 'call', kind: 'started', agentThreadId: 'child' }];
  const child = { ...f.thread, id: 'child', parentThreadId: 'root', turns: [{ id: 'child-turn', status: 'completed', items: [message('child-output')] }] };
  const planned = planNativeCheckpoint(f.state, [f.thread, child]);
  expect(planned.threads.map(thread => thread.id)).toEqual(['root', 'child']);
  f.thread.turns[0]!.items = [{ type: 'subAgentActivity', id: 'call', kind: 'started', agentThreadId: 'different-child' }];
  expect(() => planNativeCheckpoint(f.state, [f.thread, child])).toThrow('recipients');
});

it('rejects reparenting a known child under a known sibling', () => {
  const f = fixture([message('root-output')]);
  f.state.subagents = [{ id: 'child', parent_agent_id: 'agent' } as Subagent, { id: 'sibling', parent_agent_id: 'agent' } as Subagent];
  const child = { ...f.thread, id: 'child', parentThreadId: 'sibling', turns: [{ id: 'child-turn', status: 'completed', items: [message('child-output')] }] };
  const sibling = { ...f.thread, id: 'sibling', parentThreadId: 'root', turns: [{ id: 'sibling-turn', status: 'completed', items: [message('sibling-output')] }] };
  expect(() => planNativeCheckpoint(f.state, [f.thread, sibling, child])).toThrow('parent differs');
});
