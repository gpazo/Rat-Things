import { describe, expect, it } from 'vitest';
import { firstOccurrence, nextOccurrence, parseRoutineInput } from '../../src/domain/routine-spec.js';
import { ValidationError } from '../../src/domain/validation.js';

const input = {
  version: '1', name: 'Review', schedule: { kind: 'interval', everyMinutes: 5 },
  request: { version: '1', prompt: 'Review the queue' },
};

describe('routine definitions', () => {
  it('normalizes frozen input while preserving falsey settings and empty selections', () => {
    const raw = freeze({
      ...input, name: '  Review  ', enabled: false,
      schedule: { ...input.schedule, startAt: '2026-08-20T03:00:00-07:00' },
      request: {
        ...input.request, destinations: [], agent: { capabilities: { networkAccess: false } },
        metadata: { count: 0, active: false, label: '', nested: { tags: [] } },
      },
    });
    const before = structuredClone(raw);
    expect(parseRoutineInput(raw)).toEqual({
      name: 'Review', enabled: false,
      schedule: { kind: 'interval', everyMinutes: 5 }, startAt: '2026-08-20T10:00:00.000Z',
      request: raw.request,
    });
    expect(raw).toEqual(before);
  });

  it('defaults to enabled without inventing a start time or optional request fields', () => {
    expect(parseRoutineInput(input)).toEqual({
      name: 'Review', enabled: true, schedule: input.schedule, request: input.request,
    });
  });

  it('validates against explicitly supplied repository and sandbox policy', () => {
    const raw = {
      ...input,
      request: {
        ...input.request,
        repository: { provider: 'github', url: 'https://github.example.com/team/repo.git' },
        agent: { sandbox: 'read-only' },
      },
    };
    expect(() => parseRoutineInput(raw)).toThrow(ValidationError);
    expect(parseRoutineInput(raw, {
      allowedRepositoryHosts: ['github.example.com'], allowedSandboxModes: ['read-only'],
    }).request).toEqual(raw.request);
    expect(() => parseRoutineInput(raw, {
      allowedRepositoryHosts: ['github.example.com'], allowedSandboxModes: [],
    })).toThrow(ValidationError);
  });

  it.each([
    { request: { ...input.request, source: { kind: 'api' } }, message: 'cannot set source' },
    { request: { ...input.request, parentRunId: 'run-1' }, message: 'cannot set parentRunId' },
    { request: { ...input.request, destinations: [{ kind: 'source' }] }, message: 'cannot use the source delivery destination' },
  ])('rejects request authority that must be supplied by the routine: $message', ({ request, message }) => {
    expect(() => parseRoutineInput({ ...input, request })).toThrow(message);
  });

  it.each(['routineId', 'scheduledAt'])('rejects reserved metadata %s even when falsey', (key) => {
    for (const value of [0, false, '']) {
      expect(() => parseRoutineInput({ ...input, request: { ...input.request, metadata: { [key]: value } } }))
        .toThrow('routine request metadata uses reserved keys');
    }
  });

  it('retains validation precedence from schedule to request to enablement', () => {
    const raw = { ...input, request: {}, enabled: 'yes' };
    expect(() => parseRoutineInput({ ...raw, schedule: { kind: 'cron' } })).toThrow('schedule.kind must be interval');
    expect(() => parseRoutineInput(raw)).toThrow('version must be "1"');
    expect(() => parseRoutineInput({ ...raw, request: input.request })).toThrow('routine.enabled must be a boolean');
  });

  it.each([0, -1, 1.5, 525_601, NaN, Infinity, '5'])('rejects invalid interval %s', (everyMinutes) => {
    expect(() => parseRoutineInput({ ...input, schedule: { kind: 'interval', everyMinutes } }))
      .toThrow('routine.schedule.everyMinutes must be an integer from 1 through 525600');
  });
});

describe('routine occurrence times', () => {
  const schedule = { kind: 'interval', everyMinutes: 5 } as const;
  const scheduledAt = '2026-08-20T10:00:00.000Z';

  it.each([
    { now: '2026-08-20T09:59:00.000Z', resumed: '2026-08-20T10:00:00.000Z', advanced: '2026-08-20T10:05:00.000Z' },
    { now: '2026-08-20T10:00:00.000Z', resumed: '2026-08-20T10:00:00.000Z', advanced: '2026-08-20T10:05:00.000Z' },
    { now: '2026-08-20T10:04:59.999Z', resumed: '2026-08-20T10:05:00.000Z', advanced: '2026-08-20T10:05:00.000Z' },
    { now: '2026-08-20T10:05:00.000Z', resumed: '2026-08-20T10:05:00.000Z', advanced: '2026-08-20T10:10:00.000Z' },
    { now: '2026-08-20T10:05:00.001Z', resumed: '2026-08-20T10:10:00.000Z', advanced: '2026-08-20T10:10:00.000Z' },
    { now: '2026-08-22T10:00:00.000Z', resumed: '2026-08-22T10:00:00.000Z', advanced: '2026-08-22T10:05:00.000Z' },
  ])('resumes or advances from $now without replaying backlog', ({ now, resumed, advanced }) => {
    const clock = new Date(now);
    expect(nextOccurrence(scheduledAt, schedule, clock, true)).toBe(resumed);
    expect(nextOccurrence(scheduledAt, schedule, clock)).toBe(advanced);
    expect(clock.toISOString()).toBe(now);
  });

  it('starts one interval from supplied time or aligns an explicit starting occurrence', () => {
    const now = new Date('2026-08-20T10:12:30.000Z');
    expect(firstOccurrence(now, schedule)).toBe('2026-08-20T10:17:30.000Z');
    expect(firstOccurrence(now, schedule, scheduledAt)).toBe('2026-08-20T10:15:00.000Z');
    expect(firstOccurrence(now, schedule, '2026-08-20T11:00:00.000Z')).toBe('2026-08-20T11:00:00.000Z');
  });

  it('accepts epoch zero and the maximum validated interval', () => {
    expect(nextOccurrence('1970-01-01T00:00:00.000Z', schedule, new Date(0), true))
      .toBe('1970-01-01T00:00:00.000Z');
    const parsed = parseRoutineInput({ ...input, schedule: { kind: 'interval', everyMinutes: 525_600 } });
    expect(firstOccurrence(new Date(0), parsed.schedule)).toBe('1971-01-01T00:00:00.000Z');
  });

  it('rejects an invalid stored timestamp with the existing error', () => {
    expect(() => nextOccurrence('invalid', schedule, new Date(0))).toThrow('routine has an invalid nextRunAt');
  });
});

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
