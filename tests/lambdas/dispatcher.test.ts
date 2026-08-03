import type { SQSEvent } from 'aws-lambda';
import { describe, expect, it, vi } from 'vitest';
import type { DispatcherDependencies } from '../../src/lambdas/dispatcher.js';
import { createDispatcher } from '../../src/lambdas/dispatcher.js';
import type { RunRecord, RunRequest, RunStatus } from '../../src/domain/contracts.js';

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
