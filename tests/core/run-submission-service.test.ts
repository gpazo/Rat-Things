import { describe, expect, it, vi } from 'vitest';
import { RunSubmissionService } from '../../src/core/run-submission-service.js';

const request = {
  version: '1' as const,
  prompt: 'Return the marker.',
  source: { kind: 'api' as const },
};

describe('RunSubmissionService', () => {
  it('reserves one-shot work directly as a canonical Run', async () => {
    const runs = {
      canonicalize: vi.fn().mockReturnValue(request),
      submit: vi.fn().mockResolvedValue({ runId: 'run-1' }),
    };
    const threads = { submitThread: vi.fn() };
    const service = new RunSubmissionService(runs as never, threads);

    await expect(service.submit('owner-1', request, {
      idempotencyKey: 'one-shot-1',
    })).resolves.toEqual({ runId: 'run-1' });

    expect(runs.submit).toHaveBeenCalledWith('owner-1', request, {
      idempotencyKey: 'one-shot-1',
    });
    expect(threads.submitThread).not.toHaveBeenCalled();
  });

  it('reserves threaded work as the same public Run before continuity preparation', async () => {
    const runs = {
      canonicalize: vi.fn().mockReturnValue(request),
      submit: vi.fn(),
    };
    const threads = {
      submitThread: vi.fn().mockResolvedValue({ runId: 'run-thread-1', status: 'queued' }),
    };
    const service = new RunSubmissionService(runs as never, threads);
    const thread = {
      conversationId: 'api:owner:release',
      messageId: 'message-1',
    };

    await expect(service.submit('owner-1', request, {
      idempotencyKey: 'message-1',
      traceId: 'trace-1',
      thread,
    })).resolves.toEqual({ runId: 'run-thread-1', status: 'queued' });

    expect(threads.submitThread).toHaveBeenCalledWith(
      'owner-1',
      request,
      { idempotencyKey: 'message-1', traceId: 'trace-1' },
      thread,
    );
    expect(runs.submit).not.toHaveBeenCalled();
  });
});
