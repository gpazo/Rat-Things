import { describe, expect, it } from 'vitest';
import { initialSessionRuntime, reduceSessionRuntime, stoppedSessionRuntime } from '../../src/core/session-runtime-planning.js';
import { parseAgentsContract } from '../../src/domain/agents-api-validation.js';
import { planSessionStream } from '../../src/core/session-stream.js';
import { sessionAgent } from '../../src/core/session-planning.js';
import type { AgentSession } from '../../src/domain/agents-api.js';

function fixture() {
  let state = initialSessionRuntime('session', 'agent', 'root');
  state = reduceSessionRuntime(state, { method: 'thread/started', params: { thread: { id: 'child', parentThreadId: 'root' } }, observedAt: 1 });
  for (const threadId of ['root', 'child']) {
    const turnId = `${threadId}-turn`;
    for (const item of [
      { id: 'message', type: 'agentMessage', text: 'Partial', phase: 'commentary' },
      { id: 'reasoning', type: 'reasoning', summary: ['Summary so far'], content: ['private'] },
      { id: 'command', type: 'commandExecution', command: 'work', cwd: '/workspace', aggregatedOutput: 'Partial output' },
      { id: 'function', type: 'dynamicToolCall', tool: 'lookup', arguments: {}, status: 'inProgress' },
      { id: 'mcp', type: 'mcpToolCall', tool: 'lookup', server: 'docs', arguments: {} },
      { id: 'search', type: 'webSearch', action: { type: 'search', query: 'documentation' } },
    ]) state = reduceSessionRuntime(state, { method: 'item/started', params: { threadId, turnId, item }, observedAt: 1 });
    state = reduceSessionRuntime(state, { method: 'item/completed', params: { threadId, turnId, item: { id: 'finished', type: 'agentMessage', text: 'Confirmed', phase: 'commentary' } }, observedAt: 1 });
  }
  return state;
}

describe('unfinished Items when execution ends', () => {
  it.each(['interrupted', 'failed', 'error', 'closed'] as const)('closes only root unfinished Items for %s', outcome => {
    const before = fixture();
    const original = structuredClone(before);
    const event = outcome === 'closed' ? { method: 'thread/closed', params: { threadId: 'root' }, observedAt: 2 }
      : outcome === 'error' ? { method: 'error', params: { threadId: 'root', turnId: 'root-turn', willRetry: false }, observedAt: 2 }
      : { method: 'turn/completed', params: { threadId: 'root', turn: { id: 'root-turn', status: outcome, items: [] } }, observedAt: 2 };
    const after = reduceSessionRuntime(before, event);
    expect(before).toEqual(original);
    expect(after.turns[0]!.items.map(item => 'status' in item ? item.status : null)).toEqual(['incomplete', 'incomplete', 'incomplete', 'incomplete', 'incomplete', 'incomplete', 'completed']);
    expect(after.turns[1]).toEqual(before.turns[1]);
    expect(after.turns[0]!.items[0]).toMatchObject({ content: [{ type: 'output_text', text: 'Partial' }] });
    after.turns.flatMap(binding => binding.items).forEach(item => parseAgentsContract('Item', item));
    const session: AgentSession = { id: 'session', object: 'agent.session', agent: sessionAgent({ model: 'test' }, 'agent', 1), environment: { type: 'none' }, created_at: 1,
      last_active_at: 1, status: 'in_progress', error: null, usage: null, vault_ids: [], required_actions: [], metadata: {} };
    const snapshot = (state: typeof before) => ({ session, turns: state.turns.map(binding => binding.turn), items: state.turns.flatMap(binding => binding.items) });
    const events = planSessionStream(snapshot(before), snapshot(after));
    events.forEach((event, index) => parseAgentsContract('SessionEvent', { ...event, event_id: `evt_${index}` }));
    expect(events.filter(event => event.type === 'agent.session.turn.item.done')).toHaveLength(6);
    expect(events.flatMap((event, index) => event.type === 'agent.session.turn.item.done' ? [index] : []).at(-1)).toBeLessThan(events.findIndex(event => event.type === 'agent.session.turn.cancelled' || event.type === 'agent.session.turn.failed'));
  });

  it('closes all active Items on harness loss without altering confirmed history', () => {
    const before = fixture();
    const after = stoppedSessionRuntime(before, 2);
    for (const binding of after.turns) {
      expect(binding.turn.status).toBe('failed');
      expect(binding.items.map(item => 'status' in item ? item.status : null)).toEqual(['incomplete', 'incomplete', 'incomplete', 'incomplete', 'incomplete', 'incomplete', 'completed']);
    }
    expect(stoppedSessionRuntime(after, 3)).toEqual(after);
    expect(before.turns[0]!.items[0]).toMatchObject({ status: 'in_progress' });
  });

  it('leaves Items active during retryable errors and preserves confirmed tool failures', () => {
    const before = fixture();
    expect(reduceSessionRuntime(before, { method: 'error', params: { threadId: 'root', turnId: 'root-turn', willRetry: true }, observedAt: 2 })).toBe(before);
    const failed = reduceSessionRuntime(before, { method: 'item/completed', params: { threadId: 'root', turnId: 'root-turn', item: { id: 'command', type: 'commandExecution', command: 'work', status: 'failed', exitCode: 1, aggregatedOutput: 'Known failure' } }, observedAt: 2 });
    const stopped = stoppedSessionRuntime(failed, 3);
    expect(stopped.turns[0]!.items.find(item => item.id === 'command')).toMatchObject({ status: 'failed', exit_code: 1, output: 'Known failure' });
  });

  it.each([
    ['item/agentMessage/delta', 'message'],
    ['item/reasoning/summaryTextDelta', 'reasoning'],
    ['item/commandExecution/outputDelta', 'command'],
  ])('does not append a late %s after the Item reached its final state', (method, itemId) => {
    const before = stoppedSessionRuntime(fixture(), 2);
    const next = reduceSessionRuntime(before, { method, params: { threadId: 'root', turnId: 'root-turn', itemId, summaryIndex: 0, delta: 'late replay' }, observedAt: 3 });
    expect(next).toEqual(before);
  });
});
