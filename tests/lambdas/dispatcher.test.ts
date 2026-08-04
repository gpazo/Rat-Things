import type { SQSEvent } from 'aws-lambda';
import { describe, expect, it, vi } from 'vitest';
import type { DispatcherDependencies } from '../../src/lambdas/dispatcher.js';
import { createDispatcher } from '../../src/lambdas/dispatcher.js';
import type { RunRecord, RunRequest, RunStatus } from '../../src/domain/contracts.js';
import { InvalidStateTransitionError } from '../../src/domain/state.js';

const request: RunRequest = {
  version: '1',
  prompt: 'Exercise dispatcher',
  agent: { driver: 'mock', sandbox: 'read-only' },
};

function queuedRun(): RunRecord {
  return {
    runId: 'run-1',
    ownerId: 'test-owner',
    ownerCreated: 'test-owner#2026-01-01T00:00:00.000Z#run-1',
    status: 'queued',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: 1_800_000_000,
    requestHash: 'abc123',
    input: { bucket: 'artifacts', key: 'input.json', sha256: 'abc123' },
    sourceKind: 'api',
  };
}

describe('dispatcher factory', () => {
  it('dispatches a queued run and attaches its execution reference', async () => {
    let run = queuedRun();
    const start = vi.fn(async () => ({ backend: 'microvm' as const, id: 'microvm-1' }));
    const dependencies: DispatcherDependencies = {
      store: {
        get: async () => run,
        transition: async (_runId, _from, status, patch = {}) => {
          run = { ...run, ...patch, status, updatedAt: '2026-01-01T00:00:01.000Z' };
          return run;
        },
        attachExecution: async (_runId, execution) => {
          run = { ...run, execution };
          return run;
        },
        fail: async (_runId, error, _from?: RunStatus[]) => {
          run = { ...run, status: 'failed', error };
          return run;
        },
      },
      artifacts: { getJson: async <T>() => request as T },
      executors: {
        get: () => ({ backend: 'microvm', start, stop: async () => undefined }),
      },
    };

    const response = await invoke(createDispatcher(dependencies), queueEvent(JSON.stringify({
      version: '1',
      runId: run.runId,
      traceId: 'trace-1',
    })));

    expect(response).toEqual({ batchItemFailures: [] });
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-1' }), request, 'trace-1');
    expect(run).toMatchObject({
      status: 'dispatching',
      execution: { backend: 'microvm', id: 'microvm-1' },
    });
  });

  it('reports malformed queue records as batch failures', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await invoke(createDispatcher({} as DispatcherDependencies), queueEvent('{}'));
    expect(response).toEqual({ batchItemFailures: [{ itemIdentifier: 'message-1' }] });
    error.mockRestore();
  });

  it('retries a duplicate dispatch while AWS is creating the idempotent MicroVM', async () => {
    let run = queuedRun();
    const creationInProgress = Object.assign(
      new Error('MicroVM creation in progress for this clientToken.'),
      { name: 'ConflictException' },
    );
    const fail = vi.fn();
    const dependencies: DispatcherDependencies = {
      store: {
        get: async () => run,
        transition: async (_runId, _from, status, patch = {}) => {
          run = { ...run, ...patch, status, updatedAt: '2026-01-01T00:00:01.000Z' };
          return run;
        },
        attachExecution: vi.fn(),
        fail,
      },
      artifacts: { getJson: async <T>() => request as T },
      executors: {
        get: () => ({
          backend: 'microvm',
          start: async () => { throw creationInProgress; },
          stop: async () => undefined,
        }),
      },
    };
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await invoke(createDispatcher(dependencies), queueEvent(JSON.stringify({
      version: '1',
      runId: run.runId,
      traceId: 'trace-1',
    })));

    expect(response).toEqual({ batchItemFailures: [{ itemIdentifier: 'message-1' }] });
    expect(run.status).toBe('dispatching');
    expect(fail).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('ignores a duplicate wake-up after an execution has been attached', async () => {
    const run: RunRecord = {
      ...queuedRun(),
      status: 'dispatching',
      execution: { backend: 'microvm', id: 'microvm-1' },
    };
    const start = vi.fn();
    const getJson = vi.fn();
    const dependencies: DispatcherDependencies = {
      store: {
        get: async () => run,
        transition: vi.fn(),
        attachExecution: vi.fn(),
        fail: vi.fn(),
      },
      artifacts: { getJson },
      executors: {
        get: () => ({ backend: 'microvm', start, stop: async () => undefined }),
      },
    };

    const response = await invoke(createDispatcher(dependencies), queueEvent(JSON.stringify({
      version: '1',
      runId: run.runId,
      traceId: 'trace-1',
    })));

    expect(response).toEqual({ batchItemFailures: [] });
    expect(getJson).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it('lets only one concurrent delivery claim a queued run', async () => {
    const queued = queuedRun();
    const claimed = { ...queued, status: 'dispatching' as const };
    const start = vi.fn();
    const get = vi.fn()
      .mockResolvedValueOnce(queued)
      .mockResolvedValueOnce(claimed);
    const dependencies: DispatcherDependencies = {
      store: {
        get,
        transition: vi.fn().mockRejectedValue(
          new InvalidStateTransitionError('dispatching', 'dispatching'),
        ),
        attachExecution: vi.fn(),
        fail: vi.fn(),
      },
      artifacts: { getJson: async <T>() => request as T },
      executors: {
        get: () => ({ backend: 'microvm', start, stop: async () => undefined }),
      },
    };

    const response = await invoke(createDispatcher(dependencies), queueEvent(JSON.stringify({
      version: '1',
      runId: queued.runId,
      traceId: 'trace-1',
    })));

    expect(response).toEqual({ batchItemFailures: [] });
    expect(get).toHaveBeenCalledTimes(2);
    expect(start).not.toHaveBeenCalled();
  });
});

function queueEvent(body: string): SQSEvent {
  return {
    Records: [
      {
        messageId: 'message-1',
        receiptHandle: 'receipt-1',
        body,
        attributes: {
          ApproximateReceiveCount: '1',
          SentTimestamp: '1',
          SenderId: 'local',
          ApproximateFirstReceiveTimestamp: '1',
        },
        messageAttributes: {},
        md5OfBody: 'unused',
        eventSource: 'aws:sqs',
        eventSourceARN: 'arn:aws:sqs:us-east-1:000000000000:runs',
        awsRegion: 'us-east-1',
      },
    ],
  };
}

async function invoke(handler: unknown, event: SQSEvent) {
  return (handler as (value: SQSEvent) => Promise<unknown>)(event);
}
