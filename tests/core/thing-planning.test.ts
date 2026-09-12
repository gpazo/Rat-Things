import { describe, expect, it } from 'vitest';
import {
  assertPublishDraft,
  assertPublishTestRun,
  compileThingOccurrence,
  scheduledThingDecision,
  synchronizedTriggerState,
  thingTriggerAction,
} from '../../src/core/thing-planning.js';
import { ConflictError } from '../../src/core/run-service.js';
import type { RunRecord, ThingRunBinding } from '../../src/domain/contracts.js';
import type { ScheduledThingInvocation, ThingRecord, ThingRevision, ThingSpec } from '../../src/domain/things.js';

const timestamp = '2026-08-21T11:00:00.000Z';
const spec: ThingSpec = {
  version: '1',
  name: 'Published goal',
  goal: 'Review the queue',
  trigger: { kind: 'schedule', expression: 'rate(1 hour)' },
  metadata: { count: 0, enabled: false, label: '', nested: { tags: ['ops'] } },
};
const revision: ThingRevision = {
  revision: 1,
  name: spec.name,
  trigger: spec.trigger,
  spec: { bucket: 'definitions', key: 'stored-spec', sha256: 'a'.repeat(64) },
  specHash: 'b'.repeat(64),
  createdAt: timestamp,
};
const invocation: ScheduledThingInvocation = {
  version: '1', thingId: 'thing-1', revision: 1, scheduledAt: timestamp,
};

describe('Thing scheduling decisions', () => {
  it.each([
    { name: 'missing', record: undefined, reason: 'missing' },
    { name: 'draft', record: thing({ status: 'draft' }), reason: 'not-active' },
    { name: 'paused', record: thing({ status: 'paused' }), reason: 'not-active' },
    { name: 'archived', record: thing({ status: 'archived' }), reason: 'not-active' },
    { name: 'no published revision', record: withoutActive(), reason: 'stale-revision' },
    { name: 'replaced revision', record: thing({ active: { ...revision, revision: 2 } }), reason: 'stale-revision' },
    { name: 'manual trigger', record: thing({ active: { ...revision, trigger: { kind: 'manual' } } }), reason: 'not-scheduled' },
  ])('ignores $name with its existing reason', ({ record, reason }) => {
    expect(scheduledThingDecision(freeze(record), invocation)).toEqual({ kind: 'ignore', reason });
  });

  it('selects the pinned active revision and a repeatable occurrence key while a newer draft exists', () => {
    const record = freeze(thing({ draft: { ...revision, revision: 2, name: 'New draft' } }));
    const decision = scheduledThingDecision(record, invocation);
    expect(decision).toEqual({
      kind: 'submit', thing: record, revision,
      idempotencyKey: 'thing:thing-1:1:2026-08-21T11:00:00.000Z',
    });
    expect(scheduledThingDecision(record, invocation)).toEqual(decision);
  });

  it.each([
    ['active', true, 'ready'],
    ['paused', false, 'paused'],
  ] as const)('describes %s schedules with explicit enablement and completion state', (status, enabled, state) => {
    const record = freeze(thing({ status }));
    expect(thingTriggerAction(record)).toEqual({
      kind: 'upsert', target: { thingId: 'thing-1', revision: 1, trigger: spec.trigger }, enabled,
    });
    expect(synchronizedTriggerState(record, timestamp)).toEqual({ status: state, revision: 1, updatedAt: timestamp });
  });

  it.each([
    { record: thing({ status: 'archived' }), state: { status: 'inactive', updatedAt: timestamp } },
    { record: withoutActive('draft'), state: { status: 'inactive', updatedAt: timestamp } },
    { record: thing({ active: { ...revision, trigger: { kind: 'manual' } } }), state: { status: 'ready', revision: 1, updatedAt: timestamp } },
  ])('removes obsolete schedules without losing lifecycle state', ({ record, state }) => {
    expect(thingTriggerAction(freeze(record))).toEqual({ kind: 'remove', thingId: 'thing-1' });
    expect(synchronizedTriggerState(record, timestamp)).toEqual(state);
  });
});

describe('Thing occurrence compilation', () => {
  it.each(['test', 'manual', 'schedule'] as const)('compiles %s identity and evidence without modifying its inputs', (kind) => {
    const input = freeze({
      thing: thing({ draft: { ...revision, revision: 2 } }),
      revision,
      spec,
      invocation: kind,
      scheduledAt: kind === 'schedule' ? timestamp : undefined,
      idempotencyKey: 'receipt-1',
    });
    const before = structuredClone(input);
    const compiled = compileThingOccurrence(input);
    expect(compileThingOccurrence(input)).toEqual(compiled);
    expect(compiled.request).toMatchObject({
      prompt: 'Review the queue',
      source: {
        kind: 'api',
        requestId: kind === 'schedule'
          ? `thing:thing-1:1:${timestamp}`
          : expect.stringMatching(new RegExp(`^thing:thing-1:1:${kind}:[a-f0-9]{32}$`)),
      },
      metadata: {
        count: 0, enabled: false, label: '', nested: { tags: ['ops'] },
        thingId: 'thing-1', thingName: 'Published goal', thingRevision: 1, thingInvocation: kind,
      },
    });
    expect(compiled.options).toEqual({
      idempotencyKey: 'receipt-1',
      capabilityOwnerId: 'owner-1',
      provenance: {
        actor: { kind: 'system', id: 'thing:thing-1', provider: 'api' },
        credentialSubject: { kind: 'runtime', id: 'owner-1' },
      },
      thing: {
        version: '1', thingId: 'thing-1', revision: 1, specHash: revision.specHash, invocation: kind,
        ...(kind === 'schedule' ? { scheduledAt: timestamp } : {}),
      },
    });
    if (kind === 'schedule') {
      expect(compiled.request.metadata?.scheduledAt).toBe(timestamp);
    } else {
      expect(compiled.request.metadata).not.toHaveProperty('scheduledAt');
      expect(compileThingOccurrence({ ...input, idempotencyKey: 'receipt-2' }).request.source)
        .not.toEqual(compiled.request.source);
    }
    compiled.request.metadata!.thingName = 'Changed output';
    expect(input).toEqual(before);
  });
});

describe('Thing publish evidence', () => {
  it('requires both the expected revision and digest', () => {
    const input = { expectedDraftRevision: 1, expectedSpecHash: revision.specHash, testRunId: 'run-test' };
    expect(() => assertPublishDraft(revision, input)).not.toThrow();
    expect(() => assertPublishDraft(revision, { ...input, expectedDraftRevision: 2 }))
      .toThrow('Thing draft changed; expected 2, current 1');
    expect(() => assertPublishDraft(revision, { ...input, expectedSpecHash: 'c'.repeat(64) }))
      .toThrow('Thing draft content changed');
  });

  it.each([
    { thingId: 'another-thing' },
    { revision: 2 },
    { specHash: 'c'.repeat(64) },
    { invocation: 'manual' },
    { invocation: 'schedule' },
  ] satisfies Partial<ThingRunBinding>[])('rejects mismatched test evidence %j', (override) => {
    const run = testRun(override);
    expect(() => assertPublishTestRun('thing-1', revision, run, run.runId)).toThrow(ConflictError);
  });

  it('requires successful test evidence and preserves failure precedence', () => {
    const run = freeze(testRun());
    expect(() => assertPublishTestRun('thing-1', revision, run, run.runId)).not.toThrow();
    const { thing: _evidence, ...missingEvidence } = run;
    expect(() => assertPublishTestRun('thing-1', revision, missingEvidence, run.runId))
      .toThrow('does not prove this exact draft revision');
    expect(() => assertPublishTestRun('thing-1', revision, { ...missingEvidence, status: 'failed' }, run.runId))
      .toThrow('Thing test Run run-test has not succeeded');
  });
});

function thing(overrides: Partial<ThingRecord> = {}): ThingRecord {
  return {
    version: '1', thingId: 'thing-1', ownerId: 'owner-1',
    ownerCreated: `owner-1#${timestamp}#thing-1`, status: 'active',
    draft: revision, active: revision,
    triggerState: { status: 'ready', revision: 1, updatedAt: timestamp },
    createdAt: timestamp, updatedAt: timestamp,
    ...overrides,
  };
}

function withoutActive(status: ThingRecord['status'] = 'active'): ThingRecord {
  const { active: _active, ...record } = thing({ status });
  return record;
}

function testRun(overrides: Partial<ThingRunBinding> = {}): RunRecord {
  return {
    runId: 'run-test', ownerId: 'owner-1', ownerCreated: `owner-1#${timestamp}#run-test`,
    status: 'succeeded', createdAt: timestamp, updatedAt: timestamp, expiresAt: 1,
    requestHash: 'd'.repeat(64), input: { bucket: 'runs', key: 'input', sha256: 'e'.repeat(64) }, sourceKind: 'api',
    thing: {
      version: '1', thingId: 'thing-1', revision: 1, specHash: revision.specHash, invocation: 'test', ...overrides,
    },
  };
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
