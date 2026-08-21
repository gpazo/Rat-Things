import { createHash, randomUUID } from 'node:crypto';
import type { RunRequest, RunRecord, SandboxMode } from '../domain/contracts.js';
import type {
  PublicRoutine,
  RoutineRecord,
  RoutineSchedule,
  RoutineTickResult,
} from '../domain/routines.js';
import { isRecord, parseRunRequest, ValidationError } from '../domain/validation.js';
import type { ArtifactStore, Clock, RoutineStore } from './ports.js';
import { ForbiddenError, NotFoundError, type RunService } from './run-service.js';

const DELETED_ROUTINE_RETENTION_SECONDS = 30 * 24 * 60 * 60;

export interface RoutineServiceOptions {
  store: RoutineStore;
  artifacts: ArtifactStore;
  runs: Pick<RunService, 'submit'>;
  allowedRepositoryHosts?: string[];
  allowedSandboxModes?: SandboxMode[];
  clock?: Clock;
  randomId?: () => string;
}

interface ParsedRoutineInput {
  name: string;
  schedule: RoutineSchedule;
  request: RunRequest;
  enabled: boolean;
  startAt?: string;
}

export class RoutineService {
  private readonly clock: Clock;
  private readonly randomId: () => string;

  public constructor(private readonly options: RoutineServiceOptions) {
    this.clock = options.clock ?? { now: () => new Date() };
    this.randomId = options.randomId ?? randomUUID;
  }

  public async create(ownerId: string, raw: unknown): Promise<RoutineRecord> {
    validateOwner(ownerId);
    const parsed = this.parseInput(raw);
    const routineId = this.randomId();
    if (!/^[A-Za-z0-9-]{1,128}$/.test(routineId)) throw new Error('routine ID generator returned an invalid ID');
    const canonical = stableJson(parsed.request);
    const requestHash = sha256(canonical);
    const ownerHash = sha256(ownerId).slice(0, 32);
    const request = await this.options.artifacts.putJson(
      `owners/${ownerHash}/routines/${routineId}/request-${requestHash}.json`,
      parsed.request,
    );
    const now = this.clock.now();
    const createdAt = now.toISOString();
    const nextRunAt = firstOccurrence(now, parsed.schedule, parsed.startAt);
    const record: RoutineRecord = {
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
    await this.options.store.create(record);
    return record;
  }

  public async get(ownerId: string, routineId: string): Promise<RoutineRecord> {
    validateOwner(ownerId);
    validateRoutineId(routineId);
    const record = await this.options.store.get(routineId);
    if (!record || record.status === 'deleted') throw new NotFoundError('routine not found');
    if (record.ownerId !== ownerId) throw new ForbiddenError('routine belongs to another owner');
    return record;
  }

  public async list(ownerId: string, limit = 25, nextToken?: string) {
    validateOwner(ownerId);
    const bounded = Math.max(1, Math.min(100, Math.floor(limit)));
    try {
      return await this.options.store.list(ownerId, bounded, nextToken);
    } catch (error) {
      if (error instanceof Error && error.message === 'invalid pagination token') {
        throw new ValidationError('nextToken is invalid');
      }
      throw error;
    }
  }

  public async pause(ownerId: string, routineId: string): Promise<RoutineRecord> {
    const current = await this.get(ownerId, routineId);
    if (current.status === 'paused') return current;
    return this.options.store.setStatus(
      ownerId,
      routineId,
      'paused',
      current.nextRunAt,
      this.clock.now().toISOString(),
    );
  }

  public async resume(ownerId: string, routineId: string): Promise<RoutineRecord> {
    const current = await this.get(ownerId, routineId);
    if (current.status === 'enabled') return current;
    const now = this.clock.now();
    return this.options.store.setStatus(
      ownerId,
      routineId,
      'enabled',
      nextOccurrence(current.nextRunAt, current.schedule, now, true),
      now.toISOString(),
    );
  }

  public async delete(ownerId: string, routineId: string): Promise<RoutineRecord> {
    await this.get(ownerId, routineId);
    const now = this.clock.now();
    return this.options.store.softDelete(
      ownerId,
      routineId,
      now.toISOString(),
      Math.floor(now.getTime() / 1_000) + DELETED_ROUTINE_RETENTION_SECONDS,
    );
  }

  public async runNow(
    ownerId: string,
    routineId: string,
    idempotencyKey = `manual:${routineId}:${this.randomId()}`,
  ): Promise<RunRecord> {
    const routine = await this.get(ownerId, routineId);
    return this.submitOccurrence(routine, undefined, idempotencyKey);
  }

  public async tick(limit = 100): Promise<RoutineTickResult> {
    const now = this.clock.now();
    const due = await this.options.store.listDue(now.toISOString(), Math.max(1, Math.min(500, limit)));
    const result: RoutineTickResult = { examined: due.length, scheduled: 0, runs: [] };
    const failures: Error[] = [];
    for (const routine of due) {
      const scheduledAt = routine.nextRunAt;
      try {
        const run = await this.submitOccurrence(
          routine,
          scheduledAt,
          `routine:${routine.routineId}:${scheduledAt}`,
        );
        const advanced = await this.options.store.advance(
          routine.routineId,
          scheduledAt,
          nextOccurrence(scheduledAt, routine.schedule, now),
          run.runId,
          now.toISOString(),
        );
        if (advanced) {
          result.scheduled += 1;
          result.runs.push({ runId: run.runId, status: run.status });
        }
      } catch (error) {
        failures.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'one or more due routines failed');
    return result;
  }

  private async submitOccurrence(
    routine: RoutineRecord,
    scheduledAt: string | undefined,
    idempotencyKey: string,
  ): Promise<RunRecord> {
    const ownerHash = sha256(routine.ownerId).slice(0, 32);
    const expectedKey = `owners/${ownerHash}/routines/${routine.routineId}/request-${routine.requestHash}.json`;
    if (routine.request.key !== expectedKey) {
      throw new Error('routine request reference is outside its owner scope');
    }
    const stored = await this.options.artifacts.getJson<unknown>(routine.request);
    const request = parseRunRequest(stored, this.validationOptions());
    if (sha256(stableJson(request)) !== routine.requestHash) {
      throw new Error('routine request does not match its stored digest');
    }
    const metadata = {
      ...request.metadata,
      routineId: routine.routineId,
      routineName: routine.name,
      ...(scheduledAt ? { scheduledAt } : {}),
    };
    const occurrenceId = scheduledAt ?? `manual:${sha256(idempotencyKey).slice(0, 32)}`;
    return this.options.runs.submit(routine.ownerId, {
      ...request,
      source: { kind: 'api', requestId: `routine:${routine.routineId}:${occurrenceId}` },
      metadata,
    }, {
      idempotencyKey,
      capabilityOwnerId: routine.ownerId,
      provenance: {
        actor: { kind: 'system', id: `routine:${routine.routineId}`, provider: 'api' },
        credentialSubject: { kind: 'runtime', id: routine.ownerId },
      },
    });
  }

  private parseInput(raw: unknown): ParsedRoutineInput {
    if (!isRecord(raw)) throw new ValidationError('routine must be an object');
    rejectUnknown(raw, ['version', 'name', 'schedule', 'request', 'enabled']);
    if (raw.version !== '1') throw new ValidationError('routine.version must be "1"');
    const name = boundedText(raw.name, 'routine.name', 128);
    const { schedule, startAt } = parseSchedule(raw.schedule);
    const request = parseRunRequest(raw.request, this.validationOptions());
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

  private validationOptions(): { allowedRepositoryHosts?: string[]; allowedSandboxModes?: SandboxMode[] } {
    return {
      ...(this.options.allowedRepositoryHosts
        ? { allowedRepositoryHosts: this.options.allowedRepositoryHosts }
        : {}),
      ...(this.options.allowedSandboxModes
        ? { allowedSandboxModes: this.options.allowedSandboxModes }
        : {}),
    };
  }
}

export function publicRoutine(record: RoutineRecord): PublicRoutine {
  const { ownerId: _ownerId, ownerCreated: _ownerCreated, request: _request, ...visible } = record;
  return visible;
}

function parseSchedule(value: unknown): { schedule: RoutineSchedule; startAt?: string } {
  if (!isRecord(value)) throw new ValidationError('routine.schedule must be an object');
  rejectUnknown(value, ['kind', 'everyMinutes', 'startAt']);
  if (value.kind !== 'interval') throw new ValidationError('routine.schedule.kind must be interval');
  if (
    typeof value.everyMinutes !== 'number' ||
    !Number.isInteger(value.everyMinutes) ||
    value.everyMinutes < 1 ||
    value.everyMinutes > 525_600
  ) throw new ValidationError('routine.schedule.everyMinutes must be an integer from 1 through 525600');
  const schedule: RoutineSchedule = { kind: 'interval', everyMinutes: value.everyMinutes };
  if (value.startAt === undefined) return { schedule };
  const startAt = isoDate(value.startAt, 'routine.schedule.startAt');
  return { schedule, startAt };
}

function firstOccurrence(now: Date, schedule: RoutineSchedule, startAt?: string): string {
  if (startAt) return nextOccurrence(startAt, schedule, now, true);
  return new Date(now.getTime() + intervalMilliseconds(schedule)).toISOString();
}

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

function validateOwner(ownerId: string): void {
  if (!ownerId.trim() || Buffer.byteLength(ownerId, 'utf8') > 1_024) {
    throw new ForbiddenError('an authenticated owner is required');
  }
}

function validateRoutineId(routineId: string): void {
  if (!/^[A-Za-z0-9-]{1,128}$/.test(routineId)) throw new ValidationError('routine ID is invalid');
}

function boundedText(value: unknown, label: string, maximumBytes: number): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > maximumBytes) {
    throw new ValidationError(`${label} is invalid`);
  }
  return value.trim();
}

function isoDate(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new ValidationError(`${label} must be an ISO date-time`);
  }
  return new Date(value).toISOString();
}

function rejectUnknown(value: Record<string, unknown>, allowed: string[]): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new ValidationError(`routine contains unknown field ${unknown}`);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
