import { describe, expect, it } from 'vitest';
import {
  compileRoutineOccurrence,
  createRoutineRecord,
  publicRoutine,
  routineRequestKey,
  summarizeRoutineTick,
  type RoutineTickOutcome,
} from '../../src/core/routine-planning.js';
import { nextOccurrence as legacyNextOccurrence, publicRoutine as legacyPublicRoutine } from '../../src/core/routine-service.js';
import type { RunRequest } from '../../src/domain/contracts.js';
import { nextOccurrence } from '../../src/domain/routine-spec.js';
import type { RoutineRecord } from '../../src/domain/routines.js';

const timestamp = '2026-08-20T10:05:00.000Z';
const request: RunRequest = {
  version: '1', prompt: 'Review the queue',
  agent: { capabilities: { networkAccess: false } }, destinations: [],
  integrations: { connections: [{ connection: 'slack-team', preset: 'read-only', denyOperations: ['slack.chat.postMessage'] }] },
  metadata: { count: 0, active: false, label: '', nested: { tags: ['ops'] } },
};

describe('routine occurrence compilation', () => {
  it.each(['manual', 'schedule'] as const)('compiles %s identity without changing caller-owned values', (kind) => {
    const input = freeze({
      routine: routine(), request, scheduledAt: kind === 'schedule' ? timestamp : undefined,
      idempotencyKey: 'receipt-1',
    });
    const before = structuredClone(input);
    const compiled = compileRoutineOccurrence(input);
    expect(compileRoutineOccurrence(input)).toEqual(compiled);
    expect(compiled.request).toEqual({
      ...request,
      source: {
        kind: 'api', requestId: kind === 'schedule'
          ? `routine:routine-1:${timestamp}`
          : expect.stringMatching(/^routine:routine-1:manual:[a-f0-9]{32}$/),
      },
      metadata: { ...request.metadata, routineId: 'routine-1', routineName: 'Review',
        ...(kind === 'schedule' ? { scheduledAt: timestamp } : {}),
      },
    });
    expect(compiled.options).toEqual({
      idempotencyKey: 'receipt-1', capabilityOwnerId: 'owner-1',
      provenance: {
        actor: { kind: 'system', id: 'routine:routine-1', provider: 'api' },
        credentialSubject: { kind: 'runtime', id: 'owner-1' },
      },
    });
    const retried = compileRoutineOccurrence({ ...input, routine: { ...input.routine, updatedAt: '2026-08-21T11:00:00.000Z' } });
    expect(retried).toEqual(compiled);
    if (kind === 'manual') {
      expect(compiled.request.metadata).not.toHaveProperty('scheduledAt');
      expect(compileRoutineOccurrence({ ...input, idempotencyKey: 'receipt-2' }).request.source)
        .not.toEqual(compiled.request.source);
    }
    expect(compiled.request.metadata).not.toBe(input.request.metadata);
    if (!compiled.request.metadata) throw new Error('expected occurrence metadata');
    compiled.request.metadata.routineName = 'Changed output';
    expect(input).toEqual(before);
  });

  it('constructs paused records from supplied time and exposes the existing public projection', () => {
    const input = freeze({
      ownerId: 'owner-1', routineId: 'routine-1',
      parsed: { name: 'Review', enabled: false, request, schedule: { kind: 'interval' as const, everyMinutes: 5 } },
      request: routine().request, requestHash: 'b'.repeat(64), now: new Date(timestamp),
    });
    const before = structuredClone(input);
    const record = createRoutineRecord(input);
    expect(record).toEqual({
      ...routine(), status: 'paused', nextRunAt: '2026-08-20T10:10:00.000Z',
    });
    const visible = publicRoutine(freeze(record));
    expect(visible).not.toHaveProperty('ownerId');
    expect(visible).not.toHaveProperty('ownerCreated');
    expect(visible).not.toHaveProperty('request');
    expect(visible).toMatchObject({ requestHash: input.requestHash, status: 'paused', nextRunAt: record.nextRunAt });
    expect(visible.schedule).toBe(record.schedule);
    expect(legacyPublicRoutine).toBe(publicRoutine);
    expect(legacyNextOccurrence).toBe(nextOccurrence);
    expect(input).toEqual(before);
  });

  it('scopes request references by owner, routine, and content digest', () => {
    const key = routineRequestKey('owner-1', 'routine-1', 'b'.repeat(64));
    expect(key).toMatch(/^owners\/[a-f0-9]{32}\/routines\/routine-1\/request-b{64}\.json$/);
    expect(key).not.toContain('owner-1');
    expect(routineRequestKey('owner-2', 'routine-1', 'b'.repeat(64))).not.toBe(key);
    expect(routineRequestKey('owner-1', 'routine-2', 'b'.repeat(64))).not.toBe(key);
    expect(routineRequestKey('owner-1', 'routine-1', 'c'.repeat(64))).not.toBe(key);
  });
});

describe('routine tick summaries', () => {
  it('counts only committed advances while retaining submission order', () => {
    const outcomes = freeze<RoutineTickOutcome[]>([
      { kind: 'scheduled', run: { runId: 'run-1', status: 'queued' } },
      { kind: 'raced' },
      { kind: 'scheduled', run: { runId: 'run-2', status: 'succeeded' } },
    ]);
    expect(summarizeRoutineTick(3, outcomes)).toEqual({
      examined: 3, scheduled: 2, runs: [{ runId: 'run-1', status: 'queued' }, { runId: 'run-2', status: 'succeeded' }],
    });
    expect(summarizeRoutineTick(0, [])).toEqual({ examined: 0, scheduled: 0, runs: [] });
    expect(summarizeRoutineTick(1, [{ kind: 'raced' }])).toEqual({ examined: 1, scheduled: 0, runs: [] });
  });

  it('preserves error identities and order in a partially successful batch', () => {
    const failures = [new Error('submission failed'), new Error('advance failed')];
    const outcomes: RoutineTickOutcome[] = failures.map((error) => ({ kind: 'failed', error }));
    outcomes.splice(1, 0, { kind: 'scheduled', run: { runId: 'run-1', status: 'queued' } });
    expect(() => summarizeRoutineTick(3, freeze(outcomes))).toThrow(AggregateError);
    try {
      summarizeRoutineTick(3, outcomes);
    } catch (error) {
      if (!(error instanceof AggregateError)) throw error;
      expect(error.message).toBe('one or more due routines failed');
      expect(error.errors[0]).toBe(failures[0]);
      expect(error.errors[1]).toBe(failures[1]);
    }
  });
});

function routine(): RoutineRecord {
  return {
    version: '1', routineId: 'routine-1', ownerId: 'owner-1', ownerCreated: `owner-1#${timestamp}#routine-1`,
    name: 'Review', status: 'enabled', schedule: { kind: 'interval', everyMinutes: 5 }, nextRunAt: timestamp,
    request: { bucket: 'artifacts', key: 'stored-request', sha256: 'a'.repeat(64) },
    requestHash: 'b'.repeat(64), createdAt: timestamp, updatedAt: timestamp,
  };
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
