import type { RunRequest } from './contracts.js';
import type { RoutineSchedule } from './routines.js';
import {
  isRecord,
  isoDateTime,
  parseRunRequest,
  rejectUnknown,
  requiredTrimmedString,
  ValidationError,
  type ValidationOptions,
} from './validation.js';

export interface ParsedRoutineInput {
  name: string;
  schedule: RoutineSchedule;
  request: RunRequest;
  enabled: boolean;
  startAt?: string;
}

export function parseRoutineInput(raw: unknown, options: ValidationOptions = {}): ParsedRoutineInput {
  if (!isRecord(raw)) throw new ValidationError('routine must be an object');
  rejectUnknown(raw, ['version', 'name', 'schedule', 'request', 'enabled'], 'routine');
  if (raw.version !== '1') throw new ValidationError('routine.version must be "1"');
  const name = requiredTrimmedString(raw.name, 'routine.name', 128);
  const { schedule, startAt } = parseSchedule(raw.schedule);
  const request = parseRunRequest(raw.request, options);
  if (request.source) throw new ValidationError('routine request cannot set source');
  if (request.parentRunId) throw new ValidationError('routine request cannot set parentRunId');
  if (request.destinations?.some((destination) => destination.kind === 'source')) {
    throw new ValidationError('routine request cannot use the source delivery destination');
  }
  if (request.metadata?.routineId !== undefined || request.metadata?.scheduledAt !== undefined) {
    throw new ValidationError('routine request metadata uses reserved keys');
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    throw new ValidationError('routine.enabled must be a boolean');
  }
  return {
    name,
    schedule,
    enabled: raw.enabled !== false,
    ...(startAt ? { startAt } : {}),
    request,
  };
}

function parseSchedule(value: unknown): { schedule: RoutineSchedule; startAt?: string } {
  if (!isRecord(value)) throw new ValidationError('routine.schedule must be an object');
  rejectUnknown(value, ['kind', 'everyMinutes', 'startAt'], 'routine');
  if (value.kind !== 'interval') throw new ValidationError('routine.schedule.kind must be interval');
  if (
    typeof value.everyMinutes !== 'number' ||
    !Number.isInteger(value.everyMinutes) ||
    value.everyMinutes < 1 ||
    value.everyMinutes > 525_600
  ) throw new ValidationError('routine.schedule.everyMinutes must be an integer from 1 through 525600');
  const schedule: RoutineSchedule = { kind: 'interval', everyMinutes: value.everyMinutes };
  if (value.startAt === undefined) return { schedule };
  const startAt = isoDateTime(value.startAt, 'routine.schedule.startAt');
  return { schedule, startAt };
}

export function firstOccurrence(now: Date, schedule: RoutineSchedule, startAt?: string): string {
  if (startAt) return nextOccurrence(startAt, schedule, now, true);
  return new Date(now.getTime() + intervalMilliseconds(schedule)).toISOString();
}

/** Resume may retain an occurrence due now; advancing after submission always selects a later one. */
export function nextOccurrence(
  scheduledAt: string,
  schedule: RoutineSchedule,
  now: Date,
  includeScheduled = false,
): string {
  const scheduledMs = Date.parse(scheduledAt);
  if (!Number.isFinite(scheduledMs)) throw new Error('routine has an invalid nextRunAt');
  const interval = intervalMilliseconds(schedule);
  let next = includeScheduled ? scheduledMs : scheduledMs + interval;
  if (includeScheduled && next < now.getTime()) {
    next += Math.ceil((now.getTime() - next) / interval) * interval;
  } else if (!includeScheduled && next <= now.getTime()) {
    next += (Math.floor((now.getTime() - next) / interval) + 1) * interval;
  }
  return new Date(next).toISOString();
}

function intervalMilliseconds(schedule: RoutineSchedule): number {
  return schedule.everyMinutes * 60_000;
}

export function validateRoutineId(routineId: string): void {
  if (!/^[A-Za-z0-9-]{1,128}$/.test(routineId)) throw new ValidationError('routine ID is invalid');
}
