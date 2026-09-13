import { expect, it } from 'vitest';
import { validateCapabilityOwner } from '../../src/domain/run-bindings.js';

it('validates the delegated principal without trimming or conflating it with the Run owner', () => {
  expect(validateCapabilityOwner(' delegated-owner ')).toBe(' delegated-owner ');
  expect(validateCapabilityOwner('🌍'.repeat(256))).toBe('🌍'.repeat(256));
  expect(() => validateCapabilityOwner('🌍'.repeat(257))).toThrow('capability owner identity is invalid');
  expect(() => validateCapabilityOwner(' ')).toThrow('capability owner identity is invalid');
});
