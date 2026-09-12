import type { ArtifactReference, RunRecord, RunRequest } from '../domain/contracts.js';
import { sha256Hex as sha256 } from '../domain/json.js';
import { firstOccurrence, type ParsedRoutineInput } from '../domain/routine-spec.js';
import type { PublicRoutine, RoutineRecord, RoutineTickResult } from '../domain/routines.js';
import type { SubmitOptions } from './run-service.js';

export function routineRequestKey(ownerId: string, routineId: string, requestHash: string): string {
  const ownerHash = sha256(ownerId).slice(0, 32);
  return `owners/${ownerHash}/routines/${routineId}/request-${requestHash}.json`;
}

export function createRoutineRecord(input: {
  ownerId: string;
  routineId: string;
  parsed: ParsedRoutineInput;
  request: ArtifactReference;
  requestHash: string;
  now: Date;
}): RoutineRecord {
  const { ownerId, routineId, parsed, request, requestHash, now } = input;
  const createdAt = now.toISOString();
  const nextRunAt = firstOccurrence(now, parsed.schedule, parsed.startAt);
  return {
    version: '1',
    routineId,
    ownerId,
    ownerCreated: `${ownerId}#${createdAt}#${routineId}`,
    name: parsed.name,
    status: parsed.enabled ? 'enabled' : 'paused',
    schedule: parsed.schedule,
    nextRunAt,
    request,
    requestHash,
    createdAt,
    updatedAt: createdAt,
  };
}

export interface RoutineOccurrenceInput {
  routine: RoutineRecord;
  request: RunRequest;
  scheduledAt: string | undefined;
  idempotencyKey: string;
}

/** Compile trusted occurrence identity without changing the stored request or consulting time. */
export function compileRoutineOccurrence({
  routine,
  request,
  scheduledAt,
  idempotencyKey,
}: RoutineOccurrenceInput): { request: RunRequest; options: SubmitOptions } {
  const metadata = {
    ...request.metadata,
    routineId: routine.routineId,
    routineName: routine.name,
    ...(scheduledAt ? { scheduledAt } : {}),
  };
  const occurrenceId = scheduledAt ?? `manual:${sha256(idempotencyKey).slice(0, 32)}`;
  return {
    request: {
      ...request,
      source: { kind: 'api', requestId: `routine:${routine.routineId}:${occurrenceId}` },
      metadata,
    },
    options: {
      idempotencyKey,
      capabilityOwnerId: routine.ownerId,
      provenance: {
        actor: { kind: 'system', id: `routine:${routine.routineId}`, provider: 'api' },
        credentialSubject: { kind: 'runtime', id: routine.ownerId },
      },
    },
  };
}

export type RoutineTickOutcome =
  | { kind: 'scheduled'; run: Pick<RunRecord, 'runId' | 'status'> }
  | { kind: 'raced' }
  | { kind: 'failed'; error: Error };

/** Report only committed advances; all failures remain ordered after the batch has settled. */
export function summarizeRoutineTick(examined: number, outcomes: readonly RoutineTickOutcome[]): RoutineTickResult {
  const runs: RoutineTickResult['runs'] = [];
  const failures: Error[] = [];
  for (const outcome of outcomes) {
    switch (outcome.kind) {
      case 'scheduled': runs.push(outcome.run); break;
      case 'raced': break;
      case 'failed': failures.push(outcome.error); break;
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'one or more due routines failed');
  return { examined, scheduled: runs.length, runs };
}

export function publicRoutine(record: RoutineRecord): PublicRoutine {
  const { ownerId: _ownerId, ownerCreated: _ownerCreated, request: _request, ...visible } = record;
  return visible;
}
