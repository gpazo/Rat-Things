import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type {
  ArtifactStore,
  CreateRunResult,
  RunQueue,
  RunStore,
  ThingScheduler,
  ThingSchedulerTarget,
  ThingStore,
} from '../../src/core/ports.js';
import { RunService } from '../../src/core/run-service.js';
import { ThingService } from '../../src/core/thing-service.js';
import type {
  ArtifactReference,
  ListRunsResult,
  RunError,
  RunRecord,
  RunResult,
  RunStatus,
} from '../../src/domain/contracts.js';
import type {
  ListThingsResult,
  ThingRecord,
  ThingRevision,
  ThingStatus,
  ThingTriggerState,
  ThingVersionRecord,
} from '../../src/domain/things.js';

describe('simulated Thing-to-run workflow', () => {
  it('preserves draft/production isolation, schedule idempotency, and stale-delivery fencing', async () => {
    const clock = { now: () => new Date('2026-08-21T15:00:00.000Z') };
    const artifacts = new MemoryArtifacts();
    const runs = new MemoryRuns();
    const queue = new MemoryQueue();
    const scheduler = new MemoryScheduler();
    const runService = new RunService({
      store: runs,
      artifacts,
      queue,
      executions: { stop: async () => undefined },
      allowedSandboxModes: ['read-only', 'workspace-write', 'danger-full-access'],
      clock,
      ids: {
        random: () => 'random-run',
        deterministic: (_ownerId, key) => `run-${createHash('sha256').update(key).digest('hex').slice(0, 16)}`,
      },
    });
    const things = new MemoryThings();
    const service = new ThingService({
      store: things,
      scheduler,
      artifacts,
      runs: runService,
      allowedSandboxModes: ['read-only', 'workspace-write', 'danger-full-access'],
      clock,
      randomId: () => 'thing-customer-ops',
    });

    await service.create('api:shop-owner', scheduledSpec(
      'Review Slack escalations and Stripe refund exceptions.',
      'rate(15 minutes)',
    ));
    const testV1 = await service.test('api:shop-owner', 'thing-customer-ops', 'draft-v1-test');
    runs.succeed(testV1.runId);
    const draftV1 = await service.get('api:shop-owner', 'thing-customer-ops');
    await service.publish('api:shop-owner', 'thing-customer-ops', {
      version: '1',
      expectedDraftRevision: 1,
      expectedSpecHash: draftV1.draft.specHash,
      testRunId: testV1.runId,
    });
    await service.addVersion('api:shop-owner', 'thing-customer-ops', {
      version: '1',
      expectedDraftRevision: 1,
      spec: scheduledSpec('Candidate goal that is not live yet.', 'cron(0 8 ? * MON-FRI *)'),
    });

    await service.runScheduled({
      version: '1',
      thingId: 'thing-customer-ops',
      revision: 1,
      scheduledAt: '2026-08-21T15:15:00.000Z',
    });
    const testV2 = await service.test('api:shop-owner', 'thing-customer-ops', 'draft-v2-test');
    runs.succeed(testV2.runId);
    const draftV2 = await service.get('api:shop-owner', 'thing-customer-ops');
    await service.publish('api:shop-owner', 'thing-customer-ops', {
      version: '1',
      expectedDraftRevision: 2,
      expectedSpecHash: draftV2.draft.specHash,
      testRunId: testV2.runId,
    });
    await expect(service.runScheduled({
      version: '1',
      thingId: 'thing-customer-ops',
      revision: 1,
      scheduledAt: '2026-08-21T15:30:00.000Z',
    })).resolves.toEqual({ accepted: false, reason: 'stale-revision' });

    const currentInvocation = {
      version: '1' as const,
      thingId: 'thing-customer-ops',
      revision: 2,
      scheduledAt: '2026-08-21T15:31:00.000Z',
    };
    const duplicates = await Promise.all([
      service.runScheduled(currentInvocation),
      service.runScheduled(currentInvocation),
    ]);
    expect(duplicates.every((result) => result.accepted)).toBe(true);

    expect(runs.records).toHaveLength(4);
    expect(queue.messages).toHaveLength(4);
    expect(new Set(queue.messages.map((message) => message.runId)).size).toBe(4);
    const scheduledRuns = await Promise.all(runs.records
      .map(async (record) => artifacts.getJson<Record<string, unknown>>(record.input)));
    expect(scheduledRuns).toEqual(expect.arrayContaining([
      expect.objectContaining({
        prompt: 'Review Slack escalations and Stripe refund exceptions.',
        metadata: expect.objectContaining({ thingRevision: 1, thingInvocation: 'schedule' }),
      }),
      expect.objectContaining({
        prompt: 'Candidate goal that is not live yet.',
        metadata: expect.objectContaining({ thingRevision: 2, thingInvocation: 'schedule' }),
      }),
    ]));

    await service.pause('api:shop-owner', 'thing-customer-ops');
    await expect(service.runScheduled({
      ...currentInvocation,
      scheduledAt: '2026-08-21T15:32:00.000Z',
    })).resolves.toEqual({ accepted: false, reason: 'not-active' });
    expect(scheduler.operations).toEqual([
      expect.objectContaining({ kind: 'upsert', enabled: true, target: expect.objectContaining({ revision: 1 }) }),
      expect.objectContaining({ kind: 'upsert', enabled: true, target: expect.objectContaining({ revision: 2 }) }),
      expect.objectContaining({ kind: 'upsert', enabled: false, target: expect.objectContaining({ revision: 2 }) }),
    ]);
    await expect(service.getPublic('api:shop-owner', 'thing-customer-ops')).resolves.toMatchObject({
      status: 'paused',
      draft: { revision: 2 },
      active: { revision: 2 },
      hasUnpublishedChanges: false,
      lastRunAt: '2026-08-21T15:31:00.000Z',
    });
  });
});

class MemoryArtifacts implements ArtifactStore {
  public readonly values = new Map<string, unknown>();

  public async putJson(key: string, value: unknown): Promise<ArtifactReference> {
    this.values.set(key, structuredClone(value));
    return {
      bucket: key.includes('/things/') ? 'definitions' : 'artifacts',
      key,
      sha256: createHash('sha256').update(JSON.stringify(value)).digest('hex'),
    };
  }

  public async getJson<T>(reference: Pick<ArtifactReference, 'key'>): Promise<T> {
    const value = this.values.get(reference.key);
    if (value === undefined) throw new Error('artifact not found');
    return structuredClone(value) as T;
  }

  public async putBytes(): Promise<ArtifactReference> { throw new Error('not implemented'); }
  public async getBytes(): Promise<Uint8Array> { throw new Error('not implemented'); }
  public async putStream(): Promise<ArtifactReference> { throw new Error('not implemented'); }
  public async getStream(): Promise<AsyncIterable<Uint8Array>> { throw new Error('not implemented'); }
  public async copy(): Promise<ArtifactReference> { throw new Error('not implemented'); }
}

class MemoryQueue implements RunQueue {
  public readonly messages: Array<{ version: '1'; runId: string; traceId: string }> = [];

  public async enqueue(message: { version: '1'; runId: string; traceId: string }): Promise<void> {
    this.messages.push(structuredClone(message));
  }
}

class MemoryRuns implements RunStore {
  public readonly records: RunRecord[] = [];

  public async create(record: RunRecord): Promise<CreateRunResult> {
    const existing = this.records.find((candidate) => candidate.runId === record.runId);
    if (existing) return { created: false, record: structuredClone(existing) };
    this.records.push(structuredClone(record));
    return { created: true, record: structuredClone(record) };
  }

  public async get(runId: string): Promise<RunRecord | undefined> {
    const record = this.records.find((candidate) => candidate.runId === runId);
    return record ? structuredClone(record) : undefined;
  }

  public succeed(runId: string): void {
    const record = this.records.find((candidate) => candidate.runId === runId);
    if (!record) throw new Error('run not found');
    record.status = 'succeeded';
  }

  public async list(): Promise<ListRunsResult> { return { items: structuredClone(this.records) }; }
  public async transition(): Promise<RunRecord> { throw new Error('not implemented'); }
  public async prepareConversation(): Promise<RunRecord> { throw new Error('not implemented'); }
  public async attachExecution(): Promise<RunRecord> { throw new Error('not implemented'); }
  public async complete(_runId: string, _result: RunResult): Promise<RunRecord> {
    throw new Error('not implemented');
  }
  public async fail(
    _runId: string,
    _error: RunError,
    _from?: RunStatus[],
  ): Promise<RunRecord> { throw new Error('not implemented'); }
}

class MemoryScheduler implements ThingScheduler {
  public readonly operations: Array<
    { kind: 'upsert'; target: ThingSchedulerTarget; enabled: boolean } | { kind: 'remove'; thingId: string }
  > = [];

  public async upsert(target: ThingSchedulerTarget, enabled: boolean): Promise<void> {
    this.operations.push({ kind: 'upsert', target: structuredClone(target), enabled });
  }

  public async remove(thingId: string): Promise<void> {
    this.operations.push({ kind: 'remove', thingId });
  }
}

class MemoryThings implements ThingStore {
  private readonly records = new Map<string, ThingRecord>();
  private readonly versions = new Map<string, Map<number, ThingVersionRecord>>();

  public async create(record: ThingRecord, version: ThingVersionRecord): Promise<void> {
    this.records.set(record.thingId, structuredClone(record));
    this.versions.set(record.thingId, new Map([[version.revision, structuredClone(version)]]));
  }

  public async get(thingId: string): Promise<ThingRecord | undefined> {
    const value = this.records.get(thingId);
    return value ? structuredClone(value) : undefined;
  }

  public async getVersion(thingId: string, revision: number): Promise<ThingVersionRecord | undefined> {
    const value = this.versions.get(thingId)?.get(revision);
    return value ? structuredClone(value) : undefined;
  }

  public async listVersions(thingId: string): Promise<ThingVersionRecord[]> {
    return [...(this.versions.get(thingId)?.values() ?? [])].map((value) => structuredClone(value));
  }

  public async list(ownerId: string): Promise<ListThingsResult> {
    return { items: [...this.records.values()].filter((record) => record.ownerId === ownerId) };
  }

  public async addVersion(
    ownerId: string,
    thingId: string,
    draft: ThingRevision,
    version: ThingVersionRecord,
    expectedDraftRevision: number,
    updatedAt: string,
  ): Promise<ThingRecord> {
    const current = this.records.get(thingId);
    if (
      !current ||
      current.ownerId !== ownerId ||
      current.draft.revision !== expectedDraftRevision ||
      current.status === 'archived'
    ) throw new Error('Thing changed concurrently');
    const updated = { ...current, draft: structuredClone(draft), updatedAt };
    this.records.set(thingId, updated);
    this.versions.get(thingId)?.set(version.revision, structuredClone(version));
    return structuredClone(updated);
  }

  public async publish(
    ownerId: string,
    thingId: string,
    draft: ThingRevision,
    expectedStatus: ThingStatus,
    triggerState: ThingTriggerState,
    updatedAt: string,
  ): Promise<ThingRecord> {
    const current = this.records.get(thingId);
    if (!current || current.ownerId !== ownerId || current.status !== expectedStatus) {
      throw new Error('Thing changed concurrently');
    }
    const updated: ThingRecord = {
      ...current,
      status: 'active',
      active: structuredClone(draft),
      triggerState: structuredClone(triggerState),
      updatedAt,
    };
    this.records.set(thingId, updated);
    return structuredClone(updated);
  }

  public async setStatus(
    ownerId: string,
    thingId: string,
    from: ThingStatus[],
    status: ThingStatus,
    triggerState: ThingTriggerState,
    updatedAt: string,
  ): Promise<ThingRecord> {
    const current = this.records.get(thingId);
    if (!current || current.ownerId !== ownerId || !from.includes(current.status)) {
      throw new Error('Thing changed concurrently');
    }
    const updated = { ...current, status, triggerState: structuredClone(triggerState), updatedAt };
    this.records.set(thingId, updated);
    return structuredClone(updated);
  }

  public async setTriggerState(
    thingId: string,
    expectedRevision: number | undefined,
    state: ThingTriggerState,
    updatedAt: string,
  ): Promise<ThingRecord> {
    const current = this.records.get(thingId);
    if (!current || current.active?.revision !== expectedRevision) throw new Error('Thing changed concurrently');
    const updated = { ...current, triggerState: structuredClone(state), updatedAt };
    this.records.set(thingId, updated);
    return structuredClone(updated);
  }

  public async recordRun(
    thingId: string,
    expectedActiveRevision: number,
    allowedStatuses: ThingStatus[],
    runAt: string,
    runId: string,
    updatedAt: string,
  ): Promise<boolean> {
    const current = this.records.get(thingId);
    if (
      !current ||
      current.active?.revision !== expectedActiveRevision ||
      !allowedStatuses.includes(current.status)
    ) return false;
    this.records.set(thingId, { ...current, lastRunAt: runAt, lastRunId: runId, updatedAt });
    return true;
  }
}

function scheduledSpec(goal: string, expression: string): Record<string, unknown> {
  return {
    version: '1',
    name: 'Customer operations check',
    goal,
    trigger: { kind: 'schedule', expression },
    agent: {
      driver: 'codex',
      sandbox: 'danger-full-access',
      capabilities: {
        profile: 'small-business',
        approvalPolicy: 'on-request',
        networkAccess: true,
        computerUse: 'browser',
      },
    },
    connections: {
      set: 'shop-operations',
      accounts: [
        { account: 'slack-support', access: 'read-only' },
        { account: 'stripe-live', access: 'read-write' },
      ],
    },
    deliver: [{ kind: 'slack', route: 'customer-operations' }],
  };
}
