import { describe, expect, it } from 'vitest';
import { bindSessionTurn, initialSessionRuntime, reduceSessionRuntime } from '../../src/core/session-runtime-planning.js';
import { planSessionStream, type SessionStreamSnapshot } from '../../src/core/session-stream.js';
import { sessionAgent } from '../../src/core/session-planning.js';
import { parseAgentsContract } from '../../src/domain/agents-api-validation.js';
import type { AgentSession, Turn } from '../../src/domain/agents-api.js';

function fixture() {
  const agent = sessionAgent({ model: 'test' }, 'agent', 1);
  const session: AgentSession = { id: 'session', object: 'agent.session', agent, environment: { type: 'none' }, created_at: 1,
    last_active_at: 1, error: null, metadata: {}, required_actions: [], status: 'in_progress', usage: null, vault_ids: [] };
  const turn: Turn = { id: 'turn', object: 'agent.session.turn', session_id: session.id, agent_id: agent.id, subagent_id: null,
    created_at: 1, started_at: 1, completed_at: null, status: 'in_progress', error: null, usage: null };
  let state = bindSessionTurn(initialSessionRuntime(session.id, agent.id, 'root'), 'native', turn);
  const snapshot = (): SessionStreamSnapshot => ({ session, turns: state.turns.map(b => b.turn), items: state.turns.flatMap(b => b.items) });
  return {
    snapshot,
    emit(method: string, params: Record<string, unknown>) {
      const before = snapshot();
      const original = structuredClone(state);
      const next = reduceSessionRuntime(state, { method, params: { threadId: 'root', turnId: 'native', ...params }, observedAt: 2 });
      expect(state).toEqual(original);
      state = next;
      const events = planSessionStream(before, snapshot());
      state.turns.flatMap(b => b.items).forEach(item => parseAgentsContract('Item', item));
      events.forEach((event, index) => parseAgentsContract('SessionEvent', { ...event, event_id: `evt_${index}` }));
      return events;
    },
  };
}

describe('native Item updates projected into public events', () => {
  it.each(['completed', 'failed'] as const)('retains MCP and command output/error correspondence on %s', status => {
    const f = fixture();
    f.emit('item/completed', { item: { id: 'mcp', type: 'mcpToolCall', server: 'docs', tool: 'lookup', arguments: { query: 'x' }, result: status === 'completed' ? { text: 'result' } : null, error: status === 'failed' ? { message: 'denied' } : null, status } });
    expect(f.snapshot().items[0]).toMatchObject({ type: 'mcp_call', status, output: status === 'completed' ? { text: 'result' } : null, error: status === 'failed' ? { message: 'denied' } : null });
    f.emit('item/completed', { item: { id: 'command', type: 'commandExecution', command: 'work', cwd: '/workspace', durationMs: 5, exitCode: status === 'completed' ? 0 : 1, aggregatedOutput: 'literal output', status } });
    expect(f.snapshot().items[1]).toMatchObject({ type: 'command_execution', status, output: 'literal output', exit_code: status === 'completed' ? 0 : 1, duration_ms: 5 });
  });

  it.each(['commentary', 'final_answer', null] as const)('preserves phase %j across text deltas and completion', phase => {
    const f = fixture();
    f.emit('item/started', { item: { type: 'agentMessage', id: 'message', text: '', phase } });
    f.emit('item/agentMessage/delta', { itemId: 'message', delta: 'First ' });
    expect(f.snapshot().items[0]).toMatchObject({ phase, content: [{ type: 'output_text', text: 'First ' }] });
    f.emit('item/agentMessage/delta', { itemId: 'message', delta: 'second' });
    const events = f.emit('item/completed', { item: { type: 'agentMessage', id: 'message', text: 'First second', phase } });
    expect(f.snapshot().items[0]).toMatchObject({ phase, status: 'completed' });
    expect(events.find(event => event.type === 'agent.session.turn.item.done')).toMatchObject({ item: { phase } });
  });

  it('publishes empty reasoning parts before their text and preserves duplicate part additions', () => {
    const f = fixture();
    f.emit('item/started', { item: { type: 'reasoning', id: 'reasoning', summary: [], content: ['private reasoning'] } });
    const added = f.emit('item/reasoning/summaryPartAdded', { itemId: 'reasoning', summaryIndex: 0 });
    expect(added).toEqual([expect.objectContaining({ type: 'agent.session.turn.reasoning_summary_part.added', summary_index: 0,
      part: { type: 'summary_text', text: '' } })]);
    f.emit('item/reasoning/summaryTextDelta', { itemId: 'reasoning', summaryIndex: 0, delta: 'Public summary' });
    expect(f.emit('item/reasoning/summaryPartAdded', { itemId: 'reasoning', summaryIndex: 0 })).toEqual([]);
    f.emit('item/reasoning/summaryPartAdded', { itemId: 'reasoning', summaryIndex: 1 });
    const done = f.emit('item/completed', { item: { type: 'reasoning', id: 'reasoning', summary: ['Public summary', ''], content: ['private reasoning'] } });
    expect(done.filter(event => event.type === 'agent.session.turn.reasoning_summary_text.done')).toEqual([
      expect.objectContaining({ summary_index: 0, text: 'Public summary' }), expect.objectContaining({ summary_index: 1, text: '' }),
    ]);
    expect(done.at(-1)).toMatchObject({ type: 'agent.session.turn.item.done', item: { summary: [{ type: 'summary_text', text: 'Public summary' }, { type: 'summary_text', text: '' }] } });
    expect(JSON.stringify({ items: f.snapshot().items, done })).not.toContain('private reasoning');
    expect(planSessionStream(f.snapshot(), f.snapshot())).toEqual([]);
  });

  it.each([-1, 0.5])('ignores malformed reasoning part index %s without altering history', summaryIndex => {
    const f = fixture();
    f.emit('item/started', { item: { type: 'reasoning', id: 'reasoning', summary: [] } });
    const before = structuredClone(f.snapshot());
    expect(f.emit('item/reasoning/summaryTextDelta', { itemId: 'reasoning', summaryIndex, delta: 'invalid' })).toEqual([]);
    expect(f.snapshot()).toEqual(before);
  });
});
