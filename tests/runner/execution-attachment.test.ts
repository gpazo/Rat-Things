import { describe, expect, it } from 'vitest';

import { waitForExecutionAttachment } from '../../src/runner/main.js';
import type { RunRecord } from '../../src/domain/contracts.js';

function record(status: RunRecord['status'], execution?: RunRecord['execution']): RunRecord {
  return {
    runId: 'run-1',
    ownerId: 'owner-1',
    ownerCreated: 'owner-1#2026-08-02T00:00:00.000Z#run-1',
    status,
    createdAt: '2026-08-02T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
    expiresAt: 2_000_000_000,
    requestHash: 'a'.repeat(64),
    input: { bucket: 'artifacts', key: 'input.json', sha256: 'b'.repeat(64) },
    sourceKind: 'api',
    ...(execution ? { execution } : {}),
  };
}

describe('waitForExecutionAttachment', () => {
  it('waits through an unattached dispatch record and returns the attached backend ID', async () => {
    const records = [
      record('dispatching'),
      record('dispatching', { backend: 'ecs', id: 'task-1' }),
    ];
    const store = { get: async () => records.shift() ?? records[records.length - 1] };

    await expect(waitForExecutionAttachment(store, 'run-1', 1_000, undefined, 0)).resolves.toMatchObject({
      execution: { backend: 'ecs', id: 'task-1' },
    });
  });

  it('returns a cancelling record so the worker can finalize without starting the agent', async () => {
    const cancelling = record('cancelling');
    await expect(waitForExecutionAttachment({ get: async () => cancelling }, 'run-1', 1_000)).resolves.toBe(cancelling);
  });

  it('fails closed if the dispatcher never attaches an execution', async () => {
    const unattached = record('dispatching');
    await expect(
      waitForExecutionAttachment({ get: async () => unattached }, 'run-1', 1, undefined, 2),
    ).rejects.toThrow('execution reference was not attached before timeout');
  });

  it('honors cancellation while waiting', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      waitForExecutionAttachment({ get: async () => record('dispatching') }, 'run-1', 1_000, controller.signal),
    ).rejects.toThrow('execution attachment wait was cancelled');
  });
});
