import { savedAgentActivity } from './saved-agent-activity.js';
import { randomUUID } from 'node:crypto';
import type { ConversationRunBinding, RunRecord, RunRequest, SandboxMode } from '../domain/contracts.js';
import { canonicalJson as stableJson, sha256Hex as sha256 } from '../domain/json.js';
import { isTerminal } from '../domain/state.js';
import { parseRunRequest, ValidationError } from '../domain/validation.js';
import { ConflictError, NotFoundError } from './errors.js';
import type {
  ArtifactStore,
  Clock,
  ExecutionController,
  IdGenerator,
  RunQueue,
  RunStore,
} from './ports.js';
import {
  assertOwner,
  assertSameSubmission,
  conversationPreparationDecision,
  createQueuedRun,
  deterministicRunId,
  reusePreparedConversation,
  runInputKey,
  validateIdempotencyKey,
  validateOwner,
  type SubmitOptions,
} from './run-planning.js';

export { ConflictError, ForbiddenError, NotFoundError } from './errors.js';
export { validateOwner, type SubmitOptions } from './run-planning.js';

const DEFAULT_RETENTION_SECONDS = 30 * 24 * 60 * 60;
const defaultIds: IdGenerator = { random: () => randomUUID(), deterministic: deterministicRunId };

export interface RunServiceOptions {
  store: RunStore;
  artifacts: Pick<ArtifactStore, 'putJson' | 'getStream'>;
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
    validateOwner(ownerId);
    return this.ids.deterministic(ownerId, validateIdempotencyKey(idempotencyKey));
  }

  /** Returns the exact canonical request accepted by this deployment. */
  public canonicalize(rawRequest: unknown): RunRequest {
    return this.parse(rawRequest);
  }

  public async submit(ownerId: string, rawRequest: unknown, submit: SubmitOptions = {}): Promise<RunRecord> {
    validateOwner(ownerId);
    const request = this.parse(rawRequest);
    const canonical = stableJson(request);
    const requestHash = sha256(canonical);
    const runId = submit.idempotencyKey
      ? this.idFor(ownerId, submit.idempotencyKey)
      : this.ids.random();

    if (submit.idempotencyKey) {
      const existing = await this.options.store.get(runId);
      if (existing) {
        const same = assertSameSubmission(existing, requestHash, submit);
        // SQS is a wake-up hint, not the source of truth. Re-nudging a still-queued run is safe
        // and repairs the create-record/enqueue crash window.
        if (same.status === 'queued' && submit.enqueue !== false) {
          await this.enqueue(same.runId, submit.traceId);
        }
        return same;
      }
    }

    const input = await this.options.artifacts.putJson(
      runInputKey(ownerId, runId, requestHash, 'input'),
      request,
    );
    const now = this.clock.now();
    const record = createQueuedRun({
      ownerId, runId, request, requestHash, input, submit, now, retentionSeconds: this.retentionSeconds,
    });

    const created = await this.options.store.create(record);
    if (!created.created) {
      return assertSameSubmission(created.record, requestHash, submit);
    }

    // An enqueue failure leaves the durable Run queued for an idempotent retry
    // or the scheduled reconciler to wake without changing its identity.
    if (submit.enqueue !== false) await this.enqueue(runId, submit.traceId);
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
    const decision = conversationPreparationDecision(current, binding, runId);
    if (decision.kind === 'reuse') return current;
    const preparedBinding = decision.binding;
    const request = this.parse(rawExecutionRequest);
    const canonical = stableJson(request);
    const executionHash = sha256(canonical);
    const executionInput = await this.options.artifacts.putJson(
      runInputKey(ownerId, runId, executionHash, 'execution'),
      request,
    );
    if (reusePreparedConversation(current, executionInput, preparedBinding)) return current;
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

  public async savedActivity(ownerId: string, runId: string) {
    const run = await this.get(ownerId, runId);
    if (!isTerminal(run.status) || !run.result?.events) throw new ConflictError('saved Activity is not available yet');
    return savedAgentActivity(run, run.result.events, await this.options.artifacts.getStream(run.result.events));
  }

  public async cancel(ownerId: string, runId: string): Promise<RunRecord> {
    const current = await this.get(ownerId, runId);
    if (isTerminal(current.status)) return current;
    if (current.status === 'queued') {
      return this.options.store.transition(runId, ['queued'], 'cancelled', {
        cancelRequestedAt: this.clock.now().toISOString(),
      });
    }
    const cancelling = current.status === 'cancelling'
      ? current
      : await this.options.store.transition(
          runId,
          ['dispatching', 'running'],
          'cancelling',
          { cancelRequestedAt: this.clock.now().toISOString() },
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
