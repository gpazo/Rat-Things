import type { RunRecord, RunRequest, ThingRunBinding } from '../domain/contracts.js';
import { sha256Hex as sha256 } from '../domain/json.js';
import { compileThingSpec, type ParsedPublishThingInput } from '../domain/thing-spec.js';
import type {
  ScheduledThingInvocation,
  ScheduledThingResult,
  ThingInvocationKind,
  ThingRecord,
  ThingRevision,
  ThingSpec,
  ThingTriggerState,
  ThingVersionRecord,
} from '../domain/things.js';
import type { ThingSchedulerTarget } from './ports.js';
import { ConflictError, type SubmitOptions } from './run-service.js';

/** Calculations here consume values only; the service owns reads, writes, IDs, and time. */
export function thingSpecKey(ownerId: string, thingId: string, revision: number, specHash: string): string {
  const ownerHash = sha256(ownerId).slice(0, 32);
  return `owners/${ownerHash}/things/${thingId}/versions/${revision}-${specHash}.json`;
}

export function createThingRecord(
  ownerId: string,
  thingId: string,
  draft: ThingRevision,
  timestamp: string,
): ThingRecord {
  return {
    version: '1',
    thingId,
    ownerId,
    ownerCreated: `${ownerId}#${timestamp}#${thingId}`,
    status: 'draft',
    draft,
    triggerState: { status: 'inactive', updatedAt: timestamp },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function assertDraftRevision(current: ThingRevision, expected: number): void {
  if (expected !== current.revision) {
    throw new ConflictError(`Thing draft changed; expected ${expected}, current ${current.revision}`);
  }
}

export function assertPublishDraft(current: ThingRevision, input: ParsedPublishThingInput): void {
  assertDraftRevision(current, input.expectedDraftRevision);
  if (input.expectedSpecHash !== current.specHash) {
    throw new ConflictError('Thing draft content changed after the tested revision was selected');
  }
}

export function assertPublishTestRun(
  thingId: string,
  draft: ThingRevision,
  testRun: RunRecord,
  testRunId: string,
): void {
  if (testRun.status !== 'succeeded') {
    throw new ConflictError(`Thing test Run ${testRunId} has not succeeded`);
  }
  if (
    testRun.thing?.thingId !== thingId ||
    testRun.thing.revision !== draft.revision ||
    testRun.thing.specHash !== draft.specHash ||
    testRun.thing.invocation !== 'test'
  ) {
    throw new ConflictError('Thing test Run does not prove this exact draft revision');
  }
}

export type ScheduledThingDecision =
  | { kind: 'ignore'; reason: NonNullable<ScheduledThingResult['reason']> }
  | { kind: 'submit'; thing: ThingRecord; revision: ThingRevision; idempotencyKey: string };

/** Decide whether an occurrence is eligible before reading its definition or submitting work. */
export function scheduledThingDecision(
  thing: ThingRecord | undefined,
  invocation: ScheduledThingInvocation,
): ScheduledThingDecision {
  if (!thing) return { kind: 'ignore', reason: 'missing' };
  if (thing.status !== 'active') return { kind: 'ignore', reason: 'not-active' };
  if (!thing.active || thing.active.revision !== invocation.revision) {
    return { kind: 'ignore', reason: 'stale-revision' };
  }
  if (thing.active.trigger.kind !== 'schedule') {
    return { kind: 'ignore', reason: 'not-scheduled' };
  }
  return {
    kind: 'submit',
    thing,
    revision: thing.active,
    idempotencyKey: `thing:${thing.thingId}:${thing.active.revision}:${invocation.scheduledAt}`,
  };
}

export interface ThingOccurrenceInput {
  thing: ThingRecord;
  revision: ThingRevision;
  spec: ThingSpec;
  invocation: ThingInvocationKind;
  scheduledAt: string | undefined;
  idempotencyKey: string;
}

export interface ThingOccurrenceSubmission {
  request: RunRequest;
  options: SubmitOptions & { thing: ThingRunBinding };
}

/** Add trusted occurrence identity without modifying the stored definition or revision. */
export function compileThingOccurrence({
  thing,
  revision,
  spec,
  invocation,
  scheduledAt,
  idempotencyKey,
}: ThingOccurrenceInput): ThingOccurrenceSubmission {
  const request = compileThingSpec(spec);
  const occurrenceId = scheduledAt ?? `${invocation}:${sha256(idempotencyKey).slice(0, 32)}`;
  return {
    request: {
      ...request,
      source: {
        kind: 'api',
        requestId: `thing:${thing.thingId}:${revision.revision}:${occurrenceId}`,
      },
      metadata: {
        ...request.metadata,
        thingId: thing.thingId,
        thingName: revision.name,
        thingRevision: revision.revision,
        thingInvocation: invocation,
        ...(scheduledAt ? { scheduledAt } : {}),
      },
    },
    options: {
      idempotencyKey,
      capabilityOwnerId: thing.ownerId,
      provenance: {
        actor: { kind: 'system', id: `thing:${thing.thingId}`, provider: 'api' },
        credentialSubject: { kind: 'runtime', id: thing.ownerId },
      },
      thing: {
        version: '1',
        thingId: thing.thingId,
        revision: revision.revision,
        specHash: revision.specHash,
        invocation,
        ...(scheduledAt ? { scheduledAt } : {}),
      },
    },
  };
}

export type ThingTriggerAction =
  | { kind: 'remove'; thingId: string }
  | { kind: 'upsert'; target: ThingSchedulerTarget; enabled: boolean };

/** A description of one scheduler effect, interpreted only after the lifecycle write commits. */
export function thingTriggerAction(record: ThingRecord): ThingTriggerAction {
  if (record.status === 'archived' || !record.active || record.active.trigger.kind === 'manual') {
    return { kind: 'remove', thingId: record.thingId };
  }
  return {
    kind: 'upsert',
    target: {
      thingId: record.thingId,
      revision: record.active.revision,
      trigger: record.active.trigger,
    },
    enabled: record.status === 'active',
  };
}

export function synchronizedTriggerState(record: ThingRecord, updatedAt: string): ThingTriggerState {
  if (record.status === 'active' || record.status === 'paused') {
    return {
      status: record.status === 'active' ? 'ready' : 'paused',
      ...(record.active ? { revision: record.active.revision } : {}),
      updatedAt,
    };
  }
  return { status: 'inactive', updatedAt };
}

export function revisionPointer(
  revision: number,
  spec: ThingSpec,
  stored: { reference: ThingRevision['spec']; hash: string },
  createdAt: string,
): ThingRevision {
  return {
    revision,
    name: spec.name,
    trigger: spec.trigger,
    spec: stored.reference,
    specHash: stored.hash,
    createdAt,
  };
}

export function versionRecord(thingId: string, revision: ThingRevision): ThingVersionRecord {
  return { version: '1', thingId, ...structuredClone(revision) };
}

export function syncingState(revision: number | undefined, updatedAt: string): ThingTriggerState {
  return {
    status: 'syncing',
    ...(revision === undefined ? {} : { revision }),
    updatedAt,
  };
}
