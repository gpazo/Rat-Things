import type { ConversationRunBinding, ThingRunBinding } from './contracts.js';
import { ValidationError } from './validation.js';

export function validateCapabilityOwner(value: string): string {
  if (!value.trim() || Buffer.byteLength(value, 'utf8') > 1_024) {
    throw new ValidationError('capability owner identity is invalid');
  }
  return value;
}

export function validateConversationBinding(
  binding: ConversationRunBinding,
  prepared = false,
): ConversationRunBinding {
  if (!binding.conversationId || Buffer.byteLength(binding.conversationId, 'utf8') > 512) {
    throw new ValidationError('conversationId is invalid');
  }
  if (
    binding.messageId !== undefined &&
    (!binding.messageId || Buffer.byteLength(binding.messageId, 'utf8') > 512)
  ) {
    throw new ValidationError('messageId is invalid');
  }
  if (!binding.messageId && !binding.turnId) {
    throw new ValidationError('conversation binding requires a messageId or turnId');
  }
  if (prepared && !binding.messageId) throw new ValidationError('messageId is invalid');
  if (binding.turnId !== undefined && (!binding.turnId || Buffer.byteLength(binding.turnId, 'utf8') > 512)) {
    throw new ValidationError('turnId is invalid');
  }
  if (prepared && !binding.turnId) throw new ValidationError('turnId is invalid');
  if (prepared && (
    binding.slice === undefined || !Number.isInteger(binding.slice) || binding.slice < 0 || binding.slice > 10_000
  )) {
    throw new ValidationError('conversation slice is invalid');
  }
  if (binding.delivery !== undefined && !['interrupt', 'defer'].includes(binding.delivery)) {
    throw new ValidationError('conversation delivery is invalid');
  }
  if (binding.preferredMicrovmId && !/^[A-Za-z0-9._:-]{1,256}$/.test(binding.preferredMicrovmId)) {
    throw new ValidationError('preferred MicroVM ID is invalid');
  }
  if (binding.agentThreadId && !/^[A-Za-z0-9._:-]{1,256}$/.test(binding.agentThreadId)) {
    throw new ValidationError('agent thread ID is invalid');
  }
  for (const [label, artifact] of [
    ['continuation', binding.continuation],
    ['artifact catalog', binding.artifacts],
    ['attachment manifest', binding.attachmentManifest],
  ] as const) {
    if (artifact && (
      !artifact.bucket ||
      !artifact.key ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256)
    )) throw new ValidationError(`conversation ${label} artifact is invalid`);
  }
  if (binding.attachmentDigest !== undefined && !/^[a-f0-9]{64}$/.test(binding.attachmentDigest)) {
    throw new ValidationError('conversation attachment digest is invalid');
  }
  if (
    binding.replyToMessageId !== undefined &&
    (!binding.replyToMessageId || Buffer.byteLength(binding.replyToMessageId, 'utf8') > 512)
  ) throw new ValidationError('conversation reply target is invalid');
  if (binding.title !== undefined && (!binding.title.trim() || binding.title.length > 128)) {
    throw new ValidationError('conversation title must be 1-128 characters');
  }
  return { ...binding };
}

export function validateThingBinding(binding: ThingRunBinding): ThingRunBinding {
  if (binding.version !== '1') throw new ValidationError('Thing run binding version must be "1"');
  if (!/^[A-Za-z0-9-]{1,128}$/.test(binding.thingId)) {
    throw new ValidationError('Thing run binding ID is invalid');
  }
  if (!Number.isSafeInteger(binding.revision) || binding.revision < 1) {
    throw new ValidationError('Thing run binding revision is invalid');
  }
  if (!/^[a-f0-9]{64}$/.test(binding.specHash)) {
    throw new ValidationError('Thing run binding spec hash is invalid');
  }
  if (!['test', 'manual', 'schedule'].includes(binding.invocation)) {
    throw new ValidationError('Thing run binding invocation is invalid');
  }
  if (binding.invocation === 'schedule' && !binding.scheduledAt) {
    throw new ValidationError('scheduled Thing run binding requires scheduledAt');
  }
  if (binding.scheduledAt !== undefined && !Number.isFinite(Date.parse(binding.scheduledAt))) {
    throw new ValidationError('Thing run binding scheduledAt is invalid');
  }
  return { ...binding };
}
