import { describe, expect, it, vi } from 'vitest';
import type { ArtifactStore } from '../../src/core/ports.js';
import type { RunRecord } from '../../src/domain/contracts.js';
import { InvalidStateTransitionError } from '../../src/domain/state.js';
import { RunDispatcher } from '../../src/execution/dispatcher.js';
import { executionGeneration } from '../../src/execution/generation.js';
import { execution, request, run } from './fixtures.js';

const message = { version: '1' as const, runId: 'run-1', traceId: 'trace-1' };

function fixture(current = run()) {
  const events: string[] = [];
  const attached = { ...execution, generation: current.execution?.generation ?? executionGeneration(current) };
  const claimed = { ...current, status: 'dispatching' as const, execution: { ...attached, id: 'pending' } };
  const store = {
    get: vi.fn(async (_runId: string): Promise<RunRecord | undefined> => { events.push('get'); return current; }),
    transition: vi.fn(async () => { events.push('transition'); return claimed; }),
    attachExecution: vi.fn(async () => { events.push('attach'); return { ...claimed, execution: attached }; }),
    fail: vi.fn(async () => { events.push('fail'); return { ...claimed, status: 'failed' as const }; }),
  };
  const readJson = vi.fn(async (_reference: Parameters<ArtifactStore['getJson']>[0]) => {
    events.push('input'); return request;
  });
  const artifacts: Pick<ArtifactStore, 'getJson'> = {
    getJson: async <T>(reference: Parameters<ArtifactStore['getJson']>[0]) => await readJson(reference) as T,
  };
  const executor = {
    backend: 'microvm' as const,
    start: vi.fn(async () => { events.push('start'); return attached; }),
    stop: vi.fn(async () => { events.push('stop'); }),
  };
  const executors = { get: vi.fn(() => { events.push('executor'); return executor; }) };
  const dispatcher = new RunDispatcher({ store, artifacts, executors, defaultBackend: 'microvm' });
  return { dispatcher, store, readJson, executor, executors, events, attached, claimed };
}

describe('dispatch effect boundaries', () => {
  it('loads input, selects the executor, claims the run, starts it, then attaches the exact execution', async () => {
    const test = fixture();
    await test.dispatcher.dispatch(message);
    expect(test.events).toEqual(['get', 'input', 'executor', 'transition', 'start', 'attach']);
    expect(test.store.transition).toHaveBeenCalledWith('run-1', ['queued'], 'dispatching', {
      execution: { backend: 'microvm', id: 'pending', generation: test.attached.generation },
    });
    expect(test.executor.start).toHaveBeenCalledWith(test.claimed, request, 'trace-1');
    expect(test.store.attachExecution).toHaveBeenCalledWith('run-1', test.attached);
  });

  it('ignores unprepared conversation wake-ups before reading input and uses prepared content when present', async () => {
    const current = run({ conversation: { conversationId: 'conversation-1' } });
    const waiting = fixture(current);
    await waiting.dispatcher.dispatch(message);
    expect(waiting.events).toEqual(['get']);
    const executionInput = { ...current.input, key: 'prepared.json' };
    const ready = fixture({ ...current, executionInput });
    await ready.dispatcher.dispatch(message);
    expect(ready.readJson).toHaveBeenCalledWith(executionInput);
  });

  it('does not claim a run when executor selection fails', async () => {
    const test = fixture();
    const failure = new Error('executor unavailable');
    test.executors.get.mockImplementation(() => { throw failure; });
    await expect(test.dispatcher.dispatch(message)).rejects.toBe(failure);
    expect(test.store.transition).not.toHaveBeenCalled();
    expect(test.executor.start).not.toHaveBeenCalled();
  });

  it.each([undefined, run()])('preserves a lost claim error when the latest record is still queued or missing: %j', async latest => {
    const test = fixture();
    const failure = new InvalidStateTransitionError('queued', 'dispatching');
    test.store.transition.mockRejectedValueOnce(failure);
    test.store.get.mockResolvedValueOnce(run()).mockResolvedValueOnce(latest);
    await expect(test.dispatcher.dispatch(message)).rejects.toBe(failure);
    expect(test.store.get).toHaveBeenCalledTimes(2);
    expect(test.executor.start).not.toHaveBeenCalled();
  });

  it('returns retryable start errors unchanged without failing the run', async () => {
    const test = fixture();
    const failure = Object.assign(new Error('back off'), { name: 'ThrottlingException' });
    test.executor.start.mockRejectedValueOnce(failure);
    await expect(test.dispatcher.dispatch(message)).rejects.toBe(failure);
    expect(test.store.fail).not.toHaveBeenCalled();
    expect(test.executor.stop).not.toHaveBeenCalled();
    expect(test.store.attachExecution).not.toHaveBeenCalled();
  });

  it('persists a bounded terminal start failure and propagates a failed persistence attempt', async () => {
    const test = fixture();
    test.executor.start.mockRejectedValue(new Error('x'.repeat(1_200)));
    await test.dispatcher.dispatch(message);
    expect(test.store.fail).toHaveBeenCalledWith('run-1', {
      code: 'executor_start_failed', message: 'x'.repeat(1_000), retryable: false,
    }, ['dispatching']);
    const failure = new Error('write unavailable');
    test.store.fail.mockRejectedValueOnce(failure);
    await expect(test.dispatcher.dispatch(message)).rejects.toBe(failure);
  });

  it('stops a mismatched generation before marking failure and stops there if cleanup fails', async () => {
    const test = fixture();
    test.executor.start.mockResolvedValue({ ...test.attached, generation: 'wrong' });
    await test.dispatcher.dispatch(message);
    expect(test.events).toEqual(['get', 'input', 'executor', 'transition', 'stop', 'fail']);
    expect(test.store.fail).toHaveBeenCalledWith('run-1', {
      code: 'executor_identity_mismatch', message: 'executor returned an invalid execution identity', retryable: false,
    }, ['dispatching']);
    expect(test.store.attachExecution).not.toHaveBeenCalled();
    test.store.fail.mockClear();
    const failure = new Error('stop unavailable');
    test.executor.stop.mockRejectedValueOnce(failure);
    await expect(test.dispatcher.dispatch(message)).rejects.toBe(failure);
    expect(test.store.fail).not.toHaveBeenCalled();
  });

  it('stops before rereading a raced attachment and finalizes a pending cancellation', async () => {
    const test = fixture();
    test.store.attachExecution.mockRejectedValueOnce(new InvalidStateTransitionError('cancelling', 'running'));
    test.store.get.mockImplementationOnce(async () => { test.events.push('get'); return run(); })
      .mockImplementationOnce(async () => { test.events.push('reread'); return run({ status: 'cancelling' }); });
    await test.dispatcher.dispatch(message);
    expect(test.events).toEqual(['get', 'input', 'executor', 'transition', 'start', 'stop', 'reread', 'transition']);
    expect(test.store.transition).toHaveBeenLastCalledWith('run-1', ['cancelling'], 'cancelled');
  });

  it('lets cleanup failure supersede an attachment error without rereading or finalizing the run', async () => {
    const test = fixture();
    test.store.attachExecution.mockRejectedValueOnce(new InvalidStateTransitionError('cancelling', 'running'));
    const failure = new Error('stop unavailable');
    test.executor.stop.mockRejectedValueOnce(failure);
    await expect(test.dispatcher.dispatch(message)).rejects.toBe(failure);
    expect(test.store.get).toHaveBeenCalledTimes(1);
    expect(test.store.transition).toHaveBeenCalledTimes(1);
  });
});
