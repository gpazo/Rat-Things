import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExecutionHeartbeat } from '../../src/runner/heartbeat.js';

const execution = {
  backend: 'microvm' as const,
  id: 'microvm-1',
  generation: 'a'.repeat(64),
};

describe('execution heartbeat', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('serially refreshes the exact execution generation', async () => {
    vi.useFakeTimers();
    const heartbeatExecution = vi.fn().mockResolvedValue(true);
    const heartbeat = new ExecutionHeartbeat({
      store: { heartbeatExecution },
      runId: 'run-1',
      execution,
      intervalMs: 10,
      now: () => new Date('2026-08-24T20:00:00.000Z'),
      onAuthorityLost: vi.fn(),
    });

    heartbeat.start();
    await vi.advanceTimersByTimeAsync(20);
    await heartbeat.stop();

    expect(heartbeatExecution).toHaveBeenCalledTimes(2);
    expect(heartbeatExecution).toHaveBeenCalledWith(
      'run-1',
      execution,
      '2026-08-24T20:00:00.000Z',
    );
  });

  it('aborts its worker when the conditional heartbeat loses authority', async () => {
    vi.useFakeTimers();
    const onAuthorityLost = vi.fn();
    const heartbeatExecution = vi.fn().mockResolvedValue(false);
    const heartbeat = new ExecutionHeartbeat({
      store: { heartbeatExecution },
      runId: 'run-1',
      execution,
      intervalMs: 10,
      onAuthorityLost,
    });

    heartbeat.start();
    await vi.advanceTimersByTimeAsync(30);
    await heartbeat.stop();

    expect(heartbeatExecution).toHaveBeenCalledTimes(1);
    expect(onAuthorityLost).toHaveBeenCalledOnce();
  });

  it('reports transient storage failures without overlapping or surrendering authority', async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const heartbeatExecution = vi.fn()
      .mockRejectedValueOnce(new Error('temporary DynamoDB failure'))
      .mockResolvedValue(true);
    const heartbeat = new ExecutionHeartbeat({
      store: { heartbeatExecution },
      runId: 'run-1',
      execution,
      intervalMs: 10,
      onAuthorityLost: vi.fn(),
      onError,
    });

    heartbeat.start();
    await vi.advanceTimersByTimeAsync(20);
    await heartbeat.stop();

    expect(onError).toHaveBeenCalledOnce();
    expect(heartbeatExecution).toHaveBeenCalledTimes(2);
  });

  it('recovers from thawed socket errors and resets the bounded failure budget on success', async () => {
    vi.useFakeTimers();
    const disconnected = Object.assign(new Error('write ECONNABORTED'), { code: 'ECONNABORTED' });
    const heartbeatExecution = vi.fn().mockRejectedValueOnce(disconnected).mockRejectedValueOnce(disconnected)
      .mockResolvedValueOnce(true).mockRejectedValueOnce(disconnected).mockRejectedValueOnce(disconnected).mockResolvedValue(true);
    const onAuthorityLost = vi.fn();
    const heartbeat = new ExecutionHeartbeat({ store: { heartbeatExecution }, runId: 'run-1', execution,
      intervalMs: 10, maxConsecutiveErrors: 3, onAuthorityLost });
    heartbeat.start();
    await vi.advanceTimersByTimeAsync(60);
    await heartbeat.stop();
    expect(heartbeatExecution).toHaveBeenCalledTimes(6);
    expect(onAuthorityLost).not.toHaveBeenCalled();
  });

  it('fails closed and stops refreshing after the configured consecutive error budget', async () => {
    vi.useFakeTimers();
    const heartbeatExecution = vi.fn().mockRejectedValue(new Error('storage unavailable'));
    const onAuthorityLost = vi.fn();
    const heartbeat = new ExecutionHeartbeat({ store: { heartbeatExecution }, runId: 'run-1', execution,
      intervalMs: 10, maxConsecutiveErrors: 3, onAuthorityLost });
    heartbeat.start();
    await vi.advanceTimersByTimeAsync(20);
    expect(onAuthorityLost).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    await heartbeat.stop();
    expect(heartbeatExecution).toHaveBeenCalledTimes(3);
    expect(onAuthorityLost).toHaveBeenCalledOnce();
  });

  it('does not retry confirmed authority loss even with an error budget', async () => {
    vi.useFakeTimers();
    const heartbeatExecution = vi.fn().mockResolvedValue(false);
    const onAuthorityLost = vi.fn();
    const heartbeat = new ExecutionHeartbeat({ store: { heartbeatExecution }, runId: 'run-1', execution,
      intervalMs: 10, maxConsecutiveErrors: 3, onAuthorityLost });
    heartbeat.start();
    await vi.advanceTimersByTimeAsync(100);
    await heartbeat.stop();
    expect(heartbeatExecution).toHaveBeenCalledOnce();
    expect(onAuthorityLost).toHaveBeenCalledOnce();
  });
});
