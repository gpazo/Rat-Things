import { describe, expect, it, vi } from 'vitest';
import { AgentsApiError } from '../../src/domain/agents-api-validation.js';
import { activityStream } from '../../src/lambdas/activity-stream.js';

const allowed = { role: 'editor', permissions: ['read'] };

describe('activity stream shutdown', () => {
  it('closes when the Session disappears during iteration', async () => {
    const failure = new AgentsApiError(404, 'Session not found.', 'resource_not_found');
    const response = activityStream(() => ({ async *[Symbol.asyncIterator]() { throw failure; } }), new AbortController().signal, undefined, async () => allowed);
    const reader = response.body!.getReader();
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
  });

  it('cancels a pending next when the client aborts and closes the response', async () => {
    let resolveNext!: (value: IteratorResult<{ event_id: string }>) => void;
    const returned = vi.fn(async () => ({ done: true as const, value: undefined }));
    const iterator: AsyncIterator<{ event_id: string }> = {
      next: () => new Promise(resolve => { resolveNext = resolve; }),
      return: returned,
    };
    const controller = new AbortController();
    const response = activityStream(() => ({ [Symbol.asyncIterator]: () => iterator }), controller.signal, undefined, async () => allowed);
    const reader = response.body!.getReader();
    const read = reader.read();
    await vi.waitFor(() => expect(resolveNext).toBeTypeOf('function'));
    controller.abort();
    await expect(read).resolves.toEqual({ done: true, value: undefined });
    expect(returned).toHaveBeenCalledOnce();
    resolveNext!({ done: false, value: { event_id: 'stale' } });
  });

  it('closes without exposing a queued event after authorization revocation', async () => {
    const revoked = new AgentsApiError(403, 'Access revoked.', 'insufficient_permissions');
    const authorize = vi.fn().mockResolvedValueOnce(allowed).mockRejectedValueOnce(revoked);
    const response = activityStream(() => ({ async *[Symbol.asyncIterator]() { yield { event_id: 'must-not-leak' }; } }), new AbortController().signal, undefined, authorize);
    const reader = response.body!.getReader();
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
  });

  it('preserves unknown iterator failures', async () => {
    const failure = new Error('storage unavailable');
    const response = activityStream(() => ({ async *[Symbol.asyncIterator]() { throw failure; } }), new AbortController().signal, undefined, async () => allowed);
    await expect(response.body!.getReader().read()).rejects.toBe(failure);
  });

  it('aborts a cooperative producer and settles a pending read when its reader cancels', async () => {
    let producerSignal: AbortSignal | undefined;
    let finished = false;
    const response = activityStream(signal => ({ async *[Symbol.asyncIterator]() {
      producerSignal = signal;
      try { await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); }
      finally { finished = true; }
    } }), new AbortController().signal, undefined, async () => allowed);
    const reader = response.body!.getReader();
    const pending = reader.read();
    await vi.waitFor(() => expect(producerSignal).toBeDefined());
    await reader.cancel();
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    await vi.waitFor(() => expect(finished).toBe(true));
    expect(producerSignal!.aborted).toBe(true);
  });
});
