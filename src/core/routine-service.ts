import { randomUUID } from 'node:crypto';
import type { RunRequest, RunRecord, SandboxMode } from '../domain/contracts.js';
import { canonicalJson as stableJson, sha256Hex as sha256 } from '../domain/json.js';
import { nextOccurrence, parseRoutineInput, validateRoutineId } from '../domain/routine-spec.js';
import type { RoutineRecord, RoutineTickResult } from '../domain/routines.js';
import { parseRunRequest, ValidationError, type ValidationOptions } from '../domain/validation.js';
import type { ArtifactStore, Clock, RoutineStore } from './ports.js';
import {
  compileRoutineOccurrence,
  createRoutineRecord,
  routineRequestKey,
  summarizeRoutineTick,
  type RoutineTickOutcome,
} from './routine-planning.js';
import { ForbiddenError, NotFoundError, validateOwner, type RunService } from './run-service.js';

export { nextOccurrence } from '../domain/routine-spec.js';
export { publicRoutine } from './routine-planning.js';

const DELETED_ROUTINE_RETENTION_SECONDS = 30 * 24 * 60 * 60;

export interface RoutineServiceOptions {
  store: RoutineStore;
  artifacts: Pick<ArtifactStore, 'getJson' | 'putJson'>;
  runs: Pick<RunService, 'submit'>;
  allowedRepositoryHosts?: string[];
  allowedSandboxModes?: SandboxMode[];
  clock?: Clock;
  randomId?: () => string;
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
    const parsed = parseRoutineInput(raw, this.validationOptions());
    const routineId = this.randomId();
    if (!/^[A-Za-z0-9-]{1,128}$/.test(routineId)) throw new Error('routine ID generator returned an invalid ID');
    const canonical = stableJson(parsed.request);
    const requestHash = sha256(canonical);
    const request = await this.options.artifacts.putJson(
      routineRequestKey(ownerId, routineId, requestHash),
      parsed.request,
    );
    const now = this.clock.now();
    const record = createRoutineRecord({ ownerId, routineId, parsed, request, requestHash, now });
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

  /** Internal read model for trusted control-plane dependency inspection. */
  public async getRequest(ownerId: string, routineId: string): Promise<RunRequest> {
    return this.loadRequest(await this.get(ownerId, routineId));
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
    const run = await this.submitOccurrence(routine, undefined, idempotencyKey);
    await this.options.store.recordLastRun(
      ownerId,
      routineId,
      run.createdAt,
      run.runId,
      this.clock.now().toISOString(),
    );
    return run;
  }

  public async tick(limit = 100): Promise<RoutineTickResult> {
    const now = this.clock.now();
    const due = await this.options.store.listDue(now.toISOString(), Math.max(1, Math.min(500, limit)));
    const examined = due.length;
    const outcomes: RoutineTickOutcome[] = [];
    // Submit and conditionally advance each occurrence before starting the next one.
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
        outcomes.push(advanced
          ? { kind: 'scheduled', run: { runId: run.runId, status: run.status } }
          : { kind: 'raced' });
      } catch (error) {
        outcomes.push({ kind: 'failed', error: error instanceof Error ? error : new Error(String(error)) });
      }
    }
    return summarizeRoutineTick(examined, outcomes);
  }

  private async submitOccurrence(
    routine: RoutineRecord,
    scheduledAt: string | undefined,
    idempotencyKey: string,
  ): Promise<RunRecord> {
    const request = await this.loadRequest(routine);
    const submission = compileRoutineOccurrence({ routine, request, scheduledAt, idempotencyKey });
    return this.options.runs.submit(routine.ownerId, submission.request, submission.options);
  }

  private async loadRequest(routine: RoutineRecord): Promise<RunRequest> {
    const expectedKey = routineRequestKey(routine.ownerId, routine.routineId, routine.requestHash);
    if (routine.request.key !== expectedKey) {
      throw new Error('routine request reference is outside its owner scope');
    }
    const stored = await this.options.artifacts.getJson<unknown>(routine.request);
    const request = parseRunRequest(stored, this.validationOptions());
    if (sha256(stableJson(request)) !== routine.requestHash) {
      throw new Error('routine request does not match its stored digest');
    }
    return request;
  }

  private validationOptions(): ValidationOptions {
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
