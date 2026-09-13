import { ValidationError } from './validation.js';

export function validateCapabilityOwner(value: string): string {
  if (!value.trim() || Buffer.byteLength(value, 'utf8') > 1_024) {
    throw new ValidationError('capability owner identity is invalid');
  }
  return value;
}

/** Retired durable records are retained for inspection, never relaunched after cutover. */
export function isRetiredRun(record: object): boolean {
  return 'conversation' in record || 'executionInput' in record;
}
