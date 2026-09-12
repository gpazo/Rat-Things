import { describe, expect, it } from 'vitest';
import type { ConversationRunBinding, ThingRunBinding } from '../../src/domain/contracts.js';
import { validateCapabilityOwner, validateConversationBinding, validateThingBinding } from '../../src/domain/run-bindings.js';

const conversation: ConversationRunBinding = {
  conversationId: 'conversation-1', messageId: 'message-1', turnId: 'turn-1', slice: 0, delivery: 'defer',
};
const thing: ThingRunBinding = {
  version: '1', thingId: 'thing-1', revision: 1, specHash: 'a'.repeat(64), invocation: 'manual',
};

describe('trusted conversation bindings', () => {
  it('copies frozen bindings, retaining slice zero and empty optional session identifiers', () => {
    const binding = Object.freeze({ ...conversation, preferredMicrovmId: '', agentThreadId: '' });
    const validated = validateConversationBinding(binding, true);
    expect(validated).toEqual(binding);
    expect(validated).not.toBe(binding);
    validated.slice = 1;
    expect(binding.slice).toBe(0);
    expect(validateConversationBinding({ ...conversation, slice: 10_000 }, true).slice).toBe(10_000);
  });

  it('allows reservations with a message or turn, but requires both and a slice for preparation', () => {
    const message = { conversationId: 'conversation-1', messageId: 'message-1' };
    const turn = { conversationId: 'conversation-1', turnId: 'turn-1' };
    expect(validateConversationBinding(message)).toEqual(message);
    expect(validateConversationBinding(turn)).toEqual(turn);
    expect(() => validateConversationBinding({ conversationId: 'conversation-1' }))
      .toThrow('conversation binding requires a messageId or turnId');
    expect(() => validateConversationBinding(message, true)).toThrow('turnId is invalid');
    expect(() => validateConversationBinding(turn, true)).toThrow('messageId is invalid');
    expect(() => validateConversationBinding({ ...message, ...turn }, true)).toThrow('conversation slice is invalid');
  });

  it.each([-1, 0.5, 10_001, NaN, Infinity])('rejects prepared slice %s', (slice) => {
    expect(() => validateConversationBinding({ ...conversation, slice }, true)).toThrow('conversation slice is invalid');
  });

  it('keeps byte limits for routing IDs distinct from the title character limit', () => {
    expect(validateConversationBinding({ ...conversation, conversationId: '🌍'.repeat(128) }).conversationId)
      .toBe('🌍'.repeat(128));
    expect(() => validateConversationBinding({ ...conversation, conversationId: '🌍'.repeat(129) }))
      .toThrow('conversationId is invalid');
    expect(validateConversationBinding({ ...conversation, title: '🌍'.repeat(64) }).title).toBe('🌍'.repeat(64));
    expect(() => validateConversationBinding({ ...conversation, title: '🌍'.repeat(65) }))
      .toThrow('conversation title must be 1-128 characters');
    expect(() => validateConversationBinding({ ...conversation, title: ' ' })).toThrow('conversation title');
  });

  it.each([
    ['continuation', 'continuation'], ['artifacts', 'artifact catalog'], ['attachmentManifest', 'attachment manifest'],
  ] as const)('validates %s evidence with its specific diagnostic', (key, label) => {
    const artifact = Object.freeze({ bucket: 'private', key: 'input', sha256: 'b'.repeat(64) });
    const binding = Object.freeze({ ...conversation, [key]: artifact });
    expect(validateConversationBinding(binding, true)).toEqual(binding);
    expect(() => validateConversationBinding({ ...binding, [key]: { ...artifact, sha256: 'invalid' } }, true))
      .toThrow(`conversation ${label} artifact is invalid`);
  });

  it('retains validation order when multiple binding fields are invalid', () => {
    expect(() => validateConversationBinding({ ...conversation, conversationId: '', messageId: '', slice: -1 }, true))
      .toThrow('conversationId is invalid');
    expect(() => validateConversationBinding({ ...conversation, messageId: '', slice: -1 }, true))
      .toThrow('messageId is invalid');
    expect(() => validateConversationBinding({ ...conversation, attachmentDigest: '', replyToMessageId: '' }))
      .toThrow('conversation attachment digest is invalid');
    expect(() => validateConversationBinding({ ...conversation, replyToMessageId: '' }))
      .toThrow('conversation reply target is invalid');
  });
});

describe('trusted Thing bindings', () => {
  it('copies pinned occurrence evidence without normalizing its supplied timestamp', () => {
    const binding = Object.freeze({ ...thing, invocation: 'schedule' as const, scheduledAt: '2026-08-20T03:00:00-07:00' });
    const validated = validateThingBinding(binding);
    expect(validated).toEqual(binding);
    expect(validated).not.toBe(binding);
    validated.revision = 2;
    expect(binding.revision).toBe(1);
    expect(validateThingBinding(thing)).not.toHaveProperty('scheduledAt');
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects unsafe revision %s', (revision) => {
    expect(() => validateThingBinding({ ...thing, revision })).toThrow('Thing run binding revision is invalid');
  });

  it('requires scheduled occurrence evidence and rejects invalid supplied timestamps', () => {
    expect(() => validateThingBinding({ ...thing, invocation: 'schedule' })).toThrow('requires scheduledAt');
    expect(() => validateThingBinding({ ...thing, scheduledAt: '' })).toThrow('Thing run binding scheduledAt is invalid');
    expect(() => validateThingBinding({ ...thing, invocation: 'schedule', scheduledAt: 'invalid' }))
      .toThrow('Thing run binding scheduledAt is invalid');
  });
});

it('validates the delegated principal without trimming or conflating it with the Run owner', () => {
  expect(validateCapabilityOwner(' delegated-owner ')).toBe(' delegated-owner ');
  expect(validateCapabilityOwner('🌍'.repeat(256))).toBe('🌍'.repeat(256));
  expect(() => validateCapabilityOwner('🌍'.repeat(257))).toThrow('capability owner identity is invalid');
  expect(() => validateCapabilityOwner(' ')).toThrow('capability owner identity is invalid');
});
