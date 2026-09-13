import { describe, expect, it } from 'vitest';
import { ConflictError, ForbiddenError, NotFoundError } from '../../src/core/errors.js';
import {
  assertOwner,
  assertSameSubmission,
  createQueuedRun,
  deterministicRunId,
  runInputKey,
  validateIdempotencyKey,
  validateOwner,
} from '../../src/core/run-planning.js';
import * as legacy from '../../src/core/run-service.js';
import type { RunRecord } from '../../src/domain/contracts.js';

const timestamp = '2026-08-02T12:34:56.000Z';
const input = { bucket: 'private', key: 'input', sha256: 'a'.repeat(64) };
const requestHash = 'b'.repeat(64);
const agentsSession = { sessionId: 'sess_1', turnId: 'turn_1', launch: input };
describe('Run identity and record calculations', () => {
  it('retains the established deterministic ID and separates owners and receipt keys', () => {
    expect(deterministicRunId('owner-1', 'receipt-1')).toBe('c485d029-7e8d-51f7-9ba4-ef2b22bd7d01');
    expect(deterministicRunId('owner-2', 'receipt-1')).not.toBe(deterministicRunId('owner-1', 'receipt-1'));
    expect(deterministicRunId('owner-1', 'receipt-2')).not.toBe(deterministicRunId('owner-1', 'receipt-1'));
    const key = runInputKey('owner-1', 'run-1', requestHash);
    expect(key).toMatch(/^owners\/[a-f0-9]{32}\/runs\/run-1\/input-b{64}\.json$/);
    expect(runInputKey('owner-2', 'run-1', requestHash)).not.toBe(key);
  });

  it('constructs queued records from supplied values while keeping owner, policy principal, and actor distinct', () => {
    const values = freeze({
      ownerId: 'owner-1', runId: 'run-1', requestHash, input,
      request: { version: '1' as const, prompt: 'Private prompt', metadata: { count: 0, active: false, label: '' } },
      submit: {
        capabilityOwnerId: 'policy-owner', agentsSession,
        provenance: { actor: { kind: 'system' as const, id: 'routine-1', provider: 'api' as const },
          credentialSubject: { kind: 'runtime' as const, id: 'runtime-1' } },
      },
      now: new Date(999), retentionSeconds: 0,
    });
    const before = structuredClone(values);
    const record = createQueuedRun(values);
    expect(record).toEqual({
      runId: 'run-1', ownerId: 'owner-1', capabilityOwnerId: 'policy-owner',
      ownerCreated: 'owner-1#1970-01-01T00:00:00.999Z#run-1', status: 'queued',
      createdAt: '1970-01-01T00:00:00.999Z', updatedAt: '1970-01-01T00:00:00.999Z', expiresAt: 0,
      requestHash, input, sourceKind: 'api', provenance: values.submit.provenance, agentsSession,
    });
    expect(JSON.stringify(record)).not.toContain('Private prompt');
    expect(values).toEqual(before);
    const minimal = createQueuedRun({ ...values, submit: {} });
    expect(minimal).not.toHaveProperty('capabilityOwnerId');
    expect(minimal).not.toHaveProperty('provenance');
    expect(minimal).not.toHaveProperty('agentsSession');
  });

  it('preserves public error identities and validates owners and receipt keys without normalizing them', () => {
    expect(legacy.ConflictError).toBe(ConflictError);
    expect(legacy.ForbiddenError).toBe(ForbiddenError);
    expect(legacy.NotFoundError).toBe(NotFoundError);
    expect(legacy.validateOwner).toBe(validateOwner);
    expect(() => validateOwner(' ')).toThrow(ForbiddenError);
    expect(() => validateOwner('🌍'.repeat(257))).toThrow('owner identity is too large');
    expect(() => validateOwner(' owner-1 ')).not.toThrow();
    expect(() => assertOwner(run(), 'owner-2')).toThrow('run belongs to another owner');
    expect(validateIdempotencyKey('receipt:1._-')).toBe('receipt:1._-');
    for (const key of ['', 'with spaces', 'a'.repeat(201)]) {
      expect(() => validateIdempotencyKey(key)).toThrow('Idempotency-Key must be 1-200 safe ASCII characters');
    }
  });
});

describe('accepted Run identity', () => {
  it('reuses private Runs using the accepted Session launch binding', () => {
    const record = freeze(run({ agentsSession }));
    expect(assertSameSubmission(record, requestHash, {
      agentsSession, traceId: 'another-trace', capabilityOwnerId: 'another-policy-owner',
    })).toBe(record);
  });

  it.each([
    { sessionId: 'sess_other' }, { turnId: 'turn_other' }, { launch: { ...input, key: 'other' } },
  ] satisfies Partial<NonNullable<RunRecord['agentsSession']>>[])('rejects changed Session launch identity %j', (changed) => {
    expect(() => assertSameSubmission(run({ agentsSession }), requestHash, { agentsSession: { ...agentsSession, ...changed } }))
      .toThrow('Agents session launch binding changed on retry');
  });

  it('distinguishes absent bindings from adding or removing an occurrence binding', () => {
    const unbound = freeze(run());
    expect(assertSameSubmission(unbound, requestHash, {})).toBe(unbound);
    expect(() => assertSameSubmission(unbound, requestHash, { agentsSession })).toThrow('Agents session launch binding changed on retry');
    expect(() => assertSameSubmission(run({ agentsSession }), requestHash, {})).toThrow('Agents session launch binding changed on retry');
  });

  it('reports request conflicts before Session binding conflicts', () => {
    const record = freeze(run({ agentsSession }));
    expect(() => assertSameSubmission(record, 'different', {})).toThrow('already used with a different request');
    expect(() => assertSameSubmission(record, requestHash, {})).toThrow('Agents session launch binding changed on retry');
  });

});

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: 'run-1', ownerId: 'owner-1', ownerCreated: `owner-1#${timestamp}#run-1`, status: 'queued',
    createdAt: timestamp, updatedAt: timestamp, expiresAt: 600, requestHash, input, sourceKind: 'api', ...overrides,
  };
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
