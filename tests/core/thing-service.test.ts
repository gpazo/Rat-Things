import { describe, expect, it, vi } from 'vitest';
import type { ArtifactStore, ThingStore } from '../../src/core/ports.js';
import { ThingService } from '../../src/core/thing-service.js';
import type { RunService } from '../../src/core/run-service.js';
import type { ArtifactReference, RunRecord } from '../../src/domain/contracts.js';
import type {
  ListThingsResult,
  ThingRecord,
  ThingStatus,
  ThingVersionRecord,
} from '../../src/domain/things.js';

describe('ThingService', () => {
  it('stores a goal as an immutable artifact and compiles simple multi-account UX', async () => {
    const store = new MemoryThingStore();
    const payloads = new Map<string, unknown>();
    const service = new ThingService({
      store,
      artifacts: artifactStore(payloads),
      runs: { submit: vi.fn() } as unknown as Pick<RunService, 'submit'>,
      randomId: () => 'thing-customer-ops',
      clock: fixedClock('2026-08-21T10:00:00.000Z'),
    });

    const created = await service.create('api:owner-1', {
      version: '1',
      status: 'draft',
      spec: {
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
      },
    });

    expect(created).toMatchObject({
      thingId: 'thing-customer-ops',
      revision: 1,
      status: 'draft',
      trigger: { kind: 'manual' },
    });
    expect(JSON.stringify(created)).not.toContain('Review messages');
    expect(created.spec.key).toMatch(
      /^owners\/[a-f0-9]{32}\/things\/thing-customer-ops\/versions\/1-[a-f0-9]{64}\.json$/,
    );

    const explanation = await service.explain('api:owner-1', created.thingId);
    expect(explanation).toMatchObject({
      runnable: true,
      thing: {
        spec: { goal: 'Review messages and refund exceptions.' },
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
  });

  it('schedules an enabled interval with stable provenance and advances it after submission', async () => {
    let now = new Date('2026-08-21T11:00:00.000Z');
    const store = new MemoryThingStore();
    const submit = vi.fn(async () => run('run-thing-1'));
    const service = new ThingService({
      store,
      artifacts: artifactStore(new Map()),
      runs: { submit } as Pick<RunService, 'submit'>,
      randomId: () => 'thing-daily',
      clock: { now: () => now },
    });
    await service.create('owner-1', {
      version: '1',
      status: 'enabled',
      spec: {
        version: '1',
        name: 'Daily review',
        goal: 'Review open tasks.',
        trigger: { kind: 'interval', everyMinutes: 15 },
      },
    });

    expect(await service.get('owner-1', 'thing-daily')).toMatchObject({
      nextRunAt: '2026-08-21T11:15:00.000Z',
    });
    now = new Date('2026-08-21T11:15:00.000Z');
    await expect(service.tick()).resolves.toEqual({
      examined: 1,
      scheduled: 1,
      runs: [{ runId: 'run-thing-1', status: 'queued' }],
    });
    expect(submit).toHaveBeenCalledWith(
      'owner-1',
      expect.objectContaining({
        prompt: 'Review open tasks.',
        source: {
          kind: 'api',
          requestId: 'thing:thing-daily:1:2026-08-21T11:15:00.000Z',
        },
        metadata: {
          thingId: 'thing-daily',
          thingName: 'Daily review',
          thingRevision: 1,
          scheduledAt: '2026-08-21T11:15:00.000Z',
        },
      }),
      {
        idempotencyKey: 'thing:thing-daily:1:2026-08-21T11:15:00.000Z',
        capabilityOwnerId: 'owner-1',
        provenance: {
          actor: { kind: 'system', id: 'thing:thing-daily', provider: 'api' },
          credentialSubject: { kind: 'runtime', id: 'owner-1' },
        },
      },
    );
    expect(await service.get('owner-1', 'thing-daily')).toMatchObject({
      nextRunAt: '2026-08-21T11:30:00.000Z',
      lastRunAt: '2026-08-21T11:15:00.000Z',
      lastRunId: 'run-thing-1',
    });
  });

  it('creates immutable revisions with compare-and-swap protection', async () => {
    const store = new MemoryThingStore();
    const service = new ThingService({
      store,
      artifacts: artifactStore(new Map()),
      runs: { submit: vi.fn() } as unknown as Pick<RunService, 'submit'>,
      randomId: () => 'thing-versioned',
      clock: fixedClock('2026-08-21T12:00:00.000Z'),
    });
    await service.create('owner-1', createInput('Original goal'));
    await service.addVersion('owner-1', 'thing-versioned', {
      version: '1',
      expectedRevision: 1,
      spec: manualSpec('Updated goal'),
    });

    await expect(service.getVersion('owner-1', 'thing-versioned', 1)).resolves.toMatchObject({
      revision: 1,
      spec: { goal: 'Original goal' },
    });
    await expect(service.getVersion('owner-1', 'thing-versioned', 2)).resolves.toMatchObject({
      revision: 2,
      spec: { goal: 'Updated goal' },
    });
    await expect(service.addVersion('owner-1', 'thing-versioned', {
      version: '1',
      expectedRevision: 1,
      spec: manualSpec('Stale writer'),
    })).rejects.toThrow('expected 1, current 2');
    await expect(service.listVersions('owner-1', 'thing-versioned')).resolves.toHaveLength(2);
  });

  it('does not overwrite a concurrent lifecycle change while selecting a revision', async () => {
    const store = new MemoryThingStore();
    let injectPause = false;
    const service = new ThingService({
      store,
      artifacts: artifactStore(new Map(), async () => {
        if (!injectPause) return;
        injectPause = false;
        await store.setStatus(
          'owner-1',
          'thing-lifecycle-race',
          ['enabled'],
          'paused',
          undefined,
          '2026-08-21T12:01:00.000Z',
        );
      }),
      runs: { submit: vi.fn() } as unknown as Pick<RunService, 'submit'>,
      randomId: () => 'thing-lifecycle-race',
      clock: fixedClock('2026-08-21T12:00:00.000Z'),
    });
    await service.create('owner-1', {
      version: '1',
      status: 'enabled',
      spec: manualSpec('Original goal'),
    });

    injectPause = true;
    await expect(service.addVersion('owner-1', 'thing-lifecycle-race', {
      version: '1',
      expectedRevision: 1,
      spec: manualSpec('Racing goal'),
    })).rejects.toThrow('Thing changed concurrently');
    await expect(service.get('owner-1', 'thing-lifecycle-race')).resolves.toMatchObject({
      revision: 1,
      status: 'paused',
    });
  });

  it('allows explicit draft and paused test runs but makes archive terminal', async () => {
    const submit = vi.fn<RunService['submit']>(async () => run('manual-run'));
    const service = new ThingService({
      store: new MemoryThingStore(),
      artifacts: artifactStore(new Map()),
      runs: { submit } as Pick<RunService, 'submit'>,
      randomId: () => 'thing-lifecycle',
      clock: fixedClock('2026-08-21T13:00:00.000Z'),
    });
    await service.create('owner-1', createInput('Test lifecycle'));
    await service.runNow('owner-1', 'thing-lifecycle', 'stable-manual-key');
    await service.enable('owner-1', 'thing-lifecycle');
    await service.pause('owner-1', 'thing-lifecycle');
    await service.runNow('owner-1', 'thing-lifecycle', 'paused-test-key');
    await service.archive('owner-1', 'thing-lifecycle');

    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[0]?.[1]).toMatchObject({
      source: {
        kind: 'api',
        requestId: expect.stringMatching(/^thing:thing-lifecycle:1:manual:[a-f0-9]{32}$/),
      },
    });
    await expect(service.runNow('owner-1', 'thing-lifecycle')).rejects.toThrow(
      'archived Things cannot run',
    );
    await expect(service.enable('owner-1', 'thing-lifecycle')).rejects.toThrow(
      'archived Things cannot be enabled',
    );
  });

  it('rejects ineffective delivery context and a tampered stored spec', async () => {
    const payloads = new Map<string, unknown>();
    const store = new MemoryThingStore();
    const submit = vi.fn<RunService['submit']>();
    const service = new ThingService({
      store,
      artifacts: artifactStore(payloads),
      runs: { submit } as unknown as Pick<RunService, 'submit'>,
      randomId: () => 'thing-tamper',
    });
    await expect(service.create('owner-1', {
      version: '1',
      spec: { ...manualSpec('bad destination'), deliver: [{ kind: 'source' }] },
    })).rejects.toThrow('cannot use the source delivery destination');

    const created = await service.create('owner-1', createInput('Original trusted goal'));
    payloads.set(created.spec.key, manualSpec('Tampered broader goal'));
    await expect(service.runNow('owner-1', created.thingId, 'tamper-test')).rejects.toThrow(
      'does not match its stored digest',
    );
    expect(submit).not.toHaveBeenCalled();
  });

  it('keeps portable Thing specs free of caller-selected credential secrets', async () => {
    const service = new ThingService({
      store: new MemoryThingStore(),
      artifacts: artifactStore(new Map()),
      runs: { submit: vi.fn() } as unknown as Pick<RunService, 'submit'>,
      randomId: () => 'thing-portable',
    });

    await expect(service.create('owner-1', {
      version: '1',
      spec: {
        ...manualSpec('Clone a repository'),
        repository: {
          provider: 'github',
          url: 'https://github.com/example/private.git',
          credentialSecretArn:
            'arn:aws:secretsmanager:us-west-2:123456789012:secret:caller-selected',
        },
      },
    })).rejects.toThrow(
      'Thing spec repository cannot select a credential secret; use a deployment-owned connection',
    );
  });
});

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
    _limit: number,
    _nextToken?: string,
    includeArchived = false,
  ): Promise<ListThingsResult> {
    return {
      items: [...this.records.values()]
        .filter((record) => record.ownerId === ownerId && (includeArchived || record.status !== 'archived'))
        .map((record) => structuredClone(record)),
    };
  }

  public async listDue(cutoff: string, limit: number): Promise<ThingRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.status === 'enabled' && Boolean(record.nextRunAt && record.nextRunAt <= cutoff))
      .slice(0, limit)
      .map((record) => structuredClone(record));
  }

  public async addVersion(
    record: ThingRecord,
    version: ThingVersionRecord,
    expectedRevision: number,
  ): Promise<ThingRecord> {
    const current = this.records.get(record.thingId);
    if (
      !current ||
      current.revision !== expectedRevision ||
      current.status !== record.status
    ) {
      throw new Error('Thing changed concurrently');
    }
    this.records.set(record.thingId, structuredClone(record));
    this.versions.get(record.thingId)?.set(version.revision, structuredClone(version));
    return structuredClone(record);
  }

  public async setStatus(
    ownerId: string,
    thingId: string,
    from: ThingStatus[],
    status: ThingStatus,
    nextRunAt: string | undefined,
    updatedAt: string,
  ): Promise<ThingRecord> {
    const current = this.records.get(thingId);
    if (!current || current.ownerId !== ownerId || !from.includes(current.status)) {
      throw new Error('Thing changed concurrently');
    }
    const { nextRunAt: _nextRunAt, ...withoutSchedule } = current;
    const updated: ThingRecord = {
      ...withoutSchedule,
      status,
      updatedAt,
      ...(nextRunAt ? { nextRunAt } : {}),
    };
    this.records.set(thingId, updated);
    return structuredClone(updated);
  }

  public async advance(
    thingId: string,
    expectedRevision: number,
    expectedRunAt: string,
    nextRunAt: string,
    runId: string,
    updatedAt: string,
  ): Promise<boolean> {
    const current = this.records.get(thingId);
    if (
      !current ||
      current.status !== 'enabled' ||
      current.revision !== expectedRevision ||
      current.nextRunAt !== expectedRunAt
    ) return false;
    this.records.set(thingId, {
      ...current,
      nextRunAt,
      lastRunAt: expectedRunAt,
      lastRunId: runId,
      updatedAt,
    });
    return true;
  }
}

function artifactStore(
  payloads: Map<string, unknown>,
  onPut?: () => Promise<void>,
): ArtifactStore {
  return {
    putJson: vi.fn(async (key: string, value: unknown): Promise<ArtifactReference> => {
      payloads.set(key, structuredClone(value));
      await onPut?.();
      return { bucket: 'artifacts', key, sha256: 'a'.repeat(64) };
    }),
    getJson: vi.fn(async <T>(reference: Pick<ArtifactReference, 'key'>): Promise<T> => {
      const value = payloads.get(reference.key);
      if (value === undefined) throw new Error('artifact not found');
      return structuredClone(value) as T;
    }),
  } as unknown as ArtifactStore;
}

function createInput(goal: string): unknown {
  return { version: '1', spec: manualSpec(goal) };
}

function manualSpec(goal: string): Record<string, unknown> {
  return {
    version: '1',
    name: 'Example Thing',
    goal,
    trigger: { kind: 'manual' },
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
