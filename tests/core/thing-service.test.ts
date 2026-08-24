import { describe, expect, it, vi } from 'vitest';
import type { ArtifactStore, ThingScheduler, ThingSchedulerTarget, ThingStore } from '../../src/core/ports.js';
import { ThingService } from '../../src/core/thing-service.js';
import type { RunService } from '../../src/core/run-service.js';
import type { ArtifactReference, RunRecord } from '../../src/domain/contracts.js';
import type {
  ListThingsResult,
  ThingRecord,
  ThingRevision,
  ThingStatus,
  ThingTriggerState,
  ThingVersionRecord,
} from '../../src/domain/things.js';

describe('ThingService', () => {
  it('creates only a draft, stores its goal as an immutable artifact, and explains multi-account UX', async () => {
    const store = new MemoryThingStore();
    const payloads = new Map<string, unknown>();
    const service = serviceWith({ store, payloads, randomId: 'thing-customer-ops' });

    const created = await service.create('api:owner-1', {
      version: '1',
      name: 'Customer operations',
      goal: 'Review messages and refund exceptions.',
      trigger: { kind: 'manual' },
      agent: {
        sandbox: 'danger-full-access',
        capabilities: {
          profile: 'small-business',
          networkAccess: true,
          computerUse: 'browser',
        },
      },
      connections: {
        set: 'front-office',
        accounts: [
          { account: 'slack-personal', access: 'read-only' },
          { account: 'stripe-business', access: 'read-write' },
        ],
      },
      deliver: [{ kind: 'slack', route: 'operations' }],
    });

    expect(created).toMatchObject({
      thingId: 'thing-customer-ops',
      status: 'draft',
      draft: { revision: 1, name: 'Customer operations', trigger: { kind: 'manual' } },
      triggerState: { status: 'inactive' },
    });
    expect(created).not.toHaveProperty('active');
    expect(JSON.stringify(created)).not.toContain('Review messages');
    expect(created.draft.spec.key).toMatch(
      /^owners\/[a-f0-9]{32}\/things\/thing-customer-ops\/versions\/1-[a-f0-9]{64}\.json$/,
    );

    const explanation = await service.explain('api:owner-1', created.thingId);
    expect(explanation).toMatchObject({
      target: 'draft',
      runnable: true,
      thing: {
        hasUnpublishedChanges: true,
        draft: { spec: { goal: 'Review messages and refund exceptions.' } },
      },
      compiledRun: {
        version: '1',
        prompt: 'Review messages and refund exceptions.',
        integrations: {
          connectionSet: 'front-office',
          connections: [
            { connection: 'slack-personal', preset: 'read-only' },
            { connection: 'stripe-business', preset: 'read-write' },
          ],
        },
      },
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ id: 'spec.valid', status: 'pass' }),
        expect.objectContaining({ id: 'lifecycle', status: 'warning' }),
      ]),
    });
    await expect(service.runNow('api:owner-1', created.thingId)).rejects.toThrow(
      'no published revision',
    );
  });

  it('keeps published production immutable while a newer draft is edited and tested', async () => {
    let submitCount = 0;
    const submit = vi.fn<RunService['submit']>(async (): Promise<RunRecord> => {
      submitCount += 1;
      return run(`run-${submitCount}`);
    });
    const scheduler = new MemoryScheduler();
    const service = serviceWith({
      store: new MemoryThingStore(),
      scheduler,
      submit,
      randomId: 'thing-versioned',
    });
    await service.create('owner-1', manualSpec('Original production goal'));
    const testV1 = await service.test('owner-1', 'thing-versioned', 'test-v1');
    await publishTested(service, 'owner-1', 'thing-versioned', testV1.runId);
    await service.addVersion('owner-1', 'thing-versioned', {
      version: '1',
      expectedDraftRevision: 1,
      spec: manualSpec('Candidate draft goal'),
    });

    const beforePublish = await service.getPublic('owner-1', 'thing-versioned');
    expect(beforePublish).toMatchObject({
      status: 'active',
      hasUnpublishedChanges: true,
      active: { revision: 1, spec: { goal: 'Original production goal' } },
      draft: { revision: 2, spec: { goal: 'Candidate draft goal' } },
    });

    const draftReceipt = await service.test('owner-1', 'thing-versioned', 'test-v2');
    const productionReceipt = await service.runNow('owner-1', 'thing-versioned', 'production-v1');
    expect(draftReceipt.thing).toEqual({
      version: '1',
      thingId: 'thing-versioned',
      revision: 2,
      specHash: beforePublish.draft.specHash,
      invocation: 'test',
    });
    expect(productionReceipt.thing).toEqual({
      version: '1',
      thingId: 'thing-versioned',
      revision: 1,
      specHash: beforePublish.active?.specHash,
      invocation: 'manual',
    });
    expect(submit.mock.calls.map((call) => (call[1] as { metadata?: unknown }).metadata)).toEqual([
      expect.objectContaining({ thingRevision: 1, thingInvocation: 'test' }),
      expect.objectContaining({ thingRevision: 2, thingInvocation: 'test' }),
      expect.objectContaining({ thingRevision: 1, thingInvocation: 'manual' }),
    ]);

    await publishTested(service, 'owner-1', 'thing-versioned', draftReceipt.runId);
    await expect(service.getPublic('owner-1', 'thing-versioned')).resolves.toMatchObject({
      status: 'active',
      hasUnpublishedChanges: false,
      active: { revision: 2, spec: { goal: 'Candidate draft goal' } },
      draft: { revision: 2 },
    });
    await expect(service.getVersion('owner-1', 'thing-versioned', 1)).resolves.toMatchObject({
      revision: 1,
      spec: { goal: 'Original production goal' },
    });
    expect(scheduler.removed).toEqual(['thing-versioned', 'thing-versioned']);
  });

  it('provisions rate and cron schedules and rejects stale, paused, and manual deliveries', async () => {
    const submit = vi.fn<RunService['submit']>(async () => run('scheduled-run'));
    const scheduler = new MemoryScheduler();
    const service = serviceWith({
      store: new MemoryThingStore(),
      scheduler,
      submit,
      randomId: 'thing-scheduled',
    });
    await service.create('owner-1', scheduleSpec('Scheduled v1', 'rate(15 minutes)'));
    const testV1 = await service.test('owner-1', 'thing-scheduled', 'schedule-v1-test');
    await publishTested(service, 'owner-1', 'thing-scheduled', testV1.runId);
    expect(scheduler.upserts).toEqual([{
      enabled: true,
      target: {
        thingId: 'thing-scheduled',
        revision: 1,
        trigger: { kind: 'schedule', expression: 'rate(15 minutes)' },
      },
    }]);

    await expect(service.runScheduled({
      version: '1',
      thingId: 'thing-scheduled',
      revision: 1,
      scheduledAt: '2026-08-21T11:15:00.000Z',
    })).resolves.toEqual({
      accepted: true,
      run: { runId: 'scheduled-run', status: 'queued' },
    });
    expect(submit).toHaveBeenCalledWith(
      'owner-1',
      expect.objectContaining({
        source: {
          kind: 'api',
          requestId: 'thing:thing-scheduled:1:2026-08-21T11:15:00.000Z',
        },
        metadata: expect.objectContaining({
          thingRevision: 1,
          thingInvocation: 'schedule',
          scheduledAt: '2026-08-21T11:15:00.000Z',
        }),
      }),
      expect.objectContaining({
        idempotencyKey: 'thing:thing-scheduled:1:2026-08-21T11:15:00.000Z',
      }),
    );

    await service.addVersion('owner-1', 'thing-scheduled', {
      version: '1',
      expectedDraftRevision: 1,
      spec: scheduleSpec('Scheduled v2', 'cron(0 8 ? * MON-FRI *)', 'America/Los_Angeles'),
    });
    const testV2 = await service.test('owner-1', 'thing-scheduled', 'schedule-v2-test');
    await publishTested(service, 'owner-1', 'thing-scheduled', testV2.runId);
    await expect(service.runScheduled({
      version: '1',
      thingId: 'thing-scheduled',
      revision: 1,
      scheduledAt: '2026-08-21T11:30:00.000Z',
    })).resolves.toEqual({ accepted: false, reason: 'stale-revision' });

    await service.pause('owner-1', 'thing-scheduled');
    await expect(service.runScheduled({
      version: '1',
      thingId: 'thing-scheduled',
      revision: 2,
      scheduledAt: '2026-08-21T11:31:00.000Z',
    })).resolves.toEqual({ accepted: false, reason: 'not-active' });
    await service.resume('owner-1', 'thing-scheduled');
    await service.archive('owner-1', 'thing-scheduled');
    expect(scheduler.upserts.map((item) => item.enabled)).toEqual([true, true, false, true]);
    expect(scheduler.removed).toEqual(['thing-scheduled']);
  });

  it('records trigger synchronization errors and heals them on an idempotent retry', async () => {
    const store = new MemoryThingStore();
    const scheduler = new MemoryScheduler();
    scheduler.failure = new Error('simulated Scheduler outage');
    const service = serviceWith({ store, scheduler, randomId: 'thing-retry' });
    await service.create('owner-1', scheduleSpec('Retry schedule', 'rate(1 hour)'));
    const testRun = await service.test('owner-1', 'thing-retry', 'retry-test');
    const publishInput = await testedPublishInput(service, 'owner-1', 'thing-retry', testRun.runId);

    await expect(service.publish('owner-1', 'thing-retry', publishInput))
      .rejects.toThrow('simulated Scheduler outage');
    await expect(service.getPublic('owner-1', 'thing-retry')).resolves.toMatchObject({
      status: 'active',
      active: { revision: 1 },
      triggerState: { status: 'error', revision: 1, error: 'simulated Scheduler outage' },
    });

    scheduler.failure = undefined;
    await expect(service.publish('owner-1', 'thing-retry', publishInput))
      .resolves.toMatchObject({ triggerState: { status: 'ready', revision: 1 } });
  });

  it('rejects invalid schedule expressions and time zones before persistence', async () => {
    const service = serviceWith({ store: new MemoryThingStore(), randomId: 'thing-invalid' });
    await expect(service.create('owner-1', scheduleSpec('Too fast', 'rate(0 minutes)')))
      .rejects.toThrow('rate value');
    await expect(service.create('owner-1', scheduleSpec('Bad cron', 'cron(0 8 * * * *)')))
      .rejects.toThrow('exactly one day field');
    await expect(service.create('owner-1', scheduleSpec('Bad zone', 'cron(0 8 ? * MON *)', 'Mars/Olympus')))
      .rejects.toThrow('IANA time-zone');
  });

  it('uses compare-and-swap for drafts without overwriting a concurrent lifecycle change', async () => {
    const store = new MemoryThingStore();
    let injectArchive = false;
    const payloads = new Map<string, unknown>();
    const service = new ThingService({
      store,
      scheduler: new MemoryScheduler(),
      artifacts: artifactStore(payloads, async () => {
        if (!injectArchive) return;
        injectArchive = false;
        await store.setStatus(
          'owner-1',
          'thing-race',
          ['draft'],
          'archived',
          { status: 'syncing', updatedAt: '2026-08-21T12:01:00.000Z' },
          '2026-08-21T12:01:00.000Z',
        );
      }),
      runs: { submit: vi.fn(), get: vi.fn() } as unknown as Pick<RunService, 'submit' | 'get'>,
      randomId: () => 'thing-race',
      clock: fixedClock('2026-08-21T12:00:00.000Z'),
    });
    await service.create('owner-1', manualSpec('Original goal'));
    injectArchive = true;
    await expect(service.addVersion('owner-1', 'thing-race', {
      version: '1',
      expectedDraftRevision: 1,
      spec: manualSpec('Racing goal'),
    })).rejects.toThrow('Thing changed concurrently');
    await expect(service.get('owner-1', 'thing-race')).resolves.toMatchObject({
      status: 'archived',
      draft: { revision: 1 },
    });
  });

  it('rejects ineffective delivery context, caller-selected secrets, and a tampered draft', async () => {
    const payloads = new Map<string, unknown>();
    const submit = vi.fn<RunService['submit']>();
    const service = serviceWith({
      store: new MemoryThingStore(),
      payloads,
      submit,
      randomId: 'thing-tamper',
    });
    await expect(service.create('owner-1', {
      ...manualSpec('bad destination'),
      deliver: [{ kind: 'source' }],
    })).rejects.toThrow('cannot use the source delivery destination');
    await expect(service.create('owner-1', {
      ...manualSpec('Clone a repository'),
      repository: {
        provider: 'github',
        url: 'https://github.com/example/private.git',
        credentialSecretArn: 'arn:aws:secretsmanager:us-west-2:123456789012:secret:caller',
      },
    })).rejects.toThrow('use a deployment-owned connection');

    const created = await service.create('owner-1', manualSpec('Original trusted goal'));
    payloads.set(created.draft.spec.key, manualSpec('Tampered broader goal'));
    await expect(service.test('owner-1', created.thingId, 'tamper-test')).rejects.toThrow(
      'does not match its stored digest',
    );
    expect(submit).not.toHaveBeenCalled();
  });
});

class MemoryScheduler implements ThingScheduler {
  public readonly upserts: Array<{ target: ThingSchedulerTarget; enabled: boolean }> = [];
  public readonly removed: string[] = [];
  public failure: Error | undefined;

  public async upsert(target: ThingSchedulerTarget, enabled: boolean): Promise<void> {
    if (this.failure) throw this.failure;
    this.upserts.push({ target: structuredClone(target), enabled });
  }

  public async remove(thingId: string): Promise<void> {
    if (this.failure) throw this.failure;
    this.removed.push(thingId);
  }
}

class MemoryThingStore implements ThingStore {
  private readonly records = new Map<string, ThingRecord>();
  private readonly versions = new Map<string, Map<number, ThingVersionRecord>>();

  public async create(record: ThingRecord, version: ThingVersionRecord): Promise<void> {
    if (this.records.has(record.thingId)) throw new Error('duplicate Thing');
    this.records.set(record.thingId, structuredClone(record));
    this.versions.set(record.thingId, new Map([[version.revision, structuredClone(version)]]));
  }

  public async get(thingId: string): Promise<ThingRecord | undefined> {
    const record = this.records.get(thingId);
    return record ? structuredClone(record) : undefined;
  }

  public async getVersion(thingId: string, revision: number): Promise<ThingVersionRecord | undefined> {
    const record = this.versions.get(thingId)?.get(revision);
    return record ? structuredClone(record) : undefined;
  }

  public async listVersions(thingId: string): Promise<ThingVersionRecord[]> {
    return [...(this.versions.get(thingId)?.values() ?? [])].map((value) => structuredClone(value));
  }

  public async list(
    ownerId: string,
    limit: number,
    _nextToken?: string,
    includeArchived = false,
  ): Promise<ListThingsResult> {
    return {
      items: [...this.records.values()]
        .filter((record) => record.ownerId === ownerId && (includeArchived || record.status !== 'archived'))
        .slice(0, limit)
        .map((record) => structuredClone(record)),
    };
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
    if (
      !current ||
      current.ownerId !== ownerId ||
      current.status !== expectedStatus ||
      current.draft.revision !== draft.revision
    ) throw new Error('Thing changed concurrently');
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
    if (!current || current.active?.revision !== expectedRevision) {
      throw new Error('Thing changed concurrently');
    }
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

function serviceWith(options: {
  store: ThingStore;
  scheduler?: ThingScheduler;
  payloads?: Map<string, unknown>;
  submit?: RunService['submit'];
  randomId: string;
}): ThingService {
  const accepted = new Map<string, RunRecord>();
  const submit = options.submit ?? vi.fn(async () => run('run-default'));
  return new ThingService({
    store: options.store,
    scheduler: options.scheduler ?? new MemoryScheduler(),
    artifacts: artifactStore(options.payloads ?? new Map()),
    runs: {
      submit: async (...args) => {
        const record = await submit(...args);
        const evidence = args[2]?.thing;
        const acceptedRecord = { ...record, ...(evidence ? { thing: evidence } : {}) };
        accepted.set(record.runId, { ...acceptedRecord, status: 'succeeded' });
        return acceptedRecord;
      },
      get: async (_ownerId, runId) => {
        const record = accepted.get(runId);
        if (!record) throw new Error('run not found');
        return structuredClone(record);
      },
    },
    randomId: () => options.randomId,
    clock: fixedClock('2026-08-21T10:00:00.000Z'),
  });
}

async function testedPublishInput(
  service: ThingService,
  ownerId: string,
  thingId: string,
  testRunId: string,
): Promise<{ version: '1'; expectedDraftRevision: number; expectedSpecHash: string; testRunId: string }> {
  const thing = await service.get(ownerId, thingId);
  return {
    version: '1',
    expectedDraftRevision: thing.draft.revision,
    expectedSpecHash: thing.draft.specHash,
    testRunId,
  };
}

async function publishTested(
  service: ThingService,
  ownerId: string,
  thingId: string,
  testRunId: string,
): Promise<ThingRecord> {
  return service.publish(
    ownerId,
    thingId,
    await testedPublishInput(service, ownerId, thingId, testRunId),
  );
}

function artifactStore(
  payloads: Map<string, unknown>,
  onPut?: () => Promise<void>,
): ArtifactStore {
  return {
    putJson: vi.fn(async (key: string, value: unknown): Promise<ArtifactReference> => {
      payloads.set(key, structuredClone(value));
      await onPut?.();
      return { bucket: 'definitions', key, sha256: 'a'.repeat(64) };
    }),
    getJson: vi.fn(async <T>(reference: Pick<ArtifactReference, 'key'>): Promise<T> => {
      const value = payloads.get(reference.key);
      if (value === undefined) throw new Error('artifact not found');
      return structuredClone(value) as T;
    }),
  } as unknown as ArtifactStore;
}

function manualSpec(goal: string): Record<string, unknown> {
  return {
    version: '1',
    name: 'Example Thing',
    goal,
    trigger: { kind: 'manual' },
  };
}

function scheduleSpec(goal: string, expression: string, timezone?: string): Record<string, unknown> {
  return {
    version: '1',
    name: 'Scheduled Thing',
    goal,
    trigger: { kind: 'schedule', expression, ...(timezone ? { timezone } : {}) },
  };
}

function fixedClock(value: string): { now(): Date } {
  return { now: () => new Date(value) };
}

function run(runId: string): RunRecord {
  return {
    runId,
    ownerId: 'owner-1',
    ownerCreated: `owner-1#2026-08-21T10:00:00.000Z#${runId}`,
    status: 'queued',
    createdAt: '2026-08-21T10:00:00.000Z',
    updatedAt: '2026-08-21T10:00:00.000Z',
    expiresAt: 1,
    requestHash: 'b'.repeat(64),
    input: { bucket: 'artifacts', key: 'input', sha256: 'c'.repeat(64) },
    sourceKind: 'api',
  };
}
