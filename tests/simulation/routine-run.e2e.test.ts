import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type {
  ArtifactStore,
  CreateRunResult,
  RoutineStore,
  RunQueue,
  RunStore,
} from '../../src/core/ports.js';
import { RoutineService } from '../../src/core/routine-service.js';
import { RunService } from '../../src/core/run-service.js';
import type {
  ArtifactReference,
  ListRunsResult,
  RunError,
  RunRecord,
  RunResult,
  RunStateEvent,
  RunStatus,
} from '../../src/domain/contracts.js';
import type { ListRoutinesResult, RoutineRecord } from '../../src/domain/routines.js';

describe('simulated routine-to-run workflow', () => {
  it('preserves capabilities and integration policy across durable scheduling and duplicate ticks', async () => {
    const clock = { now: () => new Date('2026-08-20T13:00:00.000Z') };
    const artifacts = new MemoryArtifacts();
    const runs = new MemoryRuns();
    const queue = new MemoryQueue();
    const runService = new RunService({
      store: runs,
      artifacts,
      queue,
      executions: { stop: async () => undefined },
      allowedSandboxModes: ['read-only', 'workspace-write', 'danger-full-access'],
      clock,
      ids: {
        random: () => 'random-run',
        deterministic: () => 'routine-run-deterministic',
      },
    });
    const routineStore = new MemoryRoutines();
    const routineService = new RoutineService({
      store: routineStore,
      artifacts,
      runs: runService,
      allowedSandboxModes: ['read-only', 'workspace-write', 'danger-full-access'],
      clock,
      randomId: () => 'routine-customer-ops',
    });

    const routine = await routineService.create('api:shop-owner', {
      version: '1',
      name: 'Customer operations check',
      schedule: {
        kind: 'interval',
        everyMinutes: 15,
        startAt: '2026-08-20T13:00:00.000Z',
      },
      request: {
        version: '1',
        prompt: 'Review Slack escalations and Stripe refund exceptions.',
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
        integrations: {
          connectionSet: 'shop-operations',
          connections: [{ connection: 'stripe-live', preset: 'read-write' }],
        },
        destinations: [{ kind: 'slack', route: 'customer-operations' }],
      },
    });

    expect(JSON.stringify(routine)).not.toContain('Review Slack escalations');
    const ticks = await Promise.all([routineService.tick(), routineService.tick()]);
    expect(ticks.reduce((sum, result) => sum + result.scheduled, 0)).toBe(1);
    expect(runs.records).toHaveLength(1);
    expect(new Set(queue.messages.map((message) => message.runId))).toEqual(
      new Set(['routine-run-deterministic']),
    );

    const run = runs.records[0];
    expect(run).toMatchObject({
      runId: 'routine-run-deterministic',
      ownerId: 'api:shop-owner',
      capabilityOwnerId: 'api:shop-owner',
      status: 'queued',
      sourceKind: 'api',
      provenance: {
        actor: {
          kind: 'system',
          id: 'routine:routine-customer-ops',
          provider: 'api',
        },
        credentialSubject: { kind: 'runtime', id: 'api:shop-owner' },
      },
    });
    if (!run) throw new Error('routine did not persist a run');
    await expect(artifacts.getJson(run.input)).resolves.toMatchObject({
      prompt: 'Review Slack escalations and Stripe refund exceptions.',
      source: {
        kind: 'api',
        requestId: 'routine:routine-customer-ops:2026-08-20T13:00:00.000Z',
      },
      metadata: {
        routineId: 'routine-customer-ops',
        routineName: 'Customer operations check',
        scheduledAt: '2026-08-20T13:00:00.000Z',
      },
      agent: {
        sandbox: 'danger-full-access',
        capabilities: {
          profile: 'small-business',
          approvalPolicy: 'on-request',
          networkAccess: true,
          computerUse: 'browser',
        },
      },
      integrations: {
        connectionSet: 'shop-operations',
        connections: [{ connection: 'stripe-live', preset: 'read-write' }],
      },
    });
    expect(JSON.stringify([...artifacts.values.values()])).not.toContain('xox');
    expect(await routineStore.get('routine-customer-ops')).toMatchObject({
      lastRunId: 'routine-run-deterministic',
      lastRunAt: '2026-08-20T13:00:00.000Z',
      nextRunAt: '2026-08-20T13:15:00.000Z',
    });
  });

  it('refuses a tampered routine request before creating or enqueueing a run', async () => {
    const clock = { now: () => new Date('2026-08-20T14:00:00.000Z') };
    const artifacts = new MemoryArtifacts();
    const runs = new MemoryRuns();
    const queue = new MemoryQueue();
    const runService = new RunService({
      store: runs,
      artifacts,
      queue,
      executions: { stop: async () => undefined },
      clock,
      ids: { random: () => 'unused', deterministic: () => 'tampered-run' },
    });
    const routineStore = new MemoryRoutines();
    const routineService = new RoutineService({
      store: routineStore,
      artifacts,
      runs: runService,
      clock,
      randomId: () => 'routine-tamper-check',
    });
    const routine = await routineService.create('api:shop-owner', {
      version: '1',
      name: 'Tamper check',
      schedule: {
        kind: 'interval',
        everyMinutes: 5,
        startAt: '2026-08-20T14:00:00.000Z',
      },
      request: { version: '1', prompt: 'Original trusted prompt' },
    });
    artifacts.values.set(routine.request.key, {
      version: '1',
      prompt: 'Tampered prompt with broader instructions',
    });

    await expect(routineService.tick()).rejects.toThrow('due routines failed');
    expect(runs.records).toEqual([]);
    expect(queue.messages).toEqual([]);
    const unchanged = await routineStore.get(routine.routineId);
    expect(unchanged).toMatchObject({
      nextRunAt: '2026-08-20T14:00:00.000Z',
    });
    expect(unchanged).not.toHaveProperty('lastRunId');
  });
});

class MemoryArtifacts implements ArtifactStore {
  public readonly values = new Map<string, unknown>();

  public async putJson(key: string, value: unknown): Promise<ArtifactReference> {
    const encoded = JSON.stringify(value);
    this.values.set(key, structuredClone(value));
    return {
      bucket: 'simulated-artifacts',
      key,
      sha256: createHash('sha256').update(encoded).digest('hex'),
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

class MemoryRoutines implements RoutineStore {
  private readonly records = new Map<string, RoutineRecord>();

  public async create(record: RoutineRecord): Promise<void> {
    if (this.records.has(record.routineId)) throw new Error('routine already exists');
    this.records.set(record.routineId, structuredClone(record));
  }

  public async get(routineId: string): Promise<RoutineRecord | undefined> {
    const record = this.records.get(routineId);
    return record ? structuredClone(record) : undefined;
  }

  public async list(ownerId: string): Promise<ListRoutinesResult> {
    return {
      items: [...this.records.values()]
        .filter((record) => record.ownerId === ownerId && record.status !== 'deleted')
        .map((record) => structuredClone(record)),
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
    if (!record || record.ownerId !== ownerId) throw new Error('routine not found');
    return record;
  }
}
