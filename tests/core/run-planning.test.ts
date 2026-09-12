import { describe, expect, it } from 'vitest';
import { ConflictError, ForbiddenError, NotFoundError } from '../../src/core/errors.js';
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
} from '../../src/core/run-planning.js';
import * as legacy from '../../src/core/run-service.js';
import type { ConversationRunBinding, RunRecord, ThingRunBinding } from '../../src/domain/contracts.js';

const timestamp = '2026-08-02T12:34:56.000Z';
const input = { bucket: 'private', key: 'input', sha256: 'a'.repeat(64) };
const requestHash = 'b'.repeat(64);
const conversation: ConversationRunBinding = {
  conversationId: 'conversation-1', messageId: 'message-1', title: 'Review', delivery: 'defer',
  attachmentDigest: 'c'.repeat(64), replyToMessageId: 'message-0',
};
const prepared: ConversationRunBinding = {
  ...conversation, turnId: 'turn-1', slice: 0, continuation: input, preferredMicrovmId: 'microvm-1',
};
const thing: ThingRunBinding = {
  version: '1', thingId: 'thing-1', revision: 1, specHash: 'd'.repeat(64), invocation: 'manual',
};

describe('Run identity and record calculations', () => {
  it('retains the established deterministic ID and separates owners and receipt keys', () => {
    expect(deterministicRunId('owner-1', 'receipt-1')).toBe('c485d029-7e8d-51f7-9ba4-ef2b22bd7d01');
    expect(deterministicRunId('owner-2', 'receipt-1')).not.toBe(deterministicRunId('owner-1', 'receipt-1'));
    expect(deterministicRunId('owner-1', 'receipt-2')).not.toBe(deterministicRunId('owner-1', 'receipt-1'));
    const key = runInputKey('owner-1', 'run-1', requestHash, 'input');
    expect(key).toMatch(/^owners\/[a-f0-9]{32}\/runs\/run-1\/input-b{64}\.json$/);
    expect(runInputKey('owner-1', 'run-1', requestHash, 'execution')).toBe(key.replace('/input-', '/execution-'));
    expect(runInputKey('owner-2', 'run-1', requestHash, 'input')).not.toBe(key);
  });

  it('constructs queued records from supplied values while keeping owner, policy principal, and actor distinct', () => {
    const values = freeze({
      ownerId: 'owner-1', runId: 'run-1', requestHash, input,
      request: { version: '1' as const, prompt: 'Private prompt', metadata: { count: 0, active: false, label: '' } },
      submit: {
        capabilityOwnerId: 'policy-owner', conversation, thing,
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
      requestHash, input, sourceKind: 'api', provenance: values.submit.provenance, conversation, thing,
    });
    expect(record.conversation).not.toBe(values.submit.conversation);
    expect(record.thing).not.toBe(values.submit.thing);
    expect(JSON.stringify(record)).not.toContain('Private prompt');
    expect(values).toEqual(before);
    const minimal = createQueuedRun({ ...values, submit: {} });
    expect(minimal).not.toHaveProperty('capabilityOwnerId');
    expect(minimal).not.toHaveProperty('provenance');
    expect(minimal).not.toHaveProperty('conversation');
    expect(minimal).not.toHaveProperty('thing');
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
  it('reuses prepared Runs using accepted conversation fields and canonical Thing evidence', () => {
    const record = freeze(run({ conversation: prepared, thing }));
    const reorderedThing = { invocation: thing.invocation, specHash: thing.specHash, revision: 1, thingId: 'thing-1', version: '1' as const };
    expect(assertSameSubmission(record, requestHash, {
      conversation, thing: reorderedThing, traceId: 'another-trace', capabilityOwnerId: 'another-policy-owner',
    })).toBe(record);
  });

  it.each([
    { conversationId: 'other' }, { messageId: 'other' }, { title: 'Other' }, { delivery: 'interrupt' },
    { attachmentDigest: 'e'.repeat(64) }, { replyToMessageId: 'other' },
  ] satisfies Partial<ConversationRunBinding>[])('rejects changed accepted thread identity %j', (changed) => {
    expect(() => assertSameSubmission(run({ conversation: prepared }), requestHash, { conversation: { ...conversation, ...changed } }))
      .toThrow('the idempotency key was already used for a different thread occurrence');
  });

  it('distinguishes absent bindings from adding or removing an occurrence binding', () => {
    const unbound = freeze(run());
    expect(assertSameSubmission(unbound, requestHash, {})).toBe(unbound);
    expect(() => assertSameSubmission(unbound, requestHash, { conversation })).toThrow('different thread occurrence');
    expect(() => assertSameSubmission(run({ conversation }), requestHash, {})).toThrow('different thread occurrence');
    expect(() => assertSameSubmission(unbound, requestHash, { thing })).toThrow('different Thing occurrence');
    expect(() => assertSameSubmission(run({ thing }), requestHash, {})).toThrow('different Thing occurrence');
  });

  it('reports request, Thing, and thread conflicts in their established order', () => {
    const record = freeze(run({ conversation, thing }));
    expect(() => assertSameSubmission(record, 'different', {})).toThrow('already used with a different request');
    expect(() => assertSameSubmission(record, requestHash, {})).toThrow('different Thing occurrence');
    expect(() => assertSameSubmission(record, requestHash, { thing })).toThrow('different thread occurrence');
    expect(() => assertSameSubmission(record, requestHash, { conversation, thing: { ...thing, revision: 2 } }))
      .toThrow('different Thing occurrence');
  });
});

describe('conversation preparation decisions', () => {
  it('requires the accepted binding before returning a validated preparation', () => {
    expect(() => conversationPreparationDecision(run(), prepared, 'run-1')).toThrow('run is not awaiting thread preparation');
    const record = freeze(run({ conversation }));
    expect(() => conversationPreparationDecision(record, { ...prepared, messageId: 'other' }, 'run-1'))
      .toThrow('run thread binding changed before preparation');
    expect(conversationPreparationDecision(record, freeze(prepared), 'run-1')).toEqual({ kind: 'prepare', binding: prepared });
  });

  it('requires full prepared state equality when work is already active', () => {
    const record = freeze(run({ status: 'running', conversation: prepared, executionInput: input }));
    expect(conversationPreparationDecision(record, prepared, 'run-1')).toEqual({ kind: 'reuse' });
    expect(() => conversationPreparationDecision(record, { ...prepared, preferredMicrovmId: 'microvm-2' }, 'run-1'))
      .toThrow('run run-1 cannot be prepared from running');
    expect(() => conversationPreparationDecision(run({ status: 'running', conversation: prepared }), prepared, 'run-1'))
      .toThrow('run run-1 cannot be prepared from running');
  });

  it('compares the stored content digest and complete binding after writing execution input', () => {
    expect(reusePreparedConversation(freeze(run({ conversation })), input, prepared)).toBe(false);
    const record = freeze(run({ conversation: prepared, executionInput: input }));
    expect(reusePreparedConversation(record, { ...input, key: 'another-key-with-the-same-content' }, prepared)).toBe(true);
    expect(() => reusePreparedConversation(record, { ...input, sha256: 'f'.repeat(64) }, prepared))
      .toThrow('run was already prepared with different thread state');
    expect(() => reusePreparedConversation(record, input, { ...prepared, slice: 1 }))
      .toThrow('run was already prepared with different thread state');
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
