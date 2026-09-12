import type {
  PublicThing,
  PublicThingSummary,
  ThingDiagnostic,
  ThingExplanation,
  ThingRecord,
  ThingRevision,
  ThingSpec,
} from '../domain/things.js';
import { compileThingSpec } from '../domain/thing-spec.js';
import { ConflictError } from './run-service.js';

export function publicThingSummary(record: ThingRecord): PublicThingSummary {
  return {
    version: '1',
    thingId: record.thingId,
    status: record.status,
    draft: publicRevisionSummary(record.draft),
    ...(record.active ? { active: publicRevisionSummary(record.active) } : {}),
    hasUnpublishedChanges: !record.active || record.active.revision !== record.draft.revision,
    triggerState: structuredClone(record.triggerState),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.lastRunAt ? { lastRunAt: record.lastRunAt } : {}),
    ...(record.lastRunId ? { lastRunId: record.lastRunId } : {}),
  };
}

/** Explains a validated, loaded Thing without reading storage or resolving credentials. */
export function explainThing(thing: PublicThing, target: 'draft' | 'active'): ThingExplanation {
  const selected = target === 'draft' ? thing.draft : thing.active;
  if (!selected) throw new ConflictError('the Thing has no published revision to explain');
  const diagnostics: ThingDiagnostic[] = [
    {
      id: 'spec.valid',
      status: 'pass',
      message: `Thing ${target} revision ${selected.revision} is valid and its digest matches storage.`,
    },
    lifecycleDiagnostic(thing, target),
    triggerDiagnostic(thing, target),
    connectionDiagnostic(selected.spec),
  ];
  return {
    version: '1',
    target,
    thing,
    compiledRun: compileThingSpec(selected.spec),
    runnable: thing.status !== 'archived',
    diagnostics,
  };
}

function publicRevisionSummary(revision: ThingRevision): Omit<ThingRevision, 'spec'> {
  const { spec: _spec, ...visible } = revision;
  return structuredClone(visible);
}

function lifecycleDiagnostic(thing: PublicThing, target: 'draft' | 'active'): ThingDiagnostic {
  if (thing.status === 'archived') {
    return { id: 'lifecycle', status: 'error', message: 'The Thing is archived and cannot run.' };
  }
  if (target === 'draft') {
    return {
      id: 'lifecycle',
      status: thing.hasUnpublishedChanges ? 'warning' : 'pass',
      message: thing.hasUnpublishedChanges
        ? `Draft revision ${thing.draft.revision} is testable but is not the published production revision.`
        : `Draft revision ${thing.draft.revision} is also the published production revision.`,
    };
  }
  if (thing.status === 'paused') {
    return {
      id: 'lifecycle',
      status: 'warning',
      message: 'The published revision can be invoked explicitly, but scheduled delivery is paused.',
    };
  }
  return { id: 'lifecycle', status: 'pass', message: 'The published revision is active.' };
}

function triggerDiagnostic(thing: PublicThing, target: 'draft' | 'active'): ThingDiagnostic {
  const selected = target === 'draft' ? thing.draft : thing.active;
  if (!selected) return { id: 'trigger', status: 'error', message: 'No published trigger exists.' };
  if (selected.spec.trigger.kind === 'manual') {
    return {
      id: 'trigger',
      status: 'pass',
      message: 'The revision runs through an authenticated API or CLI invocation.',
    };
  }
  const stateIsRelevant = target === 'active' || selected.revision === thing.active?.revision;
  const state = stateIsRelevant ? thing.triggerState : undefined;
  return {
    id: 'trigger',
    status: state?.status === 'error' ? 'error' : state?.status === 'syncing' ? 'warning' : 'pass',
    message: state?.status === 'error'
      ? `EventBridge Scheduler synchronization failed: ${state.error ?? 'unknown error'}`
      : `${selected.spec.trigger.expression} in ${selected.spec.trigger.timezone ?? 'UTC'}${state ? ` is ${state.status}` : ' will be provisioned when published'}.`,
  };
}

function connectionDiagnostic(spec: ThingSpec): ThingDiagnostic {
  const count = spec.connections?.accounts?.length ?? 0;
  const set = spec.connections?.set;
  if (!set && count === 0) {
    return { id: 'connections', status: 'pass', message: 'The Thing requests no integration accounts.' };
  }
  return {
    id: 'connections',
    status: 'pass',
    message: `The Thing requests ${count} explicit account${count === 1 ? '' : 's'}${set ? ` plus connection set ${set}` : ''}; credentials remain deployment-owned.`,
  };
}
