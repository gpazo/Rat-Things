import type {
  ArtifactReference, ConversationRunBinding, RunProvenance, RunRecord, RunRequest, ThingRunBinding,
} from '../domain/contracts.js';
import { canonicalJson as stableJson, sha256Hex as sha256 } from '../domain/json.js';
import { validateCapabilityOwner, validateConversationBinding, validateThingBinding } from '../domain/run-bindings.js';
import { ValidationError } from '../domain/validation.js';
import { ConflictError, ForbiddenError } from './errors.js';

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

export function runInputKey(ownerId: string, runId: string, hash: string, kind: 'input' | 'execution'): string {
  const ownerHash = sha256(ownerId).slice(0, 32);
  return `owners/${ownerHash}/runs/${runId}/${kind}-${hash}.json`;
}

/** Record construction uses already stored input and supplied time; it performs no operations. */
export function createQueuedRun({
  ownerId, runId, request, requestHash, input, submit, now, retentionSeconds,
}: {
  ownerId: string;
  runId: string;
  request: RunRequest;
  requestHash: string;
  input: ArtifactReference;
  submit: SubmitOptions;
  now: Date;
  retentionSeconds: number;
}): RunRecord {
  const iso = now.toISOString();
  return {
    runId,
    ownerId,
    ...(submit.capabilityOwnerId
      ? { capabilityOwnerId: validateCapabilityOwner(submit.capabilityOwnerId) }
      : {}),
    ownerCreated: `${ownerId}#${iso}#${runId}`,
    status: 'queued',
    createdAt: iso,
    updatedAt: iso,
    expiresAt: Math.floor(now.getTime() / 1_000) + retentionSeconds,
    requestHash,
    input,
    sourceKind: request.source?.kind ?? 'api',
    ...(submit.provenance ? { provenance: submit.provenance } : {}),
    ...(submit.conversation ? { conversation: validateConversationBinding(submit.conversation) } : {}),
    ...(submit.thing ? { thing: validateThingBinding(submit.thing) } : {}),
  };
}

/** Reuse is decided from accepted identity, including bindings, before any retry wake-up. */
export function assertSameSubmission(record: RunRecord, requestHash: string, submit: SubmitOptions): RunRecord {
  const same = assertSameRequest(record, requestHash);
  assertSameThing(same.thing, submit.thing);
  assertSameConversationBinding(same.conversation, submit.conversation);
  return same;
}

export type ConversationPreparationDecision =
  | { kind: 'reuse' }
  | { kind: 'prepare'; binding: ConversationRunBinding };

/** Check the accepted binding before parsing or storing a new execution request. */
export function conversationPreparationDecision(
  current: RunRecord,
  binding: ConversationRunBinding,
  runId: string,
): ConversationPreparationDecision {
  if (current.status !== 'queued') {
    if (current.executionInput && sameConversation(current.conversation, binding)) return { kind: 'reuse' };
    throw new ConflictError(`run ${runId} cannot be prepared from ${current.status}`);
  }
  if (!current.conversation) throw new ConflictError('run is not awaiting thread preparation');
  if (
    current.conversation.conversationId !== binding.conversationId ||
    current.conversation.messageId !== binding.messageId
  ) {
    throw new ConflictError('run thread binding changed before preparation');
  }
  return { kind: 'prepare', binding: validateConversationBinding(binding, true) };
}

/** Compare storage-returned evidence only after the execution request has been written. */
export function reusePreparedConversation(
  current: RunRecord,
  executionInput: ArtifactReference,
  binding: ConversationRunBinding,
): boolean {
  if (!current.executionInput) return false;
  if (
    current.executionInput.sha256 === executionInput.sha256 &&
    sameConversation(current.conversation, binding)
  ) return true;
  throw new ConflictError('run was already prepared with different thread state');
}

export function deterministicRunId(ownerId: string, key: string): string {
  const hex = sha256(`${ownerId}\u0000${key}`).slice(0, 32).split('');
  hex[12] = '5';
  const variant = Number.parseInt(hex[16] ?? '0', 16);
  hex[16] = ((variant & 0x3) | 0x8).toString(16);
  const joined = hex.join('');
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}

function sameConversation(
  left: ConversationRunBinding | undefined,
  right: ConversationRunBinding,
): boolean {
  return Boolean(left && stableJson(left) === stableJson(right));
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
      existing.title === requested.title &&
      existing.delivery === requested.delivery &&
      existing.attachmentDigest === requested.attachmentDigest &&
      existing.replyToMessageId === requested.replyToMessageId
    : existing === requested;
  if (!same) {
    throw new ConflictError('the idempotency key was already used for a different thread occurrence');
  }
}

export function validateIdempotencyKey(value: string): string {
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

export function assertOwner(record: RunRecord, ownerId: string): void {
  if (record.ownerId !== ownerId) throw new ForbiddenError('run belongs to another owner');
}

export function validateOwner(ownerId: string): void {
  if (!ownerId.trim()) throw new ForbiddenError('an authenticated owner is required');
  if (Buffer.byteLength(ownerId, 'utf8') > 1_024) {
    throw new ForbiddenError('owner identity is too large');
  }
}
