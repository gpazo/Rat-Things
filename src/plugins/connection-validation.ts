import type { IntegrationCredentialValue } from '../credentials/types.js';
import type { ConnectionGrant } from '../domain/capabilities.js';
import { ValidationError } from '../domain/validation.js';
import type { IntegrationPluginManifest } from './integration-types.js';

export function requiredOwner(value: string): void {
  if (typeof value !== 'string' || !value || value.length > 1_024) throw new Error('owner ID is invalid');
}

export function safeAlias(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(value)) {
    throw new ValidationError('connection alias must be 1-128 safe ASCII characters');
  }
}

export function connectionDisplayName(value: string): string {
  const name = value.trim();
  if (!name || Buffer.byteLength(name, 'utf8') > 256) {
    throw new ValidationError('connection display name must be 1-256 UTF-8 bytes');
  }
  return name;
}

export function validateCredentialFields(
  credential: IntegrationCredentialValue,
  fields: ReadonlyArray<{ key: string; computed?: boolean; required?: boolean }>,
): void {
  const expected = new Set(fields.map((field) => field.key));
  for (const field of fields) {
    if (field.required !== false && !field.computed && !credential[field.key]) {
      throw new ValidationError(`integration credential requires ${field.key}`);
    }
  }
  for (const field of Object.keys(credential)) {
    if (!expected.has(field)) {
      throw new ValidationError(`integration credential field ${field} is not accepted`);
    }
  }
}

export function validateGrantOperations(
  manifest: Pick<IntegrationPluginManifest, 'id' | 'operations'>,
  grant: ConnectionGrant,
): void {
  const installed = new Set(manifest.operations.map((operation) => operation.id));
  for (const operationId of [...(grant.allowOperations ?? []), ...(grant.denyOperations ?? [])]) {
    if (!installed.has(operationId)) {
      throw new ValidationError(`operation ${operationId} is not installed by plugin ${manifest.id}`);
    }
  }
}
