import { describe, expect, it } from 'vitest';
import {
  connectionDisplayName,
  requiredOwner,
  safeAlias,
  validateCredentialFields,
  validateGrantOperations,
} from '../../src/plugins/connection-validation.js';
import { ValidationError } from '../../src/domain/validation.js';

describe('connection input contracts', () => {
  it('retains the existing owner length and whitespace rules', () => {
    expect(() => requiredOwner(' ')).not.toThrow();
    expect(() => requiredOwner('é'.repeat(1_024))).not.toThrow();
    expect(() => requiredOwner('')).toThrow('owner ID is invalid');
    expect(() => requiredOwner('x'.repeat(1_025))).toThrow('owner ID is invalid');
  });

  it('validates aliases as one bounded ASCII path segment', () => {
    expect(() => safeAlias('Account._:@-123')).not.toThrow();
    expect(() => safeAlias('a'.repeat(128))).not.toThrow();
    for (const value of ['', 'a/b', 'a b', '.hidden', 'café', 'a'.repeat(129)]) {
      expect(() => safeAlias(value)).toThrow(ValidationError);
    }
  });

  it('trims display names before measuring UTF-8 bytes', () => {
    expect(connectionDisplayName(`  ${'é'.repeat(128)}  `)).toBe('é'.repeat(128));
    expect(() => connectionDisplayName('é'.repeat(129))).toThrow('1-256 UTF-8 bytes');
    expect(() => connectionDisplayName(' \n ')).toThrow('1-256 UTF-8 bytes');
  });

  it('accepts omitted computed fields and empty optional credentials without changing the input', () => {
    const fields = Object.freeze([{ key: 'token' }, { key: 'optional', required: false }, { key: 'account', computed: true }]);
    const credential = Object.freeze({ token: '0', optional: '' });
    expect(() => validateCredentialFields(credential, fields)).not.toThrow();
    expect(credential).toEqual({ token: '0', optional: '' });
    expect(() => validateCredentialFields({ token: '' }, fields)).toThrow('integration credential requires token');
    expect(() => validateCredentialFields({ token: 'valid', account: '' }, fields)).not.toThrow();
  });

  it('checks missing fields in manifest order before rejecting extra credential fields', () => {
    const fields = [{ key: 'first' }, { key: 'second' }];
    expect(() => validateCredentialFields({ unexpected: 'secret-value' }, fields)).toThrow('requires first');
    expect(() => validateCredentialFields({ first: 'valid', unexpected: 'secret-value' }, fields)).toThrow('requires second');
    expect(() => validateCredentialFields({ first: 'valid', second: 'valid', unexpected: 'secret-value' }, fields))
      .toThrow('integration credential field unexpected is not accepted');
  });

  it('checks allowed operations before denied operations using only installed manifest data', () => {
    const manifest = { id: 'slack', operations: [{
      id: 'slack.records.search', title: 'Search', kind: 'search' as const, access: 'read' as const, risk: 'routine' as const,
    }] };
    const grant = { version: '1' as const, grantId: 'grant-1', ownerId: 'owner-1', connectionId: 'connection-1', preset: 'read-only' as const };
    expect(() => validateGrantOperations(manifest, { ...grant, allowOperations: [], denyOperations: [] })).not.toThrow();
    expect(() => validateGrantOperations(manifest, { ...grant, allowOperations: ['slack.records.search'] })).not.toThrow();
    expect(() => validateGrantOperations(manifest, { ...grant, allowOperations: ['unknown-allow'], denyOperations: ['unknown-deny'] }))
      .toThrow('operation unknown-allow is not installed by plugin slack');
    expect(() => validateGrantOperations(manifest, { ...grant, allowOperations: ['slack.records.search'], denyOperations: ['unknown-deny'] }))
      .toThrow('operation unknown-deny is not installed by plugin slack');
  });
});
