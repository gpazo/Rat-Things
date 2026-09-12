import { describe, expect, it } from 'vitest';
import {
  compileThingSpec,
  parsePublishThingInput,
  parseScheduledInvocation,
  parseThingSpec,
  parseThingVersionInput,
} from '../../src/domain/thing-spec.js';
import { ValidationError } from '../../src/domain/validation.js';

const minimalSpec = {
  version: '1',
  name: 'Example',
  goal: 'Review the queue',
  trigger: { kind: 'manual' },
};

describe('Thing definition calculations', () => {
  it('normalizes and compiles frozen input while retaining falsey values and empty selections', () => {
    const raw = freeze({
      ...minimalSpec,
      name: '  Example  ',
      trigger: { kind: 'schedule', expression: ' RATE(2 HOURS) ', timezone: 'UTC' },
      agent: { capabilities: { networkAccess: false } },
      connections: { set: 'operations', accounts: [] },
      deliver: [],
      metadata: { count: 0, enabled: false, label: '', nested: { tags: [] } },
    });
    const before = structuredClone(raw);
    const spec = parseThingSpec(raw);
    const request = compileThingSpec(freeze(spec));

    expect(spec).toMatchObject({
      name: 'Example',
      trigger: { kind: 'schedule', expression: 'rate(2 hours)', timezone: 'UTC' },
    });
    expect(request).toEqual({
      version: '1',
      prompt: 'Review the queue',
      agent: { capabilities: { networkAccess: false } },
      integrations: { connectionSet: 'operations', connections: [] },
      destinations: [],
      metadata: { count: 0, enabled: false, label: '', nested: { tags: [] } },
    });
    expect(raw).toEqual(before);
    expect(parseThingSpec(spec)).toEqual(spec);
  });

  it('compiles account access and operation restrictions without changing their order', () => {
    const spec = parseThingSpec({
      ...minimalSpec,
      connections: {
        set: 'operations',
        accounts: [
          { account: 'slack-team', access: 'read-only', allowOperations: [], denyOperations: ['slack.chat.postMessage'] },
          { account: 'stripe-shop', access: 'read-write' },
        ],
      },
    });
    expect(compileThingSpec(freeze(spec)).integrations).toEqual({
      connectionSet: 'operations',
      connections: [
        { connection: 'slack-team', preset: 'read-only', allowOperations: [], denyOperations: ['slack.chat.postMessage'] },
        { connection: 'stripe-shop', preset: 'read-write' },
      ],
    });
  });

  it('keeps absent optional values absent', () => {
    expect(compileThingSpec(parseThingSpec(minimalSpec))).toEqual({
      version: '1', prompt: 'Review the queue',
    });
    expect(() => parseThingSpec({ ...minimalSpec, connections: { accounts: [] } }))
      .toThrow('integrations requires connectionSet or connections');
  });

  it('passes deployment validation policy through version parsing', () => {
    const input = {
      version: '1',
      expectedDraftRevision: 1,
      spec: {
        ...minimalSpec,
        repository: { provider: 'github', url: 'https://github.example.com/team/repo.git' },
        agent: { sandbox: 'read-only' },
      },
    };
    expect(() => parseThingVersionInput(input)).toThrow(ValidationError);
    expect(parseThingVersionInput(input, {
      allowedRepositoryHosts: ['github.example.com'], allowedSandboxModes: ['read-only'],
    })).toMatchObject({ expectedDraftRevision: 1, spec: input.spec });
    expect(() => parseThingVersionInput(input, {
      allowedRepositoryHosts: ['github.example.com'], allowedSandboxModes: [],
    })).toThrow(ValidationError);
  });

  it.each(['thingId', 'thingName', 'thingRevision', 'thingInvocation', 'scheduledAt'])(
    'rejects reserved metadata %s even when falsey', (key) => {
      for (const value of [0, false, '']) {
        expect(() => parseThingSpec({ ...minimalSpec, metadata: { [key]: value } }))
          .toThrow(`Thing spec metadata uses reserved key ${key}`);
      }
    },
  );

  it('validates publish evidence and canonicalizes scheduled timestamps as plain values', () => {
    expect(parsePublishThingInput({
      version: '1', expectedDraftRevision: 2, expectedSpecHash: 'a'.repeat(64), testRunId: 'run-test',
    })).toEqual({ expectedDraftRevision: 2, expectedSpecHash: 'a'.repeat(64), testRunId: 'run-test' });
    expect(parseScheduledInvocation({
      version: '1', thingId: 'thing-1', revision: 2, scheduledAt: '2026-08-21T04:00:00-07:00',
    })).toEqual({
      version: '1', thingId: 'thing-1', revision: 2, scheduledAt: '2026-08-21T11:00:00.000Z',
    });
    expect(() => parsePublishThingInput({
      version: '1', expectedDraftRevision: 0, expectedSpecHash: 'a'.repeat(64), testRunId: 'run-test',
    })).toThrow('Thing revision must be a positive integer');
  });
});

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
