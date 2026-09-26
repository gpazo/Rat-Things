import { describe, expect, it } from 'vitest';
import { bindSessionTurn, initialSessionRuntime, reduceSessionRuntime, runtimeSubagents } from '../../src/core/session-runtime-planning.js';
import { projectSessionTraces, recordTraceStep } from '../../src/core/session-trace-planning.js';
import { localTraceExport, recordLocalTrace } from '../../src/core/local-trace-planning.js';
import { exportSessionTraces } from '../../src/trace-export.js';
import type { Turn } from '../../src/domain/agents-api.js';

const turn: Turn = { id: 'turn_public', object: 'agent.session.turn', session_id: 'sess', agent_id: 'root', subagent_id: null,
  status: 'completed', created_at: 10, started_at: 10, completed_at: 20, usage: null, error: null };

describe('OTLP capture and export', () => {
  it('captures tool timing and exact generation usage without copying confidential native content', () => {
    let state = initialSessionRuntime('sess', 'root', 'thread');
    const emit = (method: string, params: Record<string, unknown>, observedAt: number) => {
      state = reduceSessionRuntime(state, { method, params: { threadId: 'thread', turnId: 'native', ...params }, observedAt });
    };
    emit('turn/started', { turn: { id: 'native', startedAt: 10 } }, 10);
    emit('item/started', { item: { id: 'tool', type: 'commandExecution', command: 'SECRET' } }, 11);
    emit('item/completed', { item: { id: 'tool', type: 'commandExecution', status: 'failed', aggregatedOutput: 'SECRET' } }, 13);
    emit('rawResponse/completed', { responseId: 'response', usage: { inputTokens: 9, outputTokens: 2 }, reasoning: 'SECRET' }, 14);
    emit('rawResponse/completed', { responseId: 'response', usage: { inputTokens: 9, outputTokens: 2 } }, 15);
    emit('turn/completed', { turn: { id: 'native', status: 'completed', completedAt: 20 } }, 20);
    state = bindSessionTurn(state, 'native', turn);
    const original = structuredClone(state);
    const traces = projectSessionTraces({ id: 'sess' }, state.turns.map(binding => ({ turn: binding.turn, steps: binding.traceSteps ?? [] })));
    const spans = traces[0]!.otlp.resourceSpans[0]!.scopeSpans[0]!.spans;
    expect(spans).toHaveLength(3);
    expect(spans[1]).toMatchObject({ parentSpanId: spans[0]!.spanId, startTimeUnixNano: '11000000000', endTimeUnixNano: '13000000000', status: { code: 2 } });
    expect(spans[2]).toMatchObject({ startTimeUnixNano: '14000000000', endTimeUnixNano: '14000000000' });
    expect(spans[2]!.attributes).toContainEqual({ key: 'gen_ai.usage.input_tokens', value: { intValue: '9' } });
    expect(spans.every(span => /^[a-f0-9]{32}$/.test(span.traceId) && /^[a-f0-9]{16}$/.test(span.spanId))).toBe(true);
    expect(JSON.stringify(traces)).not.toContain('SECRET');
    expect(state).toEqual(original);
    expect(projectSessionTraces({ id: 'sess' }, state.turns.map(binding => ({ turn: binding.turn, steps: binding.traceSteps ?? [] })))).toEqual(traces);
  });

  it('keeps a late child attached to its originating Turn after a new root Turn starts', () => {
    let state = initialSessionRuntime('sess', 'root', 'thread');
    const emit = (method: string, params: Record<string, unknown>, observedAt: number) => { state = reduceSessionRuntime(state, { method, params, observedAt }); };
    emit('turn/started', { threadId: 'thread', turn: { id: 'native' } }, 10);
    emit('thread/started', { thread: { id: 'child', parentThreadId: 'thread' } }, 11);
    emit('turn/started', { threadId: 'child', turn: { id: 'child_native' } }, 12);
    state = bindSessionTurn(state, 'native', turn);
    emit('turn/completed', { threadId: 'child', turn: { id: 'child_native', status: 'completed' } }, 25);
    const child = runtimeSubagents(state)[0]!.traceTurns![0]!;
    expect(child.parentTurnId).toBe(turn.id);
    const traces = projectSessionTraces({ id: 'sess' }, [{ turn, steps: [] }, { turn: { ...turn, id: 'next', created_at: 12, started_at: 12, completed_at: 30 }, steps: [] }, child]);
    const first = traces[0]!.otlp.resourceSpans[0]!.scopeSpans[0]!.spans;
    expect(first).toHaveLength(2);
    expect(first[1]!.parentSpanId).toBe(first[0]!.spanId);
    expect(traces[1]!.otlp.resourceSpans[0]!.scopeSpans[0]!.spans).toHaveLength(1);
  });

  it('exports all pages, rejects repeating cursors, and exposes no trace for an active Turn', async () => {
    const traces = projectSessionTraces({ id: 'sess' }, [{ turn, steps: [] }]);
    expect(projectSessionTraces({ id: 'sess' }, [{ turn: { ...turn, completed_at: null, status: 'in_progress' }, steps: [] }])).toEqual([]);
    const queries: unknown[] = [];
    const output = await exportSessionTraces(async query => {
      queries.push(query);
      return { object: 'list', data: traces, has_more: queries.length === 1, first_id: traces[0]!.id, last_id: traces[0]!.id };
    });
    expect(output.resourceSpans).toHaveLength(2);
    expect(queries[1]).toEqual({ order: 'asc', after: traces[0]!.id });
    await expect(exportSessionTraces(async () => ({ object: 'list', data: traces, has_more: true, first_id: traces[0]!.id, last_id: traces[0]!.id }))).rejects.toThrow('did not advance');
  });

  it('does not invent a start time when attachment replays a start after completion', () => {
    const completed = recordTraceStep([], { method: 'item/completed', params: { item: { id: 'tool', type: 'mcpToolCall', status: 'completed', tool: 'lookup', server: 'docs' } }, observedAt: 4 });
    const replayed = recordTraceStep(completed, { method: 'item/started', params: { item: { id: 'tool', type: 'mcpToolCall', tool: 'lookup', server: 'docs' } }, observedAt: 8 });
    expect(replayed).toEqual(completed);
    expect(replayed[0]).toMatchObject({ toolName: 'lookup', serverLabel: 'docs' });
    expect(projectSessionTraces({ id: 'sess' }, [{ turn, steps: [] }], 'alice')[0]!.id).not.toBe(projectSessionTraces({ id: 'sess' }, [{ turn, steps: [] }], 'bob')[0]!.id);
  });

  it('supports local capture and records incomplete work without inventing a successful completion', () => {
    const state = recordLocalTrace(undefined, 'local_sess', { method: 'turn/started', params: { threadId: 'thread', turn: { id: 'native' } }, observedAt: 1 });
    const output = localTraceExport(state, 'local_sess', 'model', 1, 3, 'failed');
    expect(output.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.status.code).toBe(2);
    expect(localTraceExport(undefined, 'local_sess', undefined, 1, 3, 'completed').resourceSpans).toHaveLength(1);
    expect(recordTraceStep([], { method: 'item/started', params: { item: { id: 'reasoning', type: 'reasoning', text: 'SECRET' } }, observedAt: 1 })).toEqual([]);
  });
});
