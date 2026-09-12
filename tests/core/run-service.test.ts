import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import type {
  ArtifactReference,
  ConversationRunBinding,
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

  public async prepareConversation(
    runId: string,
    executionInput: ArtifactReference,
    conversation: ConversationRunBinding,
  ): Promise<RunRecord> {
    const record = this.required(runId);
    record.executionInput = structuredClone(executionInput);
    record.conversation = structuredClone(conversation);
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

  public async getBytes(input: Pick<ArtifactReference, 'bucket' | 'key'>): Promise<Uint8Array> {
    const found = this.byteWrites.find(({ key }) => key === input.key);
    if (!found) throw new Error(`missing artifact ${input.bucket}/${input.key}`);
    return Uint8Array.from(found.value);
  }

  public async putBytes(
    key: string,
    value: Uint8Array,
    contentType: string,
  ): Promise<ArtifactReference> {
    this.byteWrites.push({ key, value: Uint8Array.from(value), contentType });
    return reference(key, value);
  }

  public async putStream(
    key: string,
    value: AsyncIterable<Uint8Array>,
    contentType: string,
  ): Promise<ArtifactReference> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of value) chunks.push(Uint8Array.from(chunk));
    return this.putBytes(key, Buffer.concat(chunks), contentType);
  }

  public async getStream(
    input: Pick<ArtifactReference, 'bucket' | 'key'>,
  ): Promise<AsyncIterable<Uint8Array>> {
    const bytes = await this.getBytes(input);
    return (async function* () { yield bytes; })();
  }

  public async copy(
    source: ArtifactReference,
    key: string,
    contentType: string,
  ): Promise<ArtifactReference> {
    return this.putBytes(key, await this.getBytes(source), contentType);
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
const ids: IdGenerator = {
  random: () => 'random-run-id',
  deterministic: (ownerId, key) => `deterministic:${ownerId}:${key}`,
};

function harness() {
  const clock = { now: vi.fn(() => fixedNow) } satisfies Clock;
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
  return { service, store, artifacts, queue, executions, clock };
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
  it('looks up identity, stores input, reads time, commits the record, and then sends its wake-up', async () => {
    const { service, store, artifacts, queue, clock } = harness();
    const events: string[] = [];
    const get = store.get.bind(store);
    vi.spyOn(store, 'get').mockImplementation(async (id) => { events.push('lookup'); return get(id); });
    const put = artifacts.putJson.bind(artifacts);
    vi.spyOn(artifacts, 'putJson').mockImplementation(async (key, value) => { events.push('input'); return put(key, value); });
    clock.now.mockImplementation(() => { events.push('clock'); return fixedNow; });
    const create = store.create.bind(store);
    vi.spyOn(store, 'create').mockImplementation(async (record) => { events.push('record'); return create(record); });
    const enqueue = queue.enqueue.bind(queue);
    vi.spyOn(queue, 'enqueue').mockImplementation(async (message) => { events.push('wake'); return enqueue(message); });

    await service.submit('owner-1', baseRequest, { idempotencyKey: 'receipt-1' });
    expect(events).toEqual(['lookup', 'input', 'clock', 'record', 'wake']);
  });

  it('returns a competing creation without sending another wake-up', async () => {
    const { service, store, artifacts, queue } = harness();
    const first = await service.submit('owner-1', baseRequest, { idempotencyKey: 'receipt-1' });
    // The initial read misses a record that wins the subsequent conditional create.
    vi.spyOn(store, 'get').mockResolvedValueOnce(undefined);
    await expect(service.submit('owner-1', baseRequest, { idempotencyKey: 'receipt-1' })).resolves.toEqual(first);
    expect(artifacts.jsonWrites).toHaveLength(2);
    expect(store.createCalls).toBe(2);
    expect(queue.messages).toHaveLength(1);
  });

  it('checks request identity again after a competing creation wins', async () => {
    const { service, store, queue } = harness();
    await service.submit('owner-1', baseRequest, { idempotencyKey: 'receipt-1' });
    vi.spyOn(store, 'get').mockResolvedValueOnce(undefined);
    await expect(service.submit('owner-1', { ...baseRequest, prompt: 'Different' }, { idempotencyKey: 'receipt-1' }))
      .rejects.toThrow('the idempotency key was already used with a different request');
    expect(store.createCalls).toBe(2);
    expect(queue.messages).toHaveLength(1);
  });

  it.each([
    { status: 'queued', enqueue: false },
    { status: 'running', enqueue: true },
    { status: 'succeeded', enqueue: true },
  ] as const)('reuses $status runs with enqueue=$enqueue without new input, time, or wake-ups', async ({ status, enqueue }) => {
    const { service, store, artifacts, queue, clock } = harness();
    const first = await service.submit('owner-1', baseRequest, { idempotencyKey: 'receipt-1' });
    const existing = { ...first, status };
    store.records.set(first.runId, existing);
    clock.now.mockClear();
    await expect(service.submit('owner-1', baseRequest, {
      idempotencyKey: 'receipt-1', enqueue, capabilityOwnerId: ' ',
    })).resolves.toEqual(existing);
    expect(clock.now).not.toHaveBeenCalled();
    expect(artifacts.jsonWrites).toHaveLength(1);
    expect(queue.messages).toHaveLength(1);
  });

  it('validates trusted bindings after input storage and time, preserving the first boundary failure', async () => {
    const { service, store, artifacts, queue, clock } = harness();
    const failure = new Error('input unavailable');
    vi.spyOn(artifacts, 'putJson').mockRejectedValueOnce(failure);
    const options = { capabilityOwnerId: ' ', conversation: { conversationId: '' } };
    await expect(service.submit('owner-1', baseRequest, options)).rejects.toBe(failure);
    expect(clock.now).not.toHaveBeenCalled();
    await expect(service.submit('owner-1', baseRequest, options)).rejects.toThrow('capability owner identity is invalid');
    expect(clock.now).toHaveBeenCalledTimes(1);
    expect(artifacts.jsonWrites).toHaveLength(1);
    expect(store.createCalls).toBe(0);
    expect(queue.messages).toEqual([]);
  });

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

  it('keeps the public input immutable while attaching trusted thread execution input', async () => {
    const { service, artifacts, queue } = harness();
    const submitted = await service.submit('owner-1', baseRequest, {
      idempotencyKey: 'thread-message-1',
      enqueue: false,
      conversation: {
        conversationId: 'api:owner-1:release',
        messageId: 'message-1',
        delivery: 'defer',
      },
    });
    const originalInput = submitted.input;
    const prepared = await service.prepareConversation(
      'owner-1',
      submitted.runId,
      { ...baseRequest, prompt: 'Canonical transcript\n\nReview the runtime change.' },
      {
        conversationId: 'api:owner-1:release',
        messageId: 'message-1',
        turnId: 'turn-1',
        slice: 0,
        delivery: 'defer',
      },
    );

    expect(prepared.input).toEqual(originalInput);
    expect(prepared.executionInput).toBeDefined();
    expect(prepared.executionInput).not.toEqual(originalInput);
    expect(prepared.conversation).toMatchObject({
      messageId: 'message-1',
      turnId: 'turn-1',
      slice: 0,
    });
    expect(artifacts.jsonWrites).toHaveLength(2);
    expect(queue.messages).toEqual([]);

    await expect(service.submit('owner-1', baseRequest, {
      idempotencyKey: 'thread-message-1',
      enqueue: false,
      conversation: {
        conversationId: 'api:owner-1:release',
        messageId: 'message-1',
        delivery: 'defer',
      },
    })).resolves.toMatchObject({
      runId: submitted.runId,
      executionInput: prepared.executionInput,
    });
    await expect(service.submit('owner-1', baseRequest, {
      idempotencyKey: 'thread-message-1',
      enqueue: false,
      conversation: {
        conversationId: 'api:owner-1:another-thread',
        messageId: 'message-1',
        delivery: 'defer',
      },
    })).rejects.toThrow('different thread occurrence');
  });
});

describe('RunService conversation preparation effects', () => {
  const accepted = { conversationId: 'conversation-1', messageId: 'message-1', delivery: 'defer' } as const;
  const binding = { ...accepted, turnId: 'turn-1', slice: 0 };

  it('reuses prepared active work before parsing execution input or writing artifacts', async () => {
    const { service, store, artifacts } = harness();
    const submitted = await service.submit('owner-1', baseRequest, { enqueue: false, conversation: accepted });
    const prepared = await service.prepareConversation('owner-1', submitted.runId, baseRequest, binding);
    const running: RunRecord = { ...prepared, status: 'running' };
    store.records.set(submitted.runId, running);
    const put = vi.spyOn(artifacts, 'putJson');
    await expect(service.prepareConversation('owner-1', submitted.runId, null, binding)).resolves.toEqual(running);
    await expect(service.prepareConversation('owner-1', submitted.runId, null, { ...binding, slice: 1 }))
      .rejects.toThrow(`run ${submitted.runId} cannot be prepared from running`);
    expect(put).not.toHaveBeenCalled();
  });

  it('checks accepted binding and prepared binding validity before writing execution input', async () => {
    const { service, artifacts } = harness();
    const submitted = await service.submit('owner-1', baseRequest, { enqueue: false, conversation: accepted });
    const put = vi.spyOn(artifacts, 'putJson');
    await expect(service.prepareConversation('owner-1', submitted.runId, null, { ...binding, messageId: 'message-2' }))
      .rejects.toThrow('run thread binding changed before preparation');
    await expect(service.prepareConversation('owner-1', submitted.runId, null, { ...binding, slice: -1 }))
      .rejects.toThrow('conversation slice is invalid');
    expect(put).not.toHaveBeenCalled();
  });

  it('compares queued preparation retries after writing their execution input', async () => {
    const { service, store, artifacts, queue } = harness();
    const submitted = await service.submit('owner-1', baseRequest, { enqueue: false, conversation: accepted });
    const prepared = await service.prepareConversation('owner-1', submitted.runId, baseRequest, binding);
    const put = vi.spyOn(artifacts, 'putJson');
    const prepare = vi.spyOn(store, 'prepareConversation');
    await expect(service.prepareConversation('owner-1', submitted.runId, baseRequest, binding)).resolves.toEqual(prepared);
    await expect(service.prepareConversation('owner-1', submitted.runId, { ...baseRequest, prompt: 'Changed' }, binding))
      .rejects.toThrow('run was already prepared with different thread state');
    expect(put).toHaveBeenCalledTimes(2);
    expect(prepare).not.toHaveBeenCalled();
    expect((await store.get(submitted.runId))?.input).toEqual(submitted.input);
    expect(queue.messages).toEqual([]);
  });

  it('leaves accepted input intact when committing preparation fails', async () => {
    const { service, store, artifacts, queue } = harness();
    const submitted = await service.submit('owner-1', baseRequest, { enqueue: false, conversation: accepted });
    const failure = new Error('preparation unavailable');
    vi.spyOn(store, 'prepareConversation').mockRejectedValueOnce(failure);
    await expect(service.prepareConversation('owner-1', submitted.runId, baseRequest, binding)).rejects.toBe(failure);
    expect(artifacts.jsonWrites).toHaveLength(2);
    expect(await store.get(submitted.runId)).toEqual(submitted);
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
    await expect(service.cancel('owner-2', submitted.runId)).rejects.toBeInstanceOf(ForbiddenError);
    await service.cancel('owner-1', submitted.runId);

    const again = await service.cancel('owner-1', submitted.runId);
    expect(again.status).toBe('cancelled');
  });

  it('retains cancellation when stopping fails and retries without rewriting its timestamp', async () => {
    const { service, store, executions } = harness();
    const submitted = await service.submit('owner-1', baseRequest);
    const execution: ExecutionReference = { backend: 'microvm', id: 'microvm-1' };
    await store.transition(submitted.runId, ['queued'], 'dispatching', { execution });
    const stopError = new Error('execution control temporarily unavailable');
    const stop = vi.spyOn(executions, 'stop').mockRejectedValueOnce(stopError);

    await expect(service.cancel('owner-1', submitted.runId)).rejects.toBe(stopError);
    const cancelling = await store.get(submitted.runId);
    expect(cancelling).toMatchObject({
      status: 'cancelling', cancelRequestedAt: fixedNow.toISOString(),
    });
    const transition = vi.spyOn(store, 'transition');
    await expect(service.cancel('owner-1', submitted.runId)).resolves.toEqual(cancelling);
    expect(transition).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledTimes(2);
    expect(executions.stops).toEqual([{ execution, reason: 'cancelled by owner-1' }]);
  });

  it.each(['dispatching', 'running', 'cancelling'] as const)(
    'keeps a %s Run cancellable while its execution attachment is pending',
    async (status) => {
      const { service, store, executions } = harness();
      const submitted = await service.submit('owner-1', baseRequest);
      store.records.set(submitted.runId, {
        ...submitted, status, execution: { backend: 'microvm', id: 'pending' },
      });
      await expect(service.cancel('owner-1', submitted.runId)).resolves.toMatchObject({
        status: 'cancelling',
      });
      expect(executions.stops).toEqual([]);
    },
  );

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


describe('RunService saved Activity', () => {
  it('checks ownership before reading evidence and projects terminal events without raw payloads', async () => {
    const {service, store, artifacts} = harness();
    const run = await service.submit('owner-1', baseRequest);
    const bytes = Buffer.from([
      JSON.stringify({id: 1, result: {secret: 'private-response'}}),
      JSON.stringify({method: 'item/started', params: {item: {type: 'commandExecution', command: 'private-command'}}}),
      JSON.stringify({method: 'item/completed', params: {item: {type: 'commandExecution', command: 'private-command', status: 'completed', exitCode: 0}}}),
    ].join('\n'));
    const events = await artifacts.putBytes('events.jsonl', bytes, 'application/x-ndjson');
    store.records.set(run.runId, {...run, status: 'succeeded', result: {output: events, events, preview: '', exitCode: 0, durationMs: 1}});
    const read = vi.spyOn(artifacts, 'getStream');
    await expect(service.savedActivity('owner-2', run.runId)).rejects.toBeInstanceOf(ForbiddenError);
    expect(read).not.toHaveBeenCalled();
    const result = await service.savedActivity('owner-1', run.runId);
    expect(result).toMatchObject({source: 'durable', active: false, truncated: false});
    expect(result.events.map(event => event.status)).toEqual(['started', 'completed']);
    expect(JSON.stringify(result)).not.toContain('private-');
  });
  it('rejects active work and missing or corrupt evidence without claiming completion', async () => {
    const {service, store, artifacts} = harness();
    const run = await service.submit('owner-1', baseRequest);
    await expect(service.savedActivity('owner-1', run.runId)).rejects.toBeInstanceOf(ConflictError);
    const events = await artifacts.putBytes('events.jsonl', Buffer.from('{}'), 'application/x-ndjson');
    store.records.set(run.runId, {...run, status: 'failed', result: {output: events, events: {...events, sha256: '0'.repeat(64)}, preview: '', exitCode: 1, durationMs: 1}});
    await expect(service.savedActivity('owner-1', run.runId)).rejects.toThrow('checksum');
  });
});


it('bounds saved Activity, preserves split UTF-8 records, and marks incomplete evidence', async () => {
  const {service, store, artifacts} = harness();
  const run = await service.submit('owner-1', baseRequest);
  const lines = Array.from({length: 205}, () => JSON.stringify({method: 'item/agentMessage/delta', params: {delta: '🌍 private-text'}}));
  const bytes = Buffer.from([...lines, '{broken'].join('\n'));
  const events = await artifacts.putBytes('events.jsonl', bytes, 'application/x-ndjson');
  store.records.set(run.runId, {...run, status: 'succeeded', result: {output: events, events, preview: '', exitCode: 0, durationMs: 1}});
  vi.spyOn(artifacts, 'getStream').mockResolvedValue((async function* () {
    for (let offset = 0; offset < bytes.length; offset += 3) yield bytes.subarray(offset, offset + 3);
  })());
  const saved = await service.savedActivity('owner-1', run.runId);
  expect(saved).toMatchObject({truncated: true, oldestSequence: 6, nextSequence: 206});
  expect(saved.events).toHaveLength(200);
  expect(saved.events.at(-1)?.sequence).toBe(205);
  expect(JSON.stringify(saved)).not.toContain('private-text');
});
