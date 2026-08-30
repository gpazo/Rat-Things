import { describe, expect, it, vi } from 'vitest';
import type { ArtifactStore, RoutineStore } from '../../src/core/ports.js';
import { RoutineService } from '../../src/core/routine-service.js';
import type { RunService } from '../../src/core/run-service.js';
import type { ArtifactReference, RunRecord } from '../../src/domain/contracts.js';
import type { ListRoutinesResult, RoutineRecord } from '../../src/domain/routines.js';

describe('RoutineService', () => {
  it('stores prompts in artifacts and schedules an idempotent permission-scoped occurrence', async () => {
    let now = new Date('2026-08-20T10:00:00.000Z');
    const store = new MemoryRoutineStore();
    const payloads = new Map<string, unknown>();
    const artifacts = artifactStore(payloads);
    const submit = vi.fn(async () => run('run-1'));
    const service = new RoutineService({
      store,
      artifacts,
      runs: { submit } as Pick<RunService, 'submit'>,
      clock: { now: () => now },
      randomId: () => 'routine-1',
    });

    const routine = await service.create('owner-1', {
      version: '1',
      name: 'Morning operations review',
      schedule: { kind: 'interval', everyMinutes: 5 },
      request: {
        version: '1',
        prompt: 'Review new customer messages and refund exceptions.',
        agent: {
          capabilities: {
            profile: 'small-business',
            computerUse: 'browser',
            networkAccess: true,
          },
        },
        integrations: {
          connections: [
            { connection: 'slack-personal', preset: 'read-only' },
            { connection: 'stripe-business', preset: 'read-write' },
          ],
        },
        destinations: [{ kind: 'slack', route: 'C123' }],
      },
    });

    expect(routine).toMatchObject({
      routineId: 'routine-1',
      ownerId: 'owner-1',
      status: 'enabled',
      nextRunAt: '2026-08-20T10:05:00.000Z',
      request: expect.objectContaining({ key: expect.stringContaining('/routines/routine-1/request-') }),
    });
    expect(JSON.stringify(routine)).not.toContain('Review new customer');

    now = new Date('2026-08-20T10:05:00.000Z');
    await expect(service.tick()).resolves.toEqual({
      examined: 1,
      scheduled: 1,
      runs: [{ runId: 'run-1', status: 'queued' }],
    });
    expect(submit).toHaveBeenCalledWith(
      'owner-1',
      expect.objectContaining({
        prompt: 'Review new customer messages and refund exceptions.',
        source: {
          kind: 'api',
          requestId: 'routine:routine-1:2026-08-20T10:05:00.000Z',
        },
        metadata: {
          routineId: 'routine-1',
          routineName: 'Morning operations review',
          scheduledAt: '2026-08-20T10:05:00.000Z',
        },
        integrations: {
          connections: [
            { connection: 'slack-personal', preset: 'read-only' },
            { connection: 'stripe-business', preset: 'read-write' },
          ],
        },
      }),
      expect.objectContaining({
        idempotencyKey: 'routine:routine-1:2026-08-20T10:05:00.000Z',
        capabilityOwnerId: 'owner-1',
        provenance: {
          actor: { kind: 'system', id: 'routine:routine-1', provider: 'api' },
          credentialSubject: { kind: 'runtime', id: 'owner-1' },
        },
      }),
    );
    expect((await store.get('routine-1'))).toMatchObject({
      nextRunAt: '2026-08-20T10:10:00.000Z',
      lastRunAt: '2026-08-20T10:05:00.000Z',
      lastRunId: 'run-1',
    });
  });

  it('keeps a failed occurrence due so the same idempotency key is retried', async () => {
    const now = new Date('2026-08-20T10:05:00.000Z');
    const store = new MemoryRoutineStore();
    const payloads = new Map<string, unknown>();
    const artifacts = artifactStore(payloads);
    const submit = vi.fn()
      .mockRejectedValueOnce(new Error('queue unavailable'))
      .mockResolvedValueOnce(run('run-recovered'));
    const service = new RoutineService({
      store,
      artifacts,
      runs: { submit } as Pick<RunService, 'submit'>,
      clock: { now: () => now },
      randomId: () => 'routine-retry',
    });
    await service.create('owner-1', {
      version: '1',
      name: 'Retry me',
      enabled: true,
      schedule: { kind: 'interval', everyMinutes: 1, startAt: now.toISOString() },
      request: { version: '1', prompt: 'retry safely' },
    });

    await expect(service.tick()).rejects.toThrow('due routines failed');
    expect((await store.get('routine-retry'))?.nextRunAt).toBe(now.toISOString());
    await expect(service.tick()).resolves.toMatchObject({ scheduled: 1 });
    expect(submit.mock.calls[0]?.[2]).toMatchObject({
      idempotencyKey: 'routine:routine-retry:2026-08-20T10:05:00.000Z',
    });
    expect(submit.mock.calls[1]?.[2]).toEqual(submit.mock.calls[0]?.[2]);
  });

  it('keeps manual run requests stable when the same idempotency key is retried later', async () => {
    let now = new Date('2026-08-20T10:00:00.000Z');
    const store = new MemoryRoutineStore();
    const artifacts = artifactStore(new Map());
    const submit = vi.fn<RunService['submit']>(async () => run('manual-run'));
    const service = new RoutineService({
      store,
      artifacts,
      runs: { submit } as Pick<RunService, 'submit'>,
      clock: { now: () => now },
      randomId: () => 'routine-manual',
    });
    await service.create('owner-1', {
      version: '1',
      name: 'Manual retry',
      enabled: false,
      schedule: { kind: 'interval', everyMinutes: 15 },
      request: { version: '1', prompt: 'run manually' },
    });

    await service.runNow('owner-1', 'routine-manual', 'manual-retry-key');
    now = new Date('2026-08-20T10:05:00.000Z');
    await service.runNow('owner-1', 'routine-manual', 'manual-retry-key');

    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[1]).toEqual(submit.mock.calls[0]);
    expect(submit.mock.calls[0]?.[1]).toMatchObject({
      source: {
        kind: 'api',
        requestId: expect.stringMatching(/^routine:routine-manual:manual:[a-f0-9]{32}$/),
      },
      metadata: {
        routineId: 'routine-manual',
        routineName: 'Manual retry',
      },
    });
    expect(submit.mock.calls[0]?.[1]).not.toMatchObject({
      metadata: { scheduledAt: expect.anything() },
    });
    await expect(store.get('routine-manual')).resolves.toMatchObject({
      lastRunAt: '2026-08-20T10:05:00.000Z',
      lastRunId: 'manual-run',
      updatedAt: '2026-08-20T10:05:00.000Z',
    });
  });

  it('rejects forged sources and ineffective source destinations', async () => {
    const service = new RoutineService({
      store: new MemoryRoutineStore(),
      artifacts: artifactStore(new Map()),
      runs: { submit: vi.fn() } as unknown as Pick<RunService, 'submit'>,
      randomId: () => 'routine-1',
    });

    await expect(service.create('owner-1', {
      version: '1',
      name: 'forged',
      schedule: { kind: 'interval', everyMinutes: 5 },
      request: { version: '1', prompt: 'x', source: { kind: 'api' } },
    })).rejects.toThrow('cannot set source');
    await expect(service.create('owner-1', {
      version: '1',
      name: 'no destination',
      schedule: { kind: 'interval', everyMinutes: 5 },
      request: { version: '1', prompt: 'x', destinations: [{ kind: 'source' }] },
    })).rejects.toThrow('cannot use the source delivery destination');
  });

  it('resumes at an existing future occurrence and maps malformed page tokens to validation errors', async () => {
    let now = new Date('2026-08-20T10:00:00.000Z');
    const store = new MemoryRoutineStore();
    const service = new RoutineService({
      store,
      artifacts: artifactStore(new Map()),
      runs: { submit: vi.fn() } as unknown as Pick<RunService, 'submit'>,
      clock: { now: () => now },
      randomId: () => 'routine-resume',
    });
    await service.create('owner-1', {
      version: '1',
      name: 'Resume me',
      schedule: { kind: 'interval', everyMinutes: 15 },
      request: { version: '1', prompt: 'resume safely' },
    });
    await service.pause('owner-1', 'routine-resume');
    now = new Date('2026-08-20T10:05:00.000Z');
    await expect(service.resume('owner-1', 'routine-resume')).resolves.toMatchObject({
      nextRunAt: '2026-08-20T10:15:00.000Z',
    });

    store.list = async () => { throw new Error('invalid pagination token'); };
    await expect(service.list('owner-1', 25, 'malformed')).rejects.toThrow('nextToken is invalid');
  });
});

class MemoryRoutineStore implements RoutineStore {
  private readonly records = new Map<string, RoutineRecord>();

  public async create(record: RoutineRecord): Promise<void> {
    this.records.set(record.routineId, structuredClone(record));
  }

  public async get(routineId: string): Promise<RoutineRecord | undefined> {
    const record = this.records.get(routineId);
    return record ? structuredClone(record) : undefined;
  }

  public async list(ownerId: string): Promise<ListRoutinesResult> {
    return {
      items: [...this.records.values()].filter(
        (record) => record.ownerId === ownerId && record.status !== 'deleted',
      ),
    };
  }

  public async listDue(cutoff: string, limit: number): Promise<RoutineRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.status === 'enabled' && record.nextRunAt <= cutoff)
      .slice(0, limit)
      .map((record) => structuredClone(record));
  }

  public async setStatus(
    ownerId: string,
    routineId: string,
    status: 'enabled' | 'paused',
    nextRunAt: string,
    updatedAt: string,
  ): Promise<RoutineRecord> {
    const record = this.required(ownerId, routineId);
    const updated = { ...record, status, nextRunAt, updatedAt };
    this.records.set(routineId, updated);
    return structuredClone(updated);
  }

  public async softDelete(
    ownerId: string,
    routineId: string,
    updatedAt: string,
    expiresAt: number,
  ): Promise<RoutineRecord> {
    const record = this.required(ownerId, routineId);
    const updated: RoutineRecord = { ...record, status: 'deleted', updatedAt, expiresAt };
    this.records.set(routineId, updated);
    return structuredClone(updated);
  }

  public async recordLastRun(
    ownerId: string,
    routineId: string,
    runAt: string,
    runId: string,
    updatedAt: string,
  ): Promise<boolean> {
    const record = this.required(ownerId, routineId);
    if (record.status === 'deleted' || (record.lastRunAt && record.lastRunAt > runAt)) return false;
    this.records.set(routineId, { ...record, lastRunAt: runAt, lastRunId: runId, updatedAt });
    return true;
  }

  public async advance(
    routineId: string,
    expectedRunAt: string,
    nextRunAt: string,
    runId: string,
    updatedAt: string,
  ): Promise<boolean> {
    const record = this.records.get(routineId);
    if (!record || record.status !== 'enabled' || record.nextRunAt !== expectedRunAt) return false;
    this.records.set(routineId, {
      ...record,
      nextRunAt,
      lastRunAt: expectedRunAt,
      lastRunId: runId,
      updatedAt,
    });
    return true;
  }

  private required(ownerId: string, routineId: string): RoutineRecord {
    const record = this.records.get(routineId);
    if (!record || record.ownerId !== ownerId) throw new Error('not found');
    return record;
  }
}

function artifactStore(payloads: Map<string, unknown>): ArtifactStore {
  return {
    putJson: vi.fn(async (key: string, value: unknown): Promise<ArtifactReference> => {
      payloads.set(key, structuredClone(value));
      return { bucket: 'artifacts', key, sha256: 'a'.repeat(64) };
    }),
    getJson: vi.fn(async <T>(reference: Pick<ArtifactReference, 'key'>): Promise<T> => {
      return structuredClone(payloads.get(reference.key)) as T;
    }),
  } as unknown as ArtifactStore;
}

function run(runId: string): RunRecord {
  return {
    runId,
    ownerId: 'owner-1',
    ownerCreated: `owner-1#2026-08-20T10:05:00.000Z#${runId}`,
    status: 'queued',
    createdAt: '2026-08-20T10:05:00.000Z',
    updatedAt: '2026-08-20T10:05:00.000Z',
    expiresAt: 1,
    requestHash: 'b'.repeat(64),
    input: { bucket: 'artifacts', key: 'input', sha256: 'c'.repeat(64) },
    sourceKind: 'api',
  };
}
