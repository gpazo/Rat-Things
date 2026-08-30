import { randomUUID } from 'node:crypto';
import type { RunRequest, SandboxMode, ThingRunBinding } from '../domain/contracts.js';
import { canonicalJson as stableJson, sha256Hex as sha256 } from '../domain/json.js';
import type {
  PublicThing,
  PublicThingSummary,
  PublicThingVersion,
  ScheduledThingInvocation,
  ScheduledThingResult,
  ThingDiagnostic,
  ThingExplanation,
  ThingRecord,
  ThingRevision,
  ThingOccurrenceRun,
  ThingSpec,
  ThingInvocationKind,
  ThingTrigger,
  ThingTriggerState,
  ThingVersionRecord,
} from '../domain/things.js';
import {
  isRecord,
  isoDateTime,
  parseRunRequest,
  rejectUnknown,
  requiredTrimmedString,
  ValidationError,
} from '../domain/validation.js';
import type { ArtifactStore, Clock, ThingScheduler, ThingStore } from './ports.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  validateOwner,
  type RunService,
} from './run-service.js';

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

interface ParsedThingVersionInput {
  expectedDraftRevision: number;
  spec: ThingSpec;
}

interface ParsedPublishThingInput {
  expectedDraftRevision: number;
  expectedSpecHash: string;
  testRunId: string;
}

/** Product-facing lifecycle and compiler for reusable cloud-agent definitions. */
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
    const record: ThingRecord = {
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
    await this.options.store.create(record, versionRecord(thingId, draft));
    return record;
  }

  /** Editing appends an immutable revision and moves only the draft pointer. */
  public async addVersion(ownerId: string, thingId: string, raw: unknown): Promise<ThingRecord> {
    const current = await this.get(ownerId, thingId);
    if (current.status === 'archived') throw new ConflictError('archived Things cannot be changed');
    const input = this.parseVersionInput(raw);
    if (input.expectedDraftRevision !== current.draft.revision) {
      throw new ConflictError(
        `Thing draft changed; expected ${input.expectedDraftRevision}, current ${current.draft.revision}`,
      );
    }
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
    const input = this.parsePublishInput(raw);
    if (input.expectedDraftRevision !== current.draft.revision) {
      throw new ConflictError(
        `Thing draft changed; expected ${input.expectedDraftRevision}, current ${current.draft.revision}`,
      );
    }
    if (input.expectedSpecHash !== current.draft.specHash) {
      throw new ConflictError('Thing draft content changed after the tested revision was selected');
    }
    const testRun = await this.options.runs.get(ownerId, input.testRunId);
    if (testRun.status !== 'succeeded') {
      throw new ConflictError(`Thing test Run ${input.testRunId} has not succeeded`);
    }
    if (
      testRun.thing?.thingId !== thingId ||
      testRun.thing.revision !== current.draft.revision ||
      testRun.thing.specHash !== current.draft.specHash ||
      testRun.thing.invocation !== 'test'
    ) {
      throw new ConflictError('Thing test Run does not prove this exact draft revision');
    }
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
    const timestamp = this.clock.now().toISOString();
    const paused = await concurrentThingMutation(this.options.store.setStatus(
      ownerId,
      thingId,
      [current.status],
      'paused',
      syncingState(current.active?.revision, timestamp),
      timestamp,
    ));
    return this.reconcileTrigger(paused);
  }

  public async resume(ownerId: string, thingId: string): Promise<ThingRecord> {
    const current = await this.get(ownerId, thingId);
    if (current.status === 'draft') throw new ConflictError('a draft Thing must be published before it can resume');
    if (current.status === 'archived') throw new ConflictError('archived Things cannot resume');
    const timestamp = this.clock.now().toISOString();
    const resumed = await concurrentThingMutation(this.options.store.setStatus(
      ownerId,
      thingId,
      [current.status],
      'active',
      syncingState(current.active?.revision, timestamp),
      timestamp,
    ));
    return this.reconcileTrigger(resumed);
  }

  public async archive(ownerId: string, thingId: string): Promise<ThingRecord> {
    const current = await this.get(ownerId, thingId);
    const timestamp = this.clock.now().toISOString();
    const archived = await concurrentThingMutation(this.options.store.setStatus(
      ownerId,
      thingId,
      [current.status],
      'archived',
      syncingState(current.active?.revision, timestamp),
      timestamp,
    ));
    return this.reconcileTrigger(archived);
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
    if (!thing) return { accepted: false, reason: 'missing' };
    if (thing.status !== 'active') return { accepted: false, reason: 'not-active' };
    if (!thing.active || thing.active.revision !== invocation.revision) {
      return { accepted: false, reason: 'stale-revision' };
    }
    if (thing.active.trigger.kind !== 'schedule') {
      return { accepted: false, reason: 'not-scheduled' };
    }
    const idempotencyKey = `thing:${thing.thingId}:${thing.active.revision}:${invocation.scheduledAt}`;
    const run = await this.submitOccurrence(
      thing,
      thing.active,
      'schedule',
      invocation.scheduledAt,
      idempotencyKey,
    );
    return { accepted: true, run: { runId: run.runId, status: run.status } };
  }

  public async explain(
    ownerId: string,
    thingId: string,
    target: 'draft' | 'active' = 'draft',
  ): Promise<ThingExplanation> {
    const thing = await this.getPublic(ownerId, thingId);
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

  private async submitOccurrence(
    thing: ThingRecord,
    revision: ThingRevision,
    invocation: ThingInvocationKind,
    scheduledAt: string | undefined,
    idempotencyKey: string,
  ): Promise<ThingOccurrenceRun> {
    const spec = await this.loadSpec(thing, revision);
    const request = compileThingSpec(spec);
    const metadata = {
      ...request.metadata,
      thingId: thing.thingId,
      thingName: revision.name,
      thingRevision: revision.revision,
      thingInvocation: invocation,
      ...(scheduledAt ? { scheduledAt } : {}),
    };
    const occurrenceId = scheduledAt ?? `${invocation}:${sha256(idempotencyKey).slice(0, 32)}`;
    const evidence: ThingRunBinding = {
      version: '1',
      thingId: thing.thingId,
      revision: revision.revision,
      specHash: revision.specHash,
      invocation,
      ...(scheduledAt ? { scheduledAt } : {}),
    };
    const run = await this.options.runs.submit(thing.ownerId, {
      ...request,
      source: {
        kind: 'api',
        requestId: `thing:${thing.thingId}:${revision.revision}:${occurrenceId}`,
      },
      metadata,
    }, {
      idempotencyKey,
      capabilityOwnerId: thing.ownerId,
      provenance: {
        actor: { kind: 'system', id: `thing:${thing.thingId}`, provider: 'api' },
        credentialSubject: { kind: 'runtime', id: thing.ownerId },
      },
      thing: evidence,
    });
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

  private async reconcileTrigger(record: ThingRecord): Promise<ThingRecord> {
    const timestamp = this.clock.now().toISOString();
    try {
      if (record.status === 'archived' || !record.active || record.active.trigger.kind === 'manual') {
        await this.options.scheduler.remove(record.thingId);
      } else {
        await this.options.scheduler.upsert({
          thingId: record.thingId,
          revision: record.active.revision,
          trigger: record.active.trigger,
        }, record.status === 'active');
      }
      const state: ThingTriggerState = record.status === 'active'
        ? {
          status: 'ready',
          ...(record.active ? { revision: record.active.revision } : {}),
          updatedAt: timestamp,
        }
        : record.status === 'paused'
          ? {
            status: 'paused',
            ...(record.active ? { revision: record.active.revision } : {}),
            updatedAt: timestamp,
          }
          : { status: 'inactive', updatedAt: timestamp };
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

  private parseVersionInput(raw: unknown): ParsedThingVersionInput {
    if (!isRecord(raw)) throw new ValidationError('Thing version request must be an object');
    rejectUnknown(raw, ['version', 'expectedDraftRevision', 'spec'], 'Thing version request');
    if (raw.version !== '1') throw new ValidationError('Thing version request version must be "1"');
    validateRevision(raw.expectedDraftRevision);
    return {
      expectedDraftRevision: raw.expectedDraftRevision,
      spec: parseThingSpec(raw.spec, this.validationOptions()),
    };
  }

  private parsePublishInput(raw: unknown): ParsedPublishThingInput {
    if (!isRecord(raw)) throw new ValidationError('Thing publish request must be an object');
    rejectUnknown(
      raw,
      ['version', 'expectedDraftRevision', 'expectedSpecHash', 'testRunId'],
      'Thing publish request',
    );
    if (raw.version !== '1') throw new ValidationError('Thing publish request version must be "1"');
    validateRevision(raw.expectedDraftRevision);
    if (typeof raw.expectedSpecHash !== 'string' || !/^[a-f0-9]{64}$/.test(raw.expectedSpecHash)) {
      throw new ValidationError('Thing publish request expectedSpecHash must be a SHA-256 digest');
    }
    if (typeof raw.testRunId !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(raw.testRunId)) {
      throw new ValidationError('Thing publish request testRunId is invalid');
    }
    return {
      expectedDraftRevision: raw.expectedDraftRevision,
      expectedSpecHash: raw.expectedSpecHash,
      testRunId: raw.testRunId,
    };
  }

  private async storeSpec(
    ownerId: string,
    thingId: string,
    revision: number,
    spec: ThingSpec,
  ): Promise<{ reference: ThingRevision['spec']; hash: string }> {
    const canonical = stableJson(spec);
    const hash = sha256(canonical);
    const ownerHash = sha256(ownerId).slice(0, 32);
    const reference = await this.options.artifacts.putJson(
      `owners/${ownerHash}/things/${thingId}/versions/${revision}-${hash}.json`,
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
    const ownerHash = sha256(record.ownerId).slice(0, 32);
    const expectedKey = `owners/${ownerHash}/things/${record.thingId}/versions/${revision.revision}-${revision.specHash}.json`;
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

export function parseThingSpec(
  raw: unknown,
  validationOptions: { allowedRepositoryHosts?: string[]; allowedSandboxModes?: SandboxMode[] } = {},
): ThingSpec {
  if (!isRecord(raw)) throw new ValidationError('Thing spec must be an object');
  rejectUnknown(
    raw,
    ['version', 'name', 'goal', 'trigger', 'repository', 'agent', 'connections', 'execution', 'deliver', 'metadata'],
    'Thing spec',
  );
  if (raw.version !== '1') throw new ValidationError('Thing spec version must be "1"');
  const name = requiredTrimmedString(raw.name, 'Thing spec name', 128);
  const trigger = parseTrigger(raw.trigger);
  if (isRecord(raw.repository) && raw.repository.credentialSecretArn !== undefined) {
    throw new ValidationError(
      'Thing spec repository cannot select a credential secret; use a deployment-owned connection',
    );
  }
  const requestInput: Record<string, unknown> = {
    version: '1',
    prompt: raw.goal,
    ...(raw.repository !== undefined ? { repository: raw.repository } : {}),
    ...(raw.agent !== undefined ? { agent: raw.agent } : {}),
    ...(raw.connections !== undefined ? { integrations: integrationInput(raw.connections) } : {}),
    ...(raw.execution !== undefined ? { execution: raw.execution } : {}),
    ...(raw.deliver !== undefined ? { destinations: raw.deliver } : {}),
    ...(raw.metadata !== undefined ? { metadata: raw.metadata } : {}),
  };
  const request = parseRunRequest(requestInput, validationOptions);
  if (request.destinations?.some((destination) => destination.kind === 'source')) {
    throw new ValidationError('Thing spec cannot use the source delivery destination');
  }
  for (const reserved of ['thingId', 'thingName', 'thingRevision', 'thingInvocation', 'scheduledAt']) {
    if (request.metadata?.[reserved] !== undefined) {
      throw new ValidationError(`Thing spec metadata uses reserved key ${reserved}`);
    }
  }
  return {
    version: '1',
    name,
    goal: request.prompt,
    trigger,
    ...(request.repository ? { repository: request.repository } : {}),
    ...(request.agent ? { agent: request.agent } : {}),
    ...(request.integrations ? {
      connections: {
        ...(request.integrations.connectionSet ? { set: request.integrations.connectionSet } : {}),
        ...(request.integrations.connections ? {
          accounts: request.integrations.connections.map((connection) => ({
            account: connection.connection,
            ...(connection.preset ? { access: connection.preset } : {}),
            ...(connection.allowOperations ? { allowOperations: connection.allowOperations } : {}),
            ...(connection.denyOperations ? { denyOperations: connection.denyOperations } : {}),
          })),
        } : {}),
      },
    } : {}),
    ...(request.execution ? { execution: request.execution } : {}),
    ...(request.destinations ? { deliver: request.destinations } : {}),
    ...(request.metadata ? { metadata: request.metadata } : {}),
  };
}

export function compileThingSpec(spec: ThingSpec): RunRequest {
  return {
    version: '1',
    prompt: spec.goal,
    ...(spec.repository ? { repository: spec.repository } : {}),
    ...(spec.agent ? { agent: spec.agent } : {}),
    ...(spec.connections ? {
      integrations: {
        ...(spec.connections.set ? { connectionSet: spec.connections.set } : {}),
        ...(spec.connections.accounts ? {
          connections: spec.connections.accounts.map((account) => ({
            connection: account.account,
            ...(account.access ? { preset: account.access } : {}),
            ...(account.allowOperations ? { allowOperations: account.allowOperations } : {}),
            ...(account.denyOperations ? { denyOperations: account.denyOperations } : {}),
          })),
        } : {}),
      },
    } : {}),
    ...(spec.execution ? { execution: spec.execution } : {}),
    ...(spec.deliver ? { destinations: spec.deliver } : {}),
    ...(spec.metadata ? { metadata: spec.metadata } : {}),
  };
}

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

function integrationInput(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new ValidationError('Thing spec connections must be an object');
  rejectUnknown(value, ['set', 'accounts'], 'Thing spec connections');
  let accounts: unknown;
  if (value.accounts !== undefined) {
    if (!Array.isArray(value.accounts)) {
      throw new ValidationError('Thing spec connections.accounts must be an array');
    }
    accounts = value.accounts.map((candidate, index) => {
      if (!isRecord(candidate)) {
        throw new ValidationError(`Thing spec connections.accounts[${index}] must be an object`);
      }
      rejectUnknown(
        candidate,
        ['account', 'access', 'allowOperations', 'denyOperations'],
        `Thing spec connections.accounts[${index}]`,
      );
      return {
        connection: candidate.account,
        ...(candidate.access !== undefined ? { preset: candidate.access } : {}),
        ...(candidate.allowOperations !== undefined
          ? { allowOperations: candidate.allowOperations }
          : {}),
        ...(candidate.denyOperations !== undefined
          ? { denyOperations: candidate.denyOperations }
          : {}),
      };
    });
  }
  return {
    ...(value.set !== undefined ? { connectionSet: value.set } : {}),
    ...(accounts !== undefined ? { connections: accounts } : {}),
  };
}

function parseTrigger(value: unknown): ThingTrigger {
  if (!isRecord(value)) throw new ValidationError('Thing spec trigger must be an object');
  if (value.kind === 'manual') {
    rejectUnknown(value, ['kind'], 'Thing spec manual trigger');
    return { kind: 'manual' };
  }
  if (value.kind !== 'schedule') {
    throw new ValidationError('Thing spec trigger.kind must be manual or schedule');
  }
  rejectUnknown(value, ['kind', 'expression', 'timezone'], 'Thing spec schedule trigger');
  const expression = scheduleExpression(value.expression);
  const timezone = value.timezone === undefined
    ? undefined
    : timeZone(value.timezone, 'Thing spec trigger.timezone');
  return {
    kind: 'schedule',
    expression,
    ...(timezone ? { timezone } : {}),
  };
}

function scheduleExpression(value: unknown): string {
  if (typeof value !== 'string' || value.length > 256 || /[\r\n\0]/.test(value)) {
    throw new ValidationError('Thing schedule expression is invalid');
  }
  const trimmed = value.trim();
  const rate = /^rate\(\s*(\d+)\s+(minute|minutes|hour|hours|day|days)\s*\)$/i.exec(trimmed);
  if (rate) {
    const amount = Number(rate[1]);
    const unit = rate[2]?.toLowerCase();
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > 999_999) {
      throw new ValidationError('Thing rate value must be an integer from 1 through 999999');
    }
    if ((amount === 1) !== ['minute', 'hour', 'day'].includes(unit ?? '')) {
      throw new ValidationError('Thing rate expression must use a singular unit only when its value is 1');
    }
    return `rate(${amount} ${unit})`;
  }
  const cron = /^cron\((.*)\)$/i.exec(trimmed);
  if (!cron) {
    throw new ValidationError('Thing schedule expression must use rate(...) or cron(...)');
  }
  const fields = cron[1]?.trim().split(/\s+/) ?? [];
  if (fields.length !== 6 || fields.some((field) => !/^[A-Za-z0-9*?,/\-#LW]+$/.test(field))) {
    throw new ValidationError('Thing cron expression must contain six valid EventBridge fields');
  }
  const [minutes, hours, dayOfMonth, month, dayOfWeek, year] = fields as [string, string, string, string, string, string];
  simpleCronRange(minutes, 0, 59, 'minutes');
  simpleCronRange(hours, 0, 23, 'hours');
  simpleCronRange(month, 1, 12, 'month');
  simpleCronRange(year, 1970, 2199, 'year');
  if ((dayOfMonth === '?') === (dayOfWeek === '?')) {
    throw new ValidationError('Thing cron expression must use ? in exactly one day field');
  }
  return `cron(${fields.join(' ')})`;
}

function simpleCronRange(value: string, minimum: number, maximum: number, label: string): void {
  if (!/^\d+$/.test(value)) return;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ValidationError(`Thing cron ${label} field is out of range`);
  }
}

function timeZone(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /\s/.test(value)) {
    throw new ValidationError(`${label} must be an IANA time-zone name`);
  }
  const normalized = value.trim();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: normalized }).format(new Date(0));
  } catch {
    throw new ValidationError(`${label} must be an IANA time-zone name`);
  }
  return normalized;
}

function parseScheduledInvocation(raw: unknown): ScheduledThingInvocation {
  if (!isRecord(raw)) throw new ValidationError('Scheduled Thing invocation must be an object');
  rejectUnknown(raw, ['version', 'thingId', 'revision', 'scheduledAt'], 'Scheduled Thing invocation');
  if (raw.version !== '1') throw new ValidationError('Scheduled Thing invocation version must be "1"');
  if (typeof raw.thingId !== 'string') throw new ValidationError('Scheduled Thing invocation Thing ID is invalid');
  validateThingId(raw.thingId);
  validateRevision(raw.revision);
  return {
    version: '1',
    thingId: raw.thingId,
    revision: raw.revision,
    scheduledAt: isoDateTime(raw.scheduledAt, 'Scheduled Thing invocation scheduledAt'),
  };
}

function revisionPointer(
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

function versionRecord(thingId: string, revision: ThingRevision): ThingVersionRecord {
  return { version: '1', thingId, ...structuredClone(revision) };
}

function publicRevisionSummary(revision: ThingRevision): Omit<ThingRevision, 'spec'> {
  const { spec: _spec, ...visible } = revision;
  return structuredClone(visible);
}

function syncingState(revision: number | undefined, updatedAt: string): ThingTriggerState {
  return {
    status: 'syncing',
    ...(revision === undefined ? {} : { revision }),
    updatedAt,
  };
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

function validateThingId(thingId: string): void {
  if (!/^[A-Za-z0-9-]{1,128}$/.test(thingId)) throw new ValidationError('Thing ID is invalid');
}

function validateRevision(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new ValidationError('Thing revision must be a positive integer');
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
