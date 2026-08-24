import { createHash, randomUUID } from 'node:crypto';
import type {
  ConversationRunBinding,
  RunProvenance,
  RunRecord,
  RunRequest,
  ThingRunBinding,
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
  /** Trusted delegated policy principal, distinct from the run owner. */
  capabilityOwnerId?: string;
  /** Defer the SQS wake-up until a coordinator has committed its related state. */
  enqueue?: boolean;
  /** Internal coordinator-only metadata; never copied from a public RunRequest. */
  conversation?: ConversationRunBinding;
  /** Internal Thing compiler metadata; never copied from a public RunRequest. */
  thing?: ThingRunBinding;
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

  /** Resolves the stable public Run ID before thread coordination begins. */
  public idFor(ownerId: string, idempotencyKey: string): string {
    if (!ownerId.trim()) throw new ForbiddenError('an authenticated owner is required');
    if (Buffer.byteLength(ownerId, 'utf8') > 1_024) throw new ForbiddenError('owner identity is too large');
    return this.ids.deterministic(ownerId, validateIdempotencyKey(idempotencyKey));
  }

  /** Returns the exact canonical request accepted by this deployment. */
  public canonicalize(rawRequest: unknown): RunRequest {
    return this.parse(rawRequest);
  }

  public async submit(ownerId: string, rawRequest: unknown, submit: SubmitOptions = {}): Promise<RunRecord> {
    if (!ownerId.trim()) throw new ForbiddenError('an authenticated owner is required');
    if (Buffer.byteLength(ownerId, 'utf8') > 1_024) throw new ForbiddenError('owner identity is too large');
    const request = this.parse(rawRequest);
    const canonical = stableJson(request);
    const requestHash = sha256(canonical);
    const runId = submit.idempotencyKey
      ? this.idFor(ownerId, submit.idempotencyKey)
      : this.ids.random();

    if (submit.idempotencyKey) {
      const existing = await this.options.store.get(runId);
      if (existing) {
        const same = assertSameRequest(existing, requestHash);
        assertSameThing(same.thing, submit.thing);
        assertSameConversationBinding(same.conversation, submit.conversation);
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
      ...(submit.capabilityOwnerId
        ? { capabilityOwnerId: validateCapabilityOwner(submit.capabilityOwnerId) }
        : {}),
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
      ...(submit.thing ? { thing: validateThingBinding(submit.thing) } : {}),
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

  /**
   * Attaches the trusted, late-bound input for a threaded Run. The caller's
   * original input remains immutable and continues to define idempotency.
   */
  public async prepareConversation(
    ownerId: string,
    runId: string,
    rawExecutionRequest: unknown,
    binding: ConversationRunBinding,
  ): Promise<RunRecord> {
    const current = await this.get(ownerId, runId);
    if (current.status !== 'queued') {
      if (current.executionInput && sameConversation(current.conversation, binding)) return current;
      throw new ConflictError(`run ${runId} cannot be prepared from ${current.status}`);
    }
    if (!current.conversation) throw new ConflictError('run is not awaiting thread preparation');
    if (
      current.conversation.conversationId !== binding.conversationId ||
      current.conversation.messageId !== binding.messageId
    ) {
      throw new ConflictError('run thread binding changed before preparation');
    }
    const preparedBinding = validateConversationBinding(binding, true);
    const request = this.parse(rawExecutionRequest);
    const canonical = stableJson(request);
    const executionHash = sha256(canonical);
    const ownerHash = sha256(ownerId).slice(0, 32);
    const executionInput = await this.options.artifacts.putJson(
      `owners/${ownerHash}/runs/${runId}/execution-${executionHash}.json`,
      request,
    );
    if (current.executionInput) {
      if (
        current.executionInput.sha256 === executionInput.sha256 &&
        sameConversation(current.conversation, preparedBinding)
      ) return current;
      throw new ConflictError('run was already prepared with different thread state');
    }
    return this.options.store.prepareConversation(runId, executionInput, preparedBinding);
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

  private parse(rawRequest: unknown): RunRequest {
    return parseRunRequest(rawRequest, {
      ...(this.options.allowedRepositoryHosts
        ? { allowedRepositoryHosts: this.options.allowedRepositoryHosts }
        : {}),
      ...(this.options.allowedSandboxModes
        ? { allowedSandboxModes: this.options.allowedSandboxModes }
        : {}),
    });
  }
}

function validateCapabilityOwner(value: string): string {
  if (!value.trim() || Buffer.byteLength(value, 'utf8') > 1_024) {
    throw new ValidationError('capability owner identity is invalid');
  }
  return value;
}

function validateConversationBinding(
  binding: ConversationRunBinding,
  prepared = false,
): ConversationRunBinding {
  if (!binding.conversationId || Buffer.byteLength(binding.conversationId, 'utf8') > 512) {
    throw new ValidationError('conversationId is invalid');
  }
  if (
    binding.messageId !== undefined &&
    (!binding.messageId || Buffer.byteLength(binding.messageId, 'utf8') > 512)
  ) {
    throw new ValidationError('messageId is invalid');
  }
  if (!binding.messageId && !binding.turnId) {
    throw new ValidationError('conversation binding requires a messageId or turnId');
  }
  if (prepared && !binding.messageId) throw new ValidationError('messageId is invalid');
  if (binding.turnId !== undefined && (!binding.turnId || Buffer.byteLength(binding.turnId, 'utf8') > 512)) {
    throw new ValidationError('turnId is invalid');
  }
  if (prepared && !binding.turnId) throw new ValidationError('turnId is invalid');
  if (prepared && (!Number.isInteger(binding.slice) || binding.slice! < 0 || binding.slice! > 10_000)) {
    throw new ValidationError('conversation slice is invalid');
  }
  if (binding.delivery !== undefined && !['interrupt', 'defer'].includes(binding.delivery)) {
    throw new ValidationError('conversation delivery is invalid');
  }
  if (binding.preferredMicrovmId && !/^[A-Za-z0-9._:-]{1,256}$/.test(binding.preferredMicrovmId)) {
    throw new ValidationError('preferred MicroVM ID is invalid');
  }
  if (binding.agentThreadId && !/^[A-Za-z0-9._:-]{1,256}$/.test(binding.agentThreadId)) {
    throw new ValidationError('agent thread ID is invalid');
  }
  for (const [label, artifact] of [
    ['continuation', binding.continuation],
    ['artifact catalog', binding.artifacts],
  ] as const) {
    if (artifact && (
      !artifact.bucket ||
      !artifact.key ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256)
    )) throw new ValidationError(`conversation ${label} artifact is invalid`);
  }
  return { ...binding };
}

function sameConversation(
  left: ConversationRunBinding | undefined,
  right: ConversationRunBinding,
): boolean {
  return Boolean(left && stableJson(left) === stableJson(right));
}

function validateThingBinding(binding: ThingRunBinding): ThingRunBinding {
  if (binding.version !== '1') throw new ValidationError('Thing run binding version must be "1"');
  if (!/^[A-Za-z0-9-]{1,128}$/.test(binding.thingId)) {
    throw new ValidationError('Thing run binding ID is invalid');
  }
  if (!Number.isSafeInteger(binding.revision) || binding.revision < 1) {
    throw new ValidationError('Thing run binding revision is invalid');
  }
  if (!/^[a-f0-9]{64}$/.test(binding.specHash)) {
    throw new ValidationError('Thing run binding spec hash is invalid');
  }
  if (!['test', 'manual', 'schedule'].includes(binding.invocation)) {
    throw new ValidationError('Thing run binding invocation is invalid');
  }
  if (binding.invocation === 'schedule' && !binding.scheduledAt) {
    throw new ValidationError('scheduled Thing run binding requires scheduledAt');
  }
  if (binding.scheduledAt !== undefined && !Number.isFinite(Date.parse(binding.scheduledAt))) {
    throw new ValidationError('Thing run binding scheduledAt is invalid');
  }
  return { ...binding };
}

function assertSameThing(
  existing: ThingRunBinding | undefined,
  requested: ThingRunBinding | undefined,
): void {
  if (stableJson(existing) !== stableJson(requested)) {
    throw new ConflictError('the idempotency key was already used for a different Thing occurrence');
  }
}

function assertSameConversationBinding(
  existing: ConversationRunBinding | undefined,
  requested: ConversationRunBinding | undefined,
): void {
  const same = existing && requested
    ? existing.conversationId === requested.conversationId &&
      existing.messageId === requested.messageId &&
      existing.delivery === requested.delivery
    : existing === requested;
  if (!same) {
    throw new ConflictError('the idempotency key was already used for a different thread occurrence');
  }
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
