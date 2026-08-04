import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import type {
  ArtifactReference,
  ExecutionReference,
  ListRunsResult,
  RunError,
  RunQueueMessage,
  RunRecord,
  RunResult,
  RunStatus,
} from '../../src/domain/contracts.js';
import { assertTransition } from '../../src/domain/state.js';
import {
  ConflictError,
  ForbiddenError,
  RunService,
} from '../../src/core/run-service.js';
import type {
  ArtifactStore,
  Clock,
  CreateRunResult,
  ExecutionController,
  IdGenerator,
  RunQueue,
  RunStore,
} from '../../src/core/ports.js';

class MemoryRunStore implements RunStore {
  public readonly records = new Map<string, RunRecord>();
  public createCalls = 0;
  public transitionCalls: Array<{ runId: string; from: RunStatus[]; to: RunStatus }> = [];

  public async create(record: RunRecord): Promise<CreateRunResult> {
    this.createCalls += 1;
    const existing = this.records.get(record.runId);
    if (existing) return { created: false, record: structuredClone(existing) };
    const stored = structuredClone(record);
    this.records.set(record.runId, stored);
    return { created: true, record: structuredClone(stored) };
  }

  public async get(runId: string): Promise<RunRecord | undefined> {
    const record = this.records.get(runId);
    return record ? structuredClone(record) : undefined;
  }

  public async list(ownerId: string, limit: number, nextToken?: string): Promise<ListRunsResult> {
    const offset = nextToken ? Number(nextToken) : 0;
    const all = [...this.records.values()]
      .filter((record) => record.ownerId === ownerId)
      .sort((left, right) => left.ownerCreated.localeCompare(right.ownerCreated));
    const items = all.slice(offset, offset + limit).map((record) => structuredClone(record));
    const next = offset + items.length;
    return next < all.length ? { items, nextToken: String(next) } : { items };
  }

  public async transition(
    runId: string,
    from: RunStatus[],
    to: RunStatus,
    patch: Partial<RunRecord> = {},
  ): Promise<RunRecord> {
    const record = this.required(runId);
    if (!from.includes(record.status)) {
      throw new Error(`conditional transition failed: ${record.status} not in ${from.join(',')}`);
    }
    assertTransition(record.status, to);
    this.transitionCalls.push({ runId, from: [...from], to });
    Object.assign(record, structuredClone(patch), { status: to });
    return structuredClone(record);
  }

  public async attachExecution(runId: string, execution: ExecutionReference): Promise<RunRecord> {
    const record = this.required(runId);
    record.execution = structuredClone(execution);
    return structuredClone(record);
  }

  public async complete(runId: string, result: RunResult): Promise<RunRecord> {
    const record = this.required(runId);
    assertTransition(record.status, 'succeeded');
    record.status = 'succeeded';
    record.result = structuredClone(result);
    return structuredClone(record);
  }

  public async fail(
    runId: string,
    error: RunError,
    from: RunStatus[] = ['queued', 'dispatching', 'running', 'cancelling'],
  ): Promise<RunRecord> {
    const record = this.required(runId);
    if (!from.includes(record.status)) throw new Error('conditional failure update failed');
    assertTransition(record.status, 'failed');
    record.status = 'failed';
    record.error = structuredClone(error);
    return structuredClone(record);
  }

  private required(runId: string): RunRecord {
    const record = this.records.get(runId);
    if (!record) throw new Error(`missing run ${runId}`);
    return record;
  }
}

class MemoryArtifactStore implements ArtifactStore {
  public readonly jsonWrites: Array<{ key: string; value: unknown }> = [];
  public readonly byteWrites: Array<{ key: string; value: Uint8Array; contentType: string }> = [];

  public async putJson(key: string, value: unknown): Promise<ArtifactReference> {
    this.jsonWrites.push({ key, value: structuredClone(value) });
    return reference(key, JSON.stringify(value));
  }

  public async getJson<T>(input: Pick<ArtifactReference, 'bucket' | 'key'>): Promise<T> {
    const found = this.jsonWrites.find(({ key }) => key === input.key);
    if (!found) throw new Error(`missing artifact ${input.bucket}/${input.key}`);
    return structuredClone(found.value) as T;
  }

  public async putBytes(
    key: string,
    value: Uint8Array,
    contentType: string,
  ): Promise<ArtifactReference> {
    this.byteWrites.push({ key, value: Uint8Array.from(value), contentType });
    return reference(key, value);
  }
}

class MemoryQueue implements RunQueue {
  public readonly messages: RunQueueMessage[] = [];
  public failure?: Error;

  public async enqueue(message: RunQueueMessage): Promise<void> {
    if (this.failure) throw this.failure;
    this.messages.push(structuredClone(message));
  }
}

class MemoryExecutions implements ExecutionController {
  public readonly stops: Array<{ execution: ExecutionReference; reason: string }> = [];

  public async stop(execution: ExecutionReference, reason: string): Promise<void> {
    this.stops.push({ execution: structuredClone(execution), reason });
  }
}

const fixedNow = new Date('2026-08-02T12:34:56.000Z');
const clock: Clock = { now: () => fixedNow };
const ids: IdGenerator = {
  random: () => 'random-run-id',
  deterministic: (ownerId, key) => `deterministic:${ownerId}:${key}`,
};

function harness() {
  const store = new MemoryRunStore();
  const artifacts = new MemoryArtifactStore();
  const queue = new MemoryQueue();
  const executions = new MemoryExecutions();
  const service = new RunService({
    store,
    artifacts,
    queue,
    executions,
    clock,
    ids,
    retentionSeconds: 600,
    allowedRepositoryHosts: ['github.com', 'gitlab.com'],
  });
  return { service, store, artifacts, queue, executions };
}

const baseRequest = {
  version: '1',
  prompt: 'Review the runtime change.',
  repository: {
    provider: 'github',
    url: 'https://github.com/acme/runtime.git',
    ref: 'feature/runtime',
  },
  source: { kind: 'api', requestId: 'request-1' },
} as const;

describe('RunService.submit', () => {
  it('stores an immutable input reference and enqueues only its run envelope', async () => {
    const { service, store, artifacts, queue } = harness();

    const provenance = {
      actor: { kind: 'human' as const, id: 'api:owner-1', provider: 'api' as const },
      credentialSubject: { kind: 'actor' as const, id: 'api:owner-1' },
    };
    const record = await service.submit('owner-1', baseRequest, { traceId: 'trace-1', provenance });

    expect(record).toMatchObject({
      runId: 'random-run-id',
      ownerId: 'owner-1',
      ownerCreated: 'owner-1#2026-08-02T12:34:56.000Z#random-run-id',
      status: 'queued',
      createdAt: '2026-08-02T12:34:56.000Z',
      updatedAt: '2026-08-02T12:34:56.000Z',
      expiresAt: Math.floor(fixedNow.getTime() / 1_000) + 600,
      sourceKind: 'api',
      provenance,
      input: { bucket: 'test-artifacts' },
    });
    expect(record.requestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(record.input.key).toBe(
      `owners/${createHash('sha256').update('owner-1').digest('hex').slice(0, 32)}` +
        `/runs/random-run-id/input-${record.requestHash}.json`,
    );
    expect(artifacts.jsonWrites).toEqual([{ key: record.input.key, value: baseRequest }]);
    expect(store.createCalls).toBe(1);
    expect(queue.messages).toEqual([{ version: '1', runId: 'random-run-id', traceId: 'trace-1' }]);
  });

  it('allows a coordinator to commit related state before explicitly waking the run', async () => {
    const { service, queue } = harness();

    const record = await service.submit('owner-1', baseRequest, {
      enqueue: false,
    });

    expect(queue.messages).toEqual([]);
    await service.wake(record.runId, 'conversation-trace');
    expect(queue.messages).toEqual([{
      version: '1',
      runId: record.runId,
      traceId: 'conversation-trace',
    }]);
  });

  it('returns the original run for the same idempotency key and canonical request', async () => {
    const { service, store, artifacts, queue } = harness();
    const first = await service.submit(
      'owner-1',
      { ...baseRequest, metadata: { second: 2, first: 1 } },
      { idempotencyKey: 'github:delivery-1' },
    );
    const second = await service.submit(
      'owner-1',
      { ...baseRequest, metadata: { first: 1, second: 2 } },
      { idempotencyKey: 'github:delivery-1' },
    );

    expect(second).toEqual(first);
    expect(first.runId).toBe('deterministic:owner-1:github:delivery-1');
    expect(store.createCalls).toBe(1);
    expect(artifacts.jsonWrites).toHaveLength(1);
    // An idempotent retry re-sends the queue wake-up. The durable record remains the source
    // of truth, so duplicate SQS delivery is harmless and repairs the create/enqueue window.
    expect(queue.messages).toHaveLength(2);
  });

  it('rejects reuse of an idempotency key for a different request', async () => {
    const { service, artifacts, queue } = harness();
    await service.submit('owner-1', baseRequest, { idempotencyKey: 'delivery-1' });

    await expect(
      service.submit(
        'owner-1',
        { ...baseRequest, prompt: 'A different request.' },
        { idempotencyKey: 'delivery-1' },
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(artifacts.jsonWrites).toHaveLength(1);
    expect(queue.messages).toHaveLength(1);
  });

  it('keeps the run queued and repairs an enqueue failure on idempotent retry', async () => {
    const { service, store, queue } = harness();
    const enqueueError = new Error('queue temporarily unavailable');
    queue.failure = enqueueError;

    await expect(
      service.submit('owner-1', baseRequest, { idempotencyKey: 'delivery-queue-failure' }),
    ).rejects.toBe(enqueueError);

    const stored = await store.get('deterministic:owner-1:delivery-queue-failure');
    expect(stored).toMatchObject({ status: 'queued' });

    delete queue.failure;
    const retried = await service.submit('owner-1', baseRequest, {
      idempotencyKey: 'delivery-queue-failure',
    });
    expect(retried.runId).toBe(stored?.runId);
    expect(queue.messages).toHaveLength(1);
  });

  it('rejects unauthenticated owners and unsafe idempotency keys before side effects', async () => {
    const { service, store, artifacts, queue } = harness();

    await expect(service.submit(' \n ', baseRequest)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      service.submit('owner-1', baseRequest, { idempotencyKey: 'contains spaces' }),
    ).rejects.toThrow('Idempotency-Key must be 1-200 safe ASCII characters');
    expect(store.createCalls).toBe(0);
    expect(artifacts.jsonWrites).toEqual([]);
    expect(queue.messages).toEqual([]);
  });
});

describe('RunService ownership and cancellation', () => {
  it('maps malformed pagination cursors to a validation error', async () => {
    const { service, store } = harness();
    store.list = async () => {
      throw new Error('invalid pagination token');
    };

    await expect(service.list('owner-1', 25, 'malformed')).rejects.toThrow('nextToken is invalid');
  });

  it('cancels a queued run without calling the execution backend', async () => {
    const { service, executions } = harness();
    const submitted = await service.submit('owner-1', baseRequest);

    const cancelled = await service.cancel('owner-1', submitted.runId);

    expect(cancelled).toMatchObject({
      status: 'cancelled',
      cancelRequestedAt: '2026-08-02T12:34:56.000Z',
    });
    expect(executions.stops).toEqual([]);
  });

  it('moves a running run to cancelling and stops its recorded execution', async () => {
    const { service, store, executions } = harness();
    const submitted = await service.submit('owner-1', baseRequest);
    await store.transition(submitted.runId, ['queued'], 'dispatching');
    await store.attachExecution(submitted.runId, {
      backend: 'microvm',
      id: 'microvm-1',
      startedAt: fixedNow.toISOString(),
    });
    await store.transition(submitted.runId, ['dispatching'], 'running');

    const cancelling = await service.cancel('owner-1', submitted.runId);

    expect(cancelling.status).toBe('cancelling');
    expect(executions.stops).toEqual([
      {
        execution: {
          backend: 'microvm',
          id: 'microvm-1',
          startedAt: fixedNow.toISOString(),
        },
        reason: 'cancelled by owner-1',
      },
    ]);
  });

  it('enforces ownership and treats final cancellation as idempotent', async () => {
    const { service } = harness();
    const submitted = await service.submit('owner-1', baseRequest);
    await expect(service.get('owner-2', submitted.runId)).rejects.toBeInstanceOf(ForbiddenError);
    await service.cancel('owner-1', submitted.runId);

    const again = await service.cancel('owner-1', submitted.runId);
    expect(again.status).toBe('cancelled');
  });

  it('bounds list page sizes before delegating to the store', async () => {
    const { service, store } = harness();
    const calls: number[] = [];
    const original = store.list.bind(store);
    store.list = async (ownerId, limit, nextToken) => {
      calls.push(limit);
      return original(ownerId, limit, nextToken);
    };

    await service.list('owner-1', 0);
    await service.list('owner-1', 1_000);
    await service.list('owner-1', 12.9);

    expect(calls).toEqual([1, 100, 12]);
  });
});

function reference(key: string, value: string | Uint8Array): ArtifactReference {
  return {
    bucket: 'test-artifacts',
    key,
    sha256: createHash('sha256').update(value).digest('hex'),
  };
}
