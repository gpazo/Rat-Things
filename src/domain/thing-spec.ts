import type { RunRequest } from './contracts.js';
import type { ScheduledThingInvocation, ThingSpec, ThingTrigger } from './things.js';
import {
  isRecord,
  isoDateTime,
  parseRunRequest,
  rejectUnknown,
  requiredTrimmedString,
  ValidationError,
  type ValidationOptions,
} from './validation.js';

export interface ParsedThingVersionInput {
  expectedDraftRevision: number;
  spec: ThingSpec;
}

export interface ParsedPublishThingInput {
  expectedDraftRevision: number;
  expectedSpecHash: string;
  testRunId: string;
}

export function parseThingSpec(
  raw: unknown,
  validationOptions: ValidationOptions = {},
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

export function parseScheduledInvocation(raw: unknown): ScheduledThingInvocation {
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

export function parseThingVersionInput(
  raw: unknown,
  validationOptions: ValidationOptions = {},
): ParsedThingVersionInput {
  if (!isRecord(raw)) throw new ValidationError('Thing version request must be an object');
  rejectUnknown(raw, ['version', 'expectedDraftRevision', 'spec'], 'Thing version request');
  if (raw.version !== '1') throw new ValidationError('Thing version request version must be "1"');
  validateRevision(raw.expectedDraftRevision);
  return {
    expectedDraftRevision: raw.expectedDraftRevision,
    spec: parseThingSpec(raw.spec, validationOptions),
  };
}

export function parsePublishThingInput(raw: unknown): ParsedPublishThingInput {
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

export function validateThingId(thingId: string): void {
  if (!/^[A-Za-z0-9-]{1,128}$/.test(thingId)) throw new ValidationError('Thing ID is invalid');
}

export function validateRevision(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new ValidationError('Thing revision must be a positive integer');
  }
}
