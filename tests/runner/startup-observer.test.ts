import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionItem, Turn } from '../../src/domain/agents-api.js';
import { bindSessionTurn, initialSessionRuntime, type SessionRuntimeState } from '../../src/core/session-runtime-planning.js';
import { createStartupTraceObserver, hasFirstRootAssistantText, publishStartupSnapshot, type StartupTraceRecord } from '../../src/runner/startup-observer.js';

const rootTurn = (id = 'turn-1', subagentId: string | null = null): Turn => ({
  id, object: 'agent.session.turn', session_id: 'session-1', agent_id: 'agent-1', subagent_id: subagentId,
  status: 'queued', created_at: 1, started_at: null, completed_at: null, usage: null, error: null,
});

function stateWith(items: AgentSessionItem[], turn = rootTurn(), threadId = 'root'): SessionRuntimeState {
  const initial = initialSessionRuntime('session-1', 'agent-1', 'root');
  const state = bindSessionTurn(initial, 'native-1', turn);
  return { ...state, turns: state.turns.map((binding) => ({ ...binding, threadId, items })) };
}

function assistantText(text: string, turnId = 'turn-1'): AgentSessionItem {
  return { id: 'item-1', type: 'message', role: 'assistant', turn_id: turnId, phase: 'final_answer', status: 'in_progress', content: [{ type: 'output_text', text }] };
}

function traceHarness() {
  let now = 100;
  const records: StartupTraceRecord[] = [];
  const observer = createStartupTraceObserver({ monotonicNow: () => now, wallNow: () => '2026-11-08T12:00:00.000Z', emit: record => records.push(record) });
  return { observer, records, advance: (milliseconds: number) => { now += milliseconds; } };
}

describe('runner startup observations', () => {
  it('records observed phases with monotonic offsets and a wall origin', () => {
    const trace = traceHarness();
    trace.observer.mark('runner_entered');
    trace.advance(2.5);
    trace.observer.mark('run_loaded');
    trace.advance(7);
    trace.observer.mark('native_initialized');
    trace.observer.finish('shutdown');

    expect(trace.records).toEqual([{
      event: 'runner_startup_trace', version: 1, wallOrigin: '2026-11-08T12:00:00.000Z', outcome: 'shutdown',
      phases: [
        { phase: 'runner_entered', offsetMs: 0 },
        { phase: 'run_loaded', offsetMs: 2.5 },
        { phase: 'native_initialized', offsetMs: 9.5 },
      ],
    }]);
  });

  it('suppresses duplicate phases and accepts absent or out-of-order phases', () => {
    const trace = traceHarness();
    trace.observer.mark('turn_requested');
    trace.advance(1);
    trace.observer.mark('run_loaded');
    trace.advance(1);
    trace.observer.mark('turn_requested');
    trace.observer.finish('failed');

    expect(trace.records[0]?.phases).toEqual([
      { phase: 'turn_requested', offsetMs: 0 },
      { phase: 'run_loaded', offsetMs: 1 },
    ]);
  });

  it('never lets a failing sink or clock escape into worker execution', () => {
    const sinkTrace = createStartupTraceObserver({ monotonicNow: () => 1, emit: () => { throw new Error('log unavailable'); } });
    expect(() => { sinkTrace.mark('runner_entered'); sinkTrace.finish('failed'); }).not.toThrow();

    const clockTrace = createStartupTraceObserver({ monotonicNow: vi.fn().mockReturnValueOnce(1).mockImplementation(() => { throw new Error('clock unavailable'); }), emit: vi.fn() });
    expect(() => { clockTrace.mark('runner_entered'); clockTrace.finish('shutdown'); }).not.toThrow();
  });

  it('recognizes only nonempty assistant text on the accepted root Turn', () => {
    const userMessage = { id: 'user-1', type: 'message', role: 'user', turn_id: 'turn-1', phase: null, status: 'completed', content: [{ type: 'input_text', text: 'User input' }] } as AgentSessionItem;
    expect(hasFirstRootAssistantText(stateWith([]), 'turn-1')).toBe(false);
    expect(hasFirstRootAssistantText(stateWith([userMessage]), 'turn-1')).toBe(false);
    expect(hasFirstRootAssistantText(stateWith([assistantText('  \n')]), 'turn-1')).toBe(false);
    expect(hasFirstRootAssistantText(stateWith([assistantText('child output')], rootTurn('turn-1', 'child-1'), 'child-thread'), 'turn-1')).toBe(false);
    expect(hasFirstRootAssistantText(stateWith([assistantText('previous output')], rootTurn('previous-turn')), 'turn-1')).toBe(false);
    expect(hasFirstRootAssistantText(stateWith([assistantText('Visible output')]), 'turn-1')).toBe(true);
  });

  it('finishes on the first assistant snapshot acknowledged by the publisher', async () => {
    const trace = traceHarness();
    const snapshot = stateWith([assistantText('Visible output')]);
    trace.observer.mark('first_assistant_text');
    const publish = vi.fn(async () => true);

    await expect(publishStartupSnapshot(snapshot, 'turn-1', trace.observer, publish)).resolves.toBe(true);
    expect(publish).toHaveBeenCalledExactlyOnceWith(snapshot);
    expect(trace.records[0]).toMatchObject({ outcome: 'first_text_persisted', phases: [
      { phase: 'first_assistant_text', offsetMs: 0 },
      { phase: 'first_text_persisted', offsetMs: 0 },
    ] });
    expect(JSON.stringify(trace.records[0])).not.toContain('Visible output');
  });

  it('does not record persistence when a snapshot is rejected or fails to publish', async () => {
    const rejected = traceHarness();
    const snapshot = stateWith([assistantText('Visible output')]);
    rejected.observer.mark('first_assistant_text');
    await expect(publishStartupSnapshot(snapshot, 'turn-1', rejected.observer, async () => false)).resolves.toBe(false);
    rejected.observer.finish('shutdown');
    expect(rejected.records[0]?.phases.map(({ phase }) => phase)).toEqual(['first_assistant_text']);

    const failed = traceHarness();
    const failure = new Error('store failed');
    await expect(publishStartupSnapshot(snapshot, 'turn-1', failed.observer, async () => { throw failure; })).rejects.toBe(failure);
    failed.observer.finish('failed');
    expect(failed.records[0]?.phases).toEqual([]);
  });
});
