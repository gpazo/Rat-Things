import { randomUUID } from 'node:crypto';
import type { SandboxMode } from '../domain/contracts.js';
import { canonicalJson as stableJson, sha256Hex as sha256 } from '../domain/json.js';
import type {
  PublicThing,
  PublicThingSummary,
  PublicThingVersion,
  ScheduledThingResult,
  ThingExplanation,
  ThingRecord,
  ThingRevision,
  ThingOccurrenceRun,
  ThingSpec,
  ThingInvocationKind,
  ThingVersionRecord,
} from '../domain/things.js';
import { ValidationError, type ValidationOptions } from '../domain/validation.js';
import {
  parseThingSpec,
  parseThingVersionInput,
  parsePublishThingInput,
  parseScheduledInvocation,
  validateThingId,
  validateRevision,
} from '../domain/thing-spec.js';
import type { ArtifactStore, Clock, ThingScheduler, ThingStore } from './ports.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  validateOwner,
  type RunService,
} from './run-service.js';
import {
  assertDraftRevision,
  assertPublishDraft,
  assertPublishTestRun,
  compileThingOccurrence,
  createThingRecord,
  revisionPointer,
  scheduledThingDecision,
  synchronizedTriggerState,
  syncingState,
  thingSpecKey,
  thingTriggerAction,
  versionRecord,
} from './thing-planning.js';
import { explainThing, publicThingSummary } from './thing-projection.js';

// Preserve existing import paths for consumers of the service module.
export { compileThingSpec, parseThingSpec } from '../domain/thing-spec.js';
export { publicThingSummary } from './thing-projection.js';

export interface ThingServiceOptions {
  store: ThingStore;
  artifacts: ArtifactStore;
  runs: Pick<RunService, 'submit' | 'get'>;
  scheduler: ThingScheduler;
  allowedRepositoryHosts?: string[];
  allowedSandboxModes?: SandboxMode[];
  clock?: Clock;
  randomId?: () => string;
}

/** Sequences Thing lifecycle effects; validation, compilation, and decisions operate on values. */
export class ThingService {
  private readonly clock: Clock;
  private readonly randomId: () => string;

  public constructor(private readonly options: ThingServiceOptions) {
    this.clock = options.clock ?? { now: () => new Date() };
    this.randomId = options.randomId ?? randomUUID;
  }

  /** Creation always produces draft revision 1 and never activates external work. */
  public async create(ownerId: string, raw: unknown): Promise<ThingRecord> {
    validateOwner(ownerId);
    const spec = parseThingSpec(raw, this.validationOptions());
    const thingId = this.randomId();
    validateThingId(thingId);
    const timestamp = this.clock.now().toISOString();
    const stored = await this.storeSpec(ownerId, thingId, 1, spec);
    const draft = revisionPointer(1, spec, stored, timestamp);
    const record = createThingRecord(ownerId, thingId, draft, timestamp);
    await this.options.store.create(record, versionRecord(thingId, draft));
    return record;
  }

  /** Editing appends an immutable revision and moves only the draft pointer. */
  public async addVersion(ownerId: string, thingId: string, raw: unknown): Promise<ThingRecord> {
    const current = await this.get(ownerId, thingId);
    if (current.status === 'archived') throw new ConflictError('archived Things cannot be changed');
    const input = parseThingVersionInput(raw, this.validationOptions());
    assertDraftRevision(current.draft, input.expectedDraftRevision);
    const revision = current.draft.revision + 1;
    const stored = await this.storeSpec(ownerId, thingId, revision, input.spec);
    const timestamp = this.clock.now().toISOString();
    const draft = revisionPointer(revision, input.spec, stored, timestamp);
    return concurrentThingMutation(this.options.store.addVersion(
      ownerId,
      thingId,
      draft,
      versionRecord(thingId, draft),
      input.expectedDraftRevision,
      timestamp,
    ));
  }

  public async get(ownerId: string, thingId: string): Promise<ThingRecord> {
    validateOwner(ownerId);
    validateThingId(thingId);
    const record = await this.options.store.get(thingId);
    if (!record) throw new NotFoundError('Thing not found');
    if (record.ownerId !== ownerId) throw new ForbiddenError('Thing belongs to another owner');
    return record;
  }

  public async getPublic(ownerId: string, thingId: string): Promise<PublicThing> {
    const record = await this.get(ownerId, thingId);
    const draft = await this.publicVersion(record, record.draft);
    const active = record.active
      ? record.active.revision === record.draft.revision
        ? draft
        : await this.publicVersion(record, record.active)
      : undefined;
    const {
      draft: _draftSummary,
      active: _activeSummary,
      ...summary
    } = publicThingSummary(record);
    return {
      ...summary,
      draft,
      ...(active ? { active } : {}),
    };
  }

  public async getVersion(
    ownerId: string,
    thingId: string,
    revision: number,
  ): Promise<PublicThingVersion> {
    const record = await this.get(ownerId, thingId);
    validateRevision(revision);
    const version = await this.options.store.getVersion(thingId, revision);
    if (!version) throw new NotFoundError('Thing version not found');
    return this.publicVersion(record, version);
  }

  public async listVersions(
    ownerId: string,
    thingId: string,
  ): Promise<Array<Omit<ThingVersionRecord, 'spec'>>> {
    await this.get(ownerId, thingId);
    return (await this.options.store.listVersions(thingId)).map(({ spec: _spec, ...version }) => version);
  }

  public async list(
    ownerId: string,
    limit = 25,
    nextToken?: string,
    includeArchived = false,
  ): Promise<{ items: PublicThingSummary[]; nextToken?: string }> {
    validateOwner(ownerId);
    const bounded = Math.max(1, Math.min(100, Math.floor(limit)));
    try {
      const result = await this.options.store.list(ownerId, bounded, nextToken, includeArchived);
      return { ...result, items: result.items.map(publicThingSummary) };
    } catch (error) {
      if (error instanceof Error && error.message === 'invalid pagination token') {
        throw new ValidationError('nextToken is invalid');
      }
      throw error;
    }
  }

  /** Publishing pins the current draft as production and activates its trigger. */
  public async publish(ownerId: string, thingId: string, raw: unknown): Promise<ThingRecord> {
    const current = await this.get(ownerId, thingId);
    if (current.status === 'archived') throw new ConflictError('archived Things cannot be published');
    const input = parsePublishThingInput(raw);
    assertPublishDraft(current.draft, input);
    const testRun = await this.options.runs.get(ownerId, input.testRunId);
    assertPublishTestRun(thingId, current.draft, testRun, input.testRunId);
    const timestamp = this.clock.now().toISOString();
    const published = await concurrentThingMutation(this.options.store.publish(
      ownerId,
      thingId,
      current.draft,
      current.status,
      syncingState(current.draft.revision, timestamp),
      timestamp,
    ));
    return this.reconcileTrigger(published);
  }

  public async pause(ownerId: string, thingId: string): Promise<ThingRecord> {
    const current = await this.get(ownerId, thingId);
    if (current.status === 'draft') throw new ConflictError('a draft Thing has no published revision to pause');
    if (current.status === 'archived') throw new ConflictError('archived Things cannot be paused');
    return this.changeStatus(current, 'paused');
  }

  public async resume(ownerId: string, thingId: string): Promise<ThingRecord> {
    const current = await this.get(ownerId, thingId);
    if (current.status === 'draft') throw new ConflictError('a draft Thing must be published before it can resume');
    if (current.status === 'archived') throw new ConflictError('archived Things cannot resume');
    return this.changeStatus(current, 'active');
  }

  public async archive(ownerId: string, thingId: string): Promise<ThingRecord> {
    return this.changeStatus(await this.get(ownerId, thingId), 'archived');
  }

  /** Test always runs the latest draft and never changes the published pointer. */
  public async test(
    ownerId: string,
    thingId: string,
    idempotencyKey = `test:${thingId}:${this.randomId()}`,
  ): Promise<ThingOccurrenceRun> {
    const thing = await this.get(ownerId, thingId);
    if (thing.status === 'archived') throw new ConflictError('archived Things cannot be tested');
    return this.submitOccurrence(thing, thing.draft, 'test', undefined, idempotencyKey);
  }

  /** Explicit production invocation always runs the pinned active revision. */
  public async runNow(
    ownerId: string,
    thingId: string,
    idempotencyKey = `manual:${thingId}:${this.randomId()}`,
  ): Promise<ThingOccurrenceRun> {
    const thing = await this.get(ownerId, thingId);
    if (thing.status === 'archived') throw new ConflictError('archived Things cannot run');
    if (!thing.active) throw new ConflictError('the Thing has no published revision; test or publish the draft first');
    return this.submitOccurrence(thing, thing.active, 'manual', undefined, idempotencyKey);
  }

  /** Trusted Scheduler entrypoint. Stale or inactive deliveries are acknowledged without a run. */
  public async runScheduled(raw: unknown): Promise<ScheduledThingResult> {
    const invocation = parseScheduledInvocation(raw);
    const thing = await this.options.store.get(invocation.thingId);
    const decision = scheduledThingDecision(thing, invocation);
    if (decision.kind === 'ignore') return { accepted: false, reason: decision.reason };
    const run = await this.submitOccurrence(
      decision.thing,
      decision.revision,
      'schedule',
      invocation.scheduledAt,
      decision.idempotencyKey,
    );
    return { accepted: true, run: { runId: run.runId, status: run.status } };
  }

  public async explain(
    ownerId: string,
    thingId: string,
    target: 'draft' | 'active' = 'draft',
  ): Promise<ThingExplanation> {
    const thing = await this.getPublic(ownerId, thingId);
    return explainThing(thing, target);
  }

  private async submitOccurrence(
    thing: ThingRecord,
    revision: ThingRevision,
    invocation: ThingInvocationKind,
    scheduledAt: string | undefined,
    idempotencyKey: string,
  ): Promise<ThingOccurrenceRun> {
    const spec = await this.loadSpec(thing, revision);
    const submission = compileThingOccurrence({
      thing,
      revision,
      spec,
      invocation,
      scheduledAt,
      idempotencyKey,
    });
    const run = await this.options.runs.submit(thing.ownerId, submission.request, submission.options);
    if (revision.revision === thing.active?.revision) {
      await this.options.store.recordRun(
        thing.thingId,
        revision.revision,
        invocation === 'schedule' ? ['active'] : ['active', 'paused'],
        scheduledAt ?? this.clock.now().toISOString(),
        run.runId,
        this.clock.now().toISOString(),
      );
    }
    if (!run.thing) throw new Error('Thing occurrence Run was stored without revision evidence');
    return { ...run, thing: run.thing };
  }

  private async changeStatus(
    current: ThingRecord,
    status: 'paused' | 'active' | 'archived',
  ): Promise<ThingRecord> {
    const timestamp = this.clock.now().toISOString();
    const updated = await concurrentThingMutation(this.options.store.setStatus(
      current.ownerId,
      current.thingId,
      [current.status],
      status,
      syncingState(current.active?.revision, timestamp),
      timestamp,
    ));
    return this.reconcileTrigger(updated);
  }

  private async reconcileTrigger(record: ThingRecord): Promise<ThingRecord> {
    const timestamp = this.clock.now().toISOString();
    try {
      const action = thingTriggerAction(record);
      switch (action.kind) {
        case 'remove':
          await this.options.scheduler.remove(action.thingId);
          break;
        case 'upsert':
          await this.options.scheduler.upsert(action.target, action.enabled);
          break;
      }
      const state = synchronizedTriggerState(record, timestamp);
      // Propagate asynchronous state-write conflicts without treating them as scheduler failures.
      return concurrentThingMutation(this.options.store.setTriggerState(
        record.thingId,
        record.active?.revision,
        state,
        timestamp,
      ));
    } catch (error) {
      const message = boundedError(error);
      try {
        await this.options.store.setTriggerState(
          record.thingId,
          record.active?.revision,
          {
            status: 'error',
            ...(record.active ? { revision: record.active.revision } : {}),
            updatedAt: timestamp,
            error: message,
          },
          timestamp,
        );
      } catch {
        // Preserve the scheduling failure; a concurrent lifecycle operation won the state race.
      }
      throw new Error(`Thing trigger synchronization failed: ${message}`);
    }
  }

  private async storeSpec(
    ownerId: string,
    thingId: string,
    revision: number,
    spec: ThingSpec,
  ): Promise<{ reference: ThingRevision['spec']; hash: string }> {
    const canonical = stableJson(spec);
    const hash = sha256(canonical);
    const reference = await this.options.artifacts.putJson(
      thingSpecKey(ownerId, thingId, revision, hash),
      spec,
    );
    return { reference, hash };
  }

  private async publicVersion(
    record: ThingRecord,
    revision: ThingRevision,
  ): Promise<PublicThingVersion> {
    return {
      ...versionRecord(record.thingId, revision),
      spec: await this.loadSpec(record, revision),
    };
  }

  private async loadSpec(record: ThingRecord, revision: ThingRevision): Promise<ThingSpec> {
    const expectedKey = thingSpecKey(record.ownerId, record.thingId, revision.revision, revision.specHash);
    if (revision.spec.key !== expectedKey) {
      throw new Error('Thing spec reference is outside its owner scope');
    }
    const stored = await this.options.artifacts.getJson<unknown>(revision.spec);
    const spec = parseThingSpec(stored, this.validationOptions());
    if (sha256(stableJson(spec)) !== revision.specHash) {
      throw new Error('Thing spec does not match its stored digest');
    }
    return spec;
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

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 512) || 'unknown error';
}

async function concurrentThingMutation<T>(operation: Promise<T>): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    if (error instanceof Error && error.message === 'Thing changed concurrently') {
      throw new ConflictError(error.message);
    }
    throw error;
  }
}
