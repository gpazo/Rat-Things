import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type {
  ArtifactStore,
  CreateRunResult,
  RunQueue,
  RunStore,
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
  ThingStatus,
  ThingVersionRecord,
} from '../../src/domain/things.js';

describe('simulated Thing-to-run workflow', () => {
  it('preserves a revisioned multi-account Thing across durable scheduling and duplicate ticks', async () => {
    const clock = { now: () => new Date('2026-08-21T15:00:00.000Z') };
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
        deterministic: () => 'thing-run-deterministic',
      },
    });
    const things = new MemoryThings();
    const service = new ThingService({
      store: things,
      artifacts,
      runs: runService,
      allowedSandboxModes: ['read-only', 'workspace-write', 'danger-full-access'],
      clock,
      randomId: () => 'thing-customer-ops',
    });

    const thing = await service.create('api:shop-owner', {
      version: '1',
      status: 'enabled',
      spec: {
        version: '1',
        name: 'Customer operations check',
        goal: 'Review Slack escalations and Stripe refund exceptions.',
        trigger: {
          kind: 'interval',
          everyMinutes: 15,
          startAt: '2026-08-21T15:00:00.000Z',
        },
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
      },
    });

    expect(JSON.stringify(thing)).not.toContain('Review Slack escalations');
    const ticks = await Promise.all([service.tick(), service.tick()]);
    expect(ticks.reduce((sum, result) => sum + result.scheduled, 0)).toBe(1);
    expect(runs.records).toHaveLength(1);
    expect(new Set(queue.messages.map((message) => message.runId))).toEqual(
      new Set(['thing-run-deterministic']),
    );

    const run = runs.records[0];
    expect(run).toMatchObject({
      runId: 'thing-run-deterministic',
      ownerId: 'api:shop-owner',
      capabilityOwnerId: 'api:shop-owner',
      status: 'queued',
      sourceKind: 'api',
      provenance: {
        actor: { kind: 'system', id: 'thing:thing-customer-ops', provider: 'api' },
        credentialSubject: { kind: 'runtime', id: 'api:shop-owner' },
      },
    });
    if (!run) throw new Error('Thing did not persist a run');
    await expect(artifacts.getJson(run.input)).resolves.toMatchObject({
      prompt: 'Review Slack escalations and Stripe refund exceptions.',
      source: {
        kind: 'api',
        requestId: 'thing:thing-customer-ops:1:2026-08-21T15:00:00.000Z',
      },
      metadata: {
        thingId: 'thing-customer-ops',
        thingName: 'Customer operations check',
        thingRevision: 1,
        scheduledAt: '2026-08-21T15:00:00.000Z',
      },
      integrations: {
        connectionSet: 'shop-operations',
        connections: [
          { connection: 'slack-support', preset: 'read-only' },
          { connection: 'stripe-live', preset: 'read-write' },
        ],
      },
    });
    expect(await things.get('thing-customer-ops')).toMatchObject({
      lastRunId: 'thing-run-deterministic',
      lastRunAt: '2026-08-21T15:00:00.000Z',
      nextRunAt: '2026-08-21T15:15:00.000Z',
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

  public async list(): Promise<ListRunsResult> { return { items: structuredClone(this.records) }; }
  public async transition(): Promise<RunRecord> { throw new Error('not implemented'); }
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
    if (!current || current.revision !== expectedRevision) throw new Error('Thing changed concurrently');
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
    const { nextRunAt: _next, ...rest } = current;
    const updated: ThingRecord = {
      ...rest,
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
