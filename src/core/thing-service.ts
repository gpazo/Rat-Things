import { createHash, randomUUID } from 'node:crypto';
import type {
  RunRecord,
  RunRequest,
  SandboxMode,
} from '../domain/contracts.js';
import type {
  PublicThing,
  PublicThingSummary,
  PublicThingVersion,
  ThingDiagnostic,
  ThingExplanation,
  ThingRecord,
  ThingSpec,
  ThingStatus,
  ThingTickResult,
  ThingTrigger,
  ThingVersionRecord,
} from '../domain/things.js';
import { isRecord, parseRunRequest, ValidationError } from '../domain/validation.js';
import type { ArtifactStore, Clock, ThingStore } from './ports.js';
import { ConflictError, ForbiddenError, NotFoundError, type RunService } from './run-service.js';

export interface ThingServiceOptions {
  store: ThingStore;
  artifacts: ArtifactStore;
  runs: Pick<RunService, 'submit'>;
  allowedRepositoryHosts?: string[];
  allowedSandboxModes?: SandboxMode[];
  clock?: Clock;
  randomId?: () => string;
}

interface ParsedCreateThingInput {
  status: 'draft' | 'enabled';
  spec: ThingSpec;
}

interface ParsedThingVersionInput {
  expectedRevision: number;
  spec: ThingSpec;
}

/** Product-facing lifecycle and compiler for reusable agent automations. */
export class ThingService {
  private readonly clock: Clock;
  private readonly randomId: () => string;

  public constructor(private readonly options: ThingServiceOptions) {
    this.clock = options.clock ?? { now: () => new Date() };
    this.randomId = options.randomId ?? randomUUID;
  }

  public async create(ownerId: string, raw: unknown): Promise<ThingRecord> {
    validateOwner(ownerId);
    const input = this.parseCreateInput(raw);
    const thingId = this.randomId();
    validateThingId(thingId);
    const now = this.clock.now();
    const timestamp = now.toISOString();
    const revision = 1;
    const stored = await this.storeSpec(ownerId, thingId, revision, input.spec);
    const record: ThingRecord = {
      version: '1',
      thingId,
      ownerId,
      ownerCreated: `${ownerId}#${timestamp}#${thingId}`,
      revision,
      name: input.spec.name,
      status: input.status,
      trigger: input.spec.trigger,
      ...(input.status === 'enabled' && input.spec.trigger.kind === 'interval'
        ? { nextRunAt: firstOccurrence(now, input.spec.trigger) }
        : {}),
      spec: stored.reference,
      specHash: stored.hash,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.options.store.create(record, versionRecord(record));
    return record;
  }

  public async addVersion(ownerId: string, thingId: string, raw: unknown): Promise<ThingRecord> {
    const current = await this.get(ownerId, thingId);
    if (current.status === 'archived') throw new ConflictError('archived Things cannot be changed');
    const input = this.parseVersionInput(raw);
    if (input.expectedRevision !== current.revision) {
      throw new ConflictError(
        `Thing revision changed; expected ${input.expectedRevision}, current ${current.revision}`,
      );
    }
    const revision = current.revision + 1;
    const stored = await this.storeSpec(ownerId, thingId, revision, input.spec);
    const now = this.clock.now();
    const timestamp = now.toISOString();
    const { nextRunAt: _previousNextRunAt, ...currentWithoutSchedule } = current;
    const record: ThingRecord = {
      ...currentWithoutSchedule,
      revision,
      name: input.spec.name,
      trigger: input.spec.trigger,
      ...(current.status === 'enabled' && input.spec.trigger.kind === 'interval'
        ? { nextRunAt: firstOccurrence(now, input.spec.trigger) }
        : {}),
      spec: stored.reference,
      specHash: stored.hash,
      updatedAt: timestamp,
    };
    return concurrentThingMutation(
      this.options.store.addVersion(record, versionRecord(record), input.expectedRevision),
    );
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
    return { ...publicThingSummary(record), spec: await this.loadSpec(record, versionRecord(record)) };
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
    const spec = await this.loadSpec(record, version);
    const { spec: _reference, ...visible } = version;
    return { ...visible, spec };
  }

  public async listVersions(ownerId: string, thingId: string): Promise<Array<Omit<ThingVersionRecord, 'spec'>>> {
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
      return {
        ...result,
        items: result.items.map(publicThingSummary),
      };
    } catch (error) {
      if (error instanceof Error && error.message === 'invalid pagination token') {
        throw new ValidationError('nextToken is invalid');
      }
      throw error;
    }
  }

  public async enable(ownerId: string, thingId: string): Promise<ThingRecord> {
    const current = await this.get(ownerId, thingId);
    if (current.status === 'enabled') return current;
    if (current.status === 'archived') throw new ConflictError('archived Things cannot be enabled');
    const now = this.clock.now();
    return concurrentThingMutation(this.options.store.setStatus(
      ownerId,
      thingId,
      ['draft', 'paused'],
      'enabled',
      current.trigger.kind === 'interval' ? firstOccurrence(now, current.trigger) : undefined,
      now.toISOString(),
    ));
  }

  public async pause(ownerId: string, thingId: string): Promise<ThingRecord> {
    const current = await this.get(ownerId, thingId);
    if (current.status === 'paused') return current;
    if (current.status !== 'enabled') {
      throw new ConflictError(`only an enabled Thing can be paused; Thing is ${current.status}`);
    }
    return concurrentThingMutation(this.options.store.setStatus(
      ownerId,
      thingId,
      ['enabled'],
      'paused',
      current.nextRunAt,
      this.clock.now().toISOString(),
    ));
  }

  public async archive(ownerId: string, thingId: string): Promise<ThingRecord> {
    const current = await this.get(ownerId, thingId);
    if (current.status === 'archived') return current;
    return concurrentThingMutation(this.options.store.setStatus(
      ownerId,
      thingId,
      ['draft', 'enabled', 'paused'],
      'archived',
      undefined,
      this.clock.now().toISOString(),
    ));
  }

  /** Explicit invocation is also the safe test path for draft and paused Things. */
  public async runNow(
    ownerId: string,
    thingId: string,
    idempotencyKey = `manual:${thingId}:${this.randomId()}`,
  ): Promise<RunRecord> {
    const thing = await this.get(ownerId, thingId);
    if (thing.status === 'archived') throw new ConflictError('archived Things cannot run');
    return this.submitOccurrence(thing, undefined, idempotencyKey);
  }

  public async explain(ownerId: string, thingId: string): Promise<ThingExplanation> {
    const thing = await this.getPublic(ownerId, thingId);
    const diagnostics: ThingDiagnostic[] = [
      {
        id: 'spec.valid',
        status: 'pass',
        message: `Thing spec revision ${thing.revision} is valid and its digest matches storage.`,
      },
      lifecycleDiagnostic(thing.status),
      triggerDiagnostic(thing),
      connectionDiagnostic(thing.spec),
    ];
    return {
      version: '1',
      thing,
      compiledRun: compileThingSpec(thing.spec),
      runnable: thing.status !== 'archived',
      diagnostics,
    };
  }

  public async tick(limit = 100): Promise<ThingTickResult> {
    const now = this.clock.now();
    const due = await this.options.store.listDue(now.toISOString(), Math.max(1, Math.min(500, limit)));
    const result: ThingTickResult = { examined: due.length, scheduled: 0, runs: [] };
    const failures: Error[] = [];
    for (const thing of due) {
      const scheduledAt = thing.nextRunAt;
      if (!scheduledAt || thing.trigger.kind !== 'interval') {
        failures.push(new Error(`Thing ${thing.thingId} has an invalid scheduled trigger`));
        continue;
      }
      try {
        const run = await this.submitOccurrence(
          thing,
          scheduledAt,
          `thing:${thing.thingId}:${thing.revision}:${scheduledAt}`,
        );
        const advanced = await this.options.store.advance(
          thing.thingId,
          thing.revision,
          scheduledAt,
          nextOccurrence(scheduledAt, thing.trigger, now),
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
    if (failures.length > 0) throw new AggregateError(failures, 'one or more due Things failed');
    return result;
  }

  private async submitOccurrence(
    thing: ThingRecord,
    scheduledAt: string | undefined,
    idempotencyKey: string,
  ): Promise<RunRecord> {
    const spec = await this.loadSpec(thing, versionRecord(thing));
    const request = compileThingSpec(spec);
    const metadata = {
      ...request.metadata,
      thingId: thing.thingId,
      thingName: thing.name,
      thingRevision: thing.revision,
      ...(scheduledAt ? { scheduledAt } : {}),
    };
    const occurrenceId = scheduledAt ?? `manual:${sha256(idempotencyKey).slice(0, 32)}`;
    return this.options.runs.submit(thing.ownerId, {
      ...request,
      source: {
        kind: 'api',
        requestId: `thing:${thing.thingId}:${thing.revision}:${occurrenceId}`,
      },
      metadata,
    }, {
      idempotencyKey,
      capabilityOwnerId: thing.ownerId,
      provenance: {
        actor: { kind: 'system', id: `thing:${thing.thingId}`, provider: 'api' },
        credentialSubject: { kind: 'runtime', id: thing.ownerId },
      },
    });
  }

  private parseCreateInput(raw: unknown): ParsedCreateThingInput {
    if (!isRecord(raw)) throw new ValidationError('Thing create request must be an object');
    rejectUnknown(raw, ['version', 'status', 'spec'], 'Thing create request');
    if (raw.version !== '1') throw new ValidationError('Thing create request version must be "1"');
    const status = raw.status ?? 'draft';
    if (status !== 'draft' && status !== 'enabled') {
      throw new ValidationError('Thing create status must be draft or enabled');
    }
    return { status, spec: parseThingSpec(raw.spec, this.validationOptions()) };
  }

  private parseVersionInput(raw: unknown): ParsedThingVersionInput {
    if (!isRecord(raw)) throw new ValidationError('Thing version request must be an object');
    rejectUnknown(raw, ['version', 'expectedRevision', 'spec'], 'Thing version request');
    if (raw.version !== '1') throw new ValidationError('Thing version request version must be "1"');
    validateRevision(raw.expectedRevision);
    return {
      expectedRevision: raw.expectedRevision,
      spec: parseThingSpec(raw.spec, this.validationOptions()),
    };
  }

  private async storeSpec(
    ownerId: string,
    thingId: string,
    revision: number,
    spec: ThingSpec,
  ): Promise<{ reference: ThingRecord['spec']; hash: string }> {
    const canonical = stableJson(spec);
    const hash = sha256(canonical);
    const ownerHash = sha256(ownerId).slice(0, 32);
    const reference = await this.options.artifacts.putJson(
      `owners/${ownerHash}/things/${thingId}/versions/${revision}-${hash}.json`,
      spec,
    );
    return { reference, hash };
  }

  private async loadSpec(record: ThingRecord, version: ThingVersionRecord): Promise<ThingSpec> {
    if (version.thingId !== record.thingId) throw new Error('Thing version belongs to another Thing');
    const ownerHash = sha256(record.ownerId).slice(0, 32);
    const expectedKey = `owners/${ownerHash}/things/${record.thingId}/versions/${version.revision}-${version.specHash}.json`;
    if (version.spec.key !== expectedKey) {
      throw new Error('Thing spec reference is outside its owner scope');
    }
    const stored = await this.options.artifacts.getJson<unknown>(version.spec);
    const spec = parseThingSpec(stored, this.validationOptions());
    if (sha256(stableJson(spec)) !== version.specHash) {
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
  const name = boundedText(raw.name, 'Thing spec name', 128);
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
  for (const reserved of ['thingId', 'thingName', 'thingRevision', 'scheduledAt']) {
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
  const { ownerId: _ownerId, ownerCreated: _ownerCreated, spec: _spec, ...visible } = record;
  return visible;
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
  if (value.kind !== 'interval') {
    throw new ValidationError('Thing spec trigger.kind must be manual or interval');
  }
  rejectUnknown(value, ['kind', 'everyMinutes', 'startAt'], 'Thing spec interval trigger');
  if (
    typeof value.everyMinutes !== 'number' ||
    !Number.isInteger(value.everyMinutes) ||
    value.everyMinutes < 1 ||
    value.everyMinutes > 525_600
  ) {
    throw new ValidationError('Thing spec trigger.everyMinutes must be an integer from 1 through 525600');
  }
  return {
    kind: 'interval',
    everyMinutes: value.everyMinutes,
    ...(value.startAt !== undefined
      ? { startAt: isoDate(value.startAt, 'Thing spec trigger.startAt') }
      : {}),
  };
}

function versionRecord(record: ThingRecord): ThingVersionRecord {
  return {
    version: '1',
    thingId: record.thingId,
    revision: record.revision,
    spec: record.spec,
    specHash: record.specHash,
    createdAt: record.updatedAt,
  };
}

function lifecycleDiagnostic(status: ThingStatus): ThingDiagnostic {
  if (status === 'archived') {
    return { id: 'lifecycle', status: 'error', message: 'The Thing is archived and cannot run.' };
  }
  if (status === 'draft') {
    return {
      id: 'lifecycle',
      status: 'warning',
      message: 'The Thing is a draft. Explicit test runs work, but triggers are inactive.',
    };
  }
  if (status === 'paused') {
    return {
      id: 'lifecycle',
      status: 'warning',
      message: 'The Thing is paused. Explicit test runs work, but scheduled runs are inactive.',
    };
  }
  return { id: 'lifecycle', status: 'pass', message: 'The Thing is enabled.' };
}

function triggerDiagnostic(thing: PublicThing): ThingDiagnostic {
  if (thing.spec.trigger.kind === 'manual') {
    return {
      id: 'trigger',
      status: 'pass',
      message: 'The Thing runs through an authenticated API or CLI invocation.',
    };
  }
  return {
    id: 'trigger',
    status: thing.status === 'enabled' && !thing.nextRunAt ? 'error' : 'pass',
    message: thing.nextRunAt
      ? `The next interval occurrence is ${thing.nextRunAt}.`
      : `The ${thing.spec.trigger.everyMinutes}-minute interval is inactive.`,
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

function firstOccurrence(now: Date, trigger: Extract<ThingTrigger, { kind: 'interval' }>): string {
  if (trigger.startAt) return nextOccurrence(trigger.startAt, trigger, now, true);
  return new Date(now.getTime() + intervalMilliseconds(trigger)).toISOString();
}

export function nextThingOccurrence(
  scheduledAt: string,
  trigger: Extract<ThingTrigger, { kind: 'interval' }>,
  now: Date,
  includeScheduled = false,
): string {
  return nextOccurrence(scheduledAt, trigger, now, includeScheduled);
}

function nextOccurrence(
  scheduledAt: string,
  trigger: Extract<ThingTrigger, { kind: 'interval' }>,
  now: Date,
  includeScheduled = false,
): string {
  const scheduledMs = Date.parse(scheduledAt);
  if (!Number.isFinite(scheduledMs)) throw new Error('Thing has an invalid nextRunAt');
  const interval = intervalMilliseconds(trigger);
  let next = includeScheduled ? scheduledMs : scheduledMs + interval;
  if (includeScheduled && next < now.getTime()) {
    next += Math.ceil((now.getTime() - next) / interval) * interval;
  } else if (!includeScheduled && next <= now.getTime()) {
    next += (Math.floor((now.getTime() - next) / interval) + 1) * interval;
  }
  return new Date(next).toISOString();
}

function intervalMilliseconds(trigger: Extract<ThingTrigger, { kind: 'interval' }>): number {
  return trigger.everyMinutes * 60_000;
}

function validateOwner(ownerId: string): void {
  if (!ownerId.trim() || Buffer.byteLength(ownerId, 'utf8') > 1_024) {
    throw new ForbiddenError('an authenticated owner is required');
  }
}

function validateThingId(thingId: string): void {
  if (!/^[A-Za-z0-9-]{1,128}$/.test(thingId)) throw new ValidationError('Thing ID is invalid');
}

function validateRevision(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new ValidationError('Thing revision must be a positive integer');
  }
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

function rejectUnknown(value: Record<string, unknown>, allowed: string[], label: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new ValidationError(`${label} contains unknown field ${unknown}`);
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
