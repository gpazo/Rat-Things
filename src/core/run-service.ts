import { createHash, randomUUID } from 'node:crypto';
import type {
  ConversationRunBinding,
  RunProvenance,
  RunRecord,
  RunRequest,
} from '../domain/contracts.js';
import type { SandboxMode } from '../domain/contracts.js';
import { isTerminal } from '../domain/state.js';
import { parseRunRequest, ValidationError } from '../domain/validation.js';
import type {
  ArtifactStore,
  Clock,
  ExecutionController,
  IdGenerator,
  RunQueue,
  RunStore,
} from './ports.js';

const DEFAULT_RETENTION_SECONDS = 30 * 24 * 60 * 60;

export class ConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

export class NotFoundError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class ForbiddenError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ForbiddenError';
  }
}

export interface SubmitOptions {
  idempotencyKey?: string;
  traceId?: string;
  provenance?: RunProvenance;
  /** Defer the SQS wake-up until a coordinator has committed its related state. */
  enqueue?: boolean;
  /** Internal coordinator-only metadata; never copied from a public RunRequest. */
  conversation?: ConversationRunBinding;
}

export interface RunServiceOptions {
  store: RunStore;
  artifacts: ArtifactStore;
  queue: RunQueue;
  executions: ExecutionController;
  allowedRepositoryHosts?: string[];
  allowedSandboxModes?: SandboxMode[];
  retentionSeconds?: number;
  clock?: Clock;
  ids?: IdGenerator;
}

export class RunService {
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly retentionSeconds: number;

  public constructor(private readonly options: RunServiceOptions) {
    this.clock = options.clock ?? { now: () => new Date() };
    this.ids = options.ids ?? defaultIds;
    this.retentionSeconds = options.retentionSeconds ?? DEFAULT_RETENTION_SECONDS;
  }

  public async submit(ownerId: string, rawRequest: unknown, submit: SubmitOptions = {}): Promise<RunRecord> {
    if (!ownerId.trim()) throw new ForbiddenError('an authenticated owner is required');
    if (Buffer.byteLength(ownerId, 'utf8') > 1_024) throw new ForbiddenError('owner identity is too large');
    const request = parseRunRequest(rawRequest, {
      ...(this.options.allowedRepositoryHosts
        ? { allowedRepositoryHosts: this.options.allowedRepositoryHosts }
        : {}),
      ...(this.options.allowedSandboxModes
        ? { allowedSandboxModes: this.options.allowedSandboxModes }
        : {}),
    });
    const canonical = stableJson(request);
    const requestHash = sha256(canonical);
    const runId = submit.idempotencyKey
      ? this.ids.deterministic(ownerId, validateIdempotencyKey(submit.idempotencyKey))
      : this.ids.random();

    if (submit.idempotencyKey) {
      const existing = await this.options.store.get(runId);
      if (existing) {
        const same = assertSameRequest(existing, requestHash);
        // SQS is a wake-up hint, not the source of truth. Re-nudging a still-queued run is safe
        // and repairs the create-record/enqueue crash window.
        if (same.status === 'queued' && submit.enqueue !== false) {
          await this.enqueue(same.runId, submit.traceId);
        }
        return same;
      }
    }

    const ownerHash = sha256(ownerId).slice(0, 32);
    const input = await this.options.artifacts.putJson(
      `owners/${ownerHash}/runs/${runId}/input-${requestHash}.json`,
      request,
    );
    const now = this.clock.now();
    const iso = now.toISOString();
    const record: RunRecord = {
      runId,
      ownerId,
      ownerCreated: `${ownerId}#${iso}#${runId}`,
      status: 'queued',
      createdAt: iso,
      updatedAt: iso,
      expiresAt: Math.floor(now.getTime() / 1_000) + this.retentionSeconds,
      requestHash,
      input,
      sourceKind: request.source?.kind ?? 'api',
      ...(submit.provenance ? { provenance: submit.provenance } : {}),
      ...(submit.conversation ? { conversation: validateConversationBinding(submit.conversation) } : {}),
    };

    const created = await this.options.store.create(record);
    if (!created.created) return assertSameRequest(created.record, requestHash);

    try {
      if (submit.enqueue !== false) await this.enqueue(runId, submit.traceId);
    } catch (error) {
      // Keep the durable run queued. An idempotent client retry or the scheduled reconciler
      // will send another wake-up without regenerating the request or changing its run ID.
      throw error;
    }
    return record;
  }

  public async get(ownerId: string, runId: string): Promise<RunRecord> {
    const record = await this.options.store.get(runId);
    if (!record) throw new NotFoundError('run not found');
    assertOwner(record, ownerId);
    return record;
  }

  public async list(ownerId: string, limit = 25, nextToken?: string) {
    const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    try {
      return await this.options.store.list(ownerId, boundedLimit, nextToken);
    } catch (error) {
      if (error instanceof Error && error.message === 'invalid pagination token') {
        throw new ValidationError('nextToken is invalid');
      }
      throw error;
    }
  }

  public async cancel(ownerId: string, runId: string): Promise<RunRecord> {
    const current = await this.get(ownerId, runId);
    if (isTerminal(current.status)) return current;
    if (current.status === 'cancelling') {
      if (current.execution && current.execution.id !== 'pending') {
        await this.options.executions.stop(current.execution, `cancelled by ${ownerId}`);
      }
      return current;
    }
    const now = this.clock.now().toISOString();
    if (current.status === 'queued') {
      return this.options.store.transition(runId, ['queued'], 'cancelled', {
        cancelRequestedAt: now,
      });
    }
    const cancelling = await this.options.store.transition(
      runId,
      ['dispatching', 'running'],
      'cancelling',
      { cancelRequestedAt: now },
    );
    if (cancelling.execution && cancelling.execution.id !== 'pending') {
      await this.options.executions.stop(cancelling.execution, `cancelled by ${ownerId}`);
    }
    return cancelling;
  }

  /**
   * Sends a durable run wake-up after an external coordinator has committed its own binding.
   * Duplicate wake-ups are safe because the dispatcher claims the run conditionally.
   */
  public async wake(runId: string, traceId?: string): Promise<void> {
    if (!/^[A-Za-z0-9-]{1,128}$/.test(runId)) throw new ValidationError('run ID is invalid');
    await this.enqueue(runId, traceId);
  }

  private enqueue(runId: string, traceId?: string): Promise<void> {
    return this.options.queue.enqueue({
      version: '1',
      runId,
      traceId: traceId ?? runId,
    });
  }
}

function validateConversationBinding(binding: ConversationRunBinding): ConversationRunBinding {
  for (const [label, value, maximum] of [
    ['conversationId', binding.conversationId, 512],
    ['turnId', binding.turnId, 512],
  ] as const) {
    if (!value || Buffer.byteLength(value, 'utf8') > maximum) {
      throw new ValidationError(`${label} is invalid`);
    }
  }
  if (!Number.isInteger(binding.slice) || binding.slice < 0 || binding.slice > 10_000) {
    throw new ValidationError('conversation slice is invalid');
  }
  if (binding.preferredMicrovmId && !/^[A-Za-z0-9._:-]{1,256}$/.test(binding.preferredMicrovmId)) {
    throw new ValidationError('preferred MicroVM ID is invalid');
  }
  if (binding.agentThreadId && !/^[A-Za-z0-9._:-]{1,256}$/.test(binding.agentThreadId)) {
    throw new ValidationError('agent thread ID is invalid');
  }
  if (binding.continuation && (
    !binding.continuation.bucket ||
    !binding.continuation.key ||
    !/^[a-f0-9]{64}$/.test(binding.continuation.sha256)
  )) {
    throw new ValidationError('conversation continuation artifact is invalid');
  }
  return { ...binding };
}

export function requestForRun(request: RunRequest): RunRequest {
  return request;
}

const defaultIds: IdGenerator = {
  random: () => randomUUID(),
  deterministic: (ownerId, key) => {
    const hex = sha256(`${ownerId}\u0000${key}`).slice(0, 32).split('');
    hex[12] = '5';
    const variant = Number.parseInt(hex[16] ?? '0', 16);
    hex[16] = ((variant & 0x3) | 0x8).toString(16);
    const joined = hex.join('');
    return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
  },
};

function validateIdempotencyKey(value: string): string {
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(value)) {
    throw new ValidationError('Idempotency-Key must be 1-200 safe ASCII characters');
  }
  return value;
}

function assertSameRequest(record: RunRecord, requestHash: string): RunRecord {
  if (record.requestHash !== requestHash) {
    throw new ConflictError('the idempotency key was already used with a different request');
  }
  return record;
}

function assertOwner(record: RunRecord, ownerId: string): void {
  if (record.ownerId !== ownerId) throw new ForbiddenError('run belongs to another owner');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}
