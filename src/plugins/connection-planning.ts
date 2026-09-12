import { sha256Hex } from '../domain/json.js';
import {
  validateConnectionGrant,
  validateConnectionHealth,
  validateIntegrationConnection,
  type ConnectionGrant,
  type ConnectionHealth,
  type IntegrationConnection,
} from '../domain/capabilities.js';
import type { VerifiedIntegrationCredential } from './integration-types.js';

/** Build public account metadata from verified values, with no credential or vault reference. */
export function newConnection(
  identity: Pick<IntegrationConnection, 'connectionId' | 'ownerId' | 'pluginId' | 'alias'>,
  verified: VerifiedIntegrationCredential,
  timestamp: string,
): IntegrationConnection {
  return validateIntegrationConnection({
    version: '1',
    connectionId: identity.connectionId,
    ownerId: identity.ownerId,
    pluginId: identity.pluginId,
    alias: identity.alias,
    label: verified.label,
    ...(verified.externalTenantId ? { externalTenantId: verified.externalTenantId } : {}),
    ...(verified.externalSubjectId ? { externalSubjectId: verified.externalSubjectId } : {}),
    authorization: verified.authorization,
    status: 'active',
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

export function connectionGrant(
  identity: Pick<ConnectionGrant, 'grantId' | 'ownerId' | 'connectionId'>,
  policy: Omit<ConnectionGrant, 'version' | 'grantId' | 'ownerId' | 'connectionId'>,
): ConnectionGrant {
  return validateConnectionGrant({
    version: '1', grantId: identity.grantId, ownerId: identity.ownerId, connectionId: identity.connectionId, ...policy,
  });
}

export function sameProviderIdentity(connection: IntegrationConnection, verified: VerifiedIntegrationCredential): boolean {
  return verified.authorization.scheme === connection.authorization.scheme &&
    (verified.externalTenantId ?? '') === (connection.externalTenantId ?? '') &&
    (verified.externalSubjectId ?? '') === (connection.externalSubjectId ?? '');
}

/** Refresh mutable provider metadata after the service has checked account identity. */
export function refreshedConnection(
  connection: IntegrationConnection,
  verified: VerifiedIntegrationCredential,
  timestamp: string,
): IntegrationConnection {
  return validateIntegrationConnection({
    ...connection,
    label: verified.label,
    authorization: verified.authorization,
    status: 'active',
    updatedAt: timestamp,
  });
}

export function connectionWithStatus(
  connection: IntegrationConnection,
  status: IntegrationConnection['status'],
  timestamp: string,
): IntegrationConnection {
  return validateIntegrationConnection({ ...connection, status, updatedAt: timestamp });
}

export function untestedConnectionHealth(ownerId: string, connectionId: string): ConnectionHealth {
  return validateConnectionHealth({ version: '1', ownerId, connectionId, status: 'unknown', code: 'not-tested' });
}

/** Retain the last opposite outcome while recording a new check with an explicit time. */
export function connectionHealthObservation(
  connection: Pick<IntegrationConnection, 'ownerId' | 'connectionId'>,
  previous: ConnectionHealth,
  status: ConnectionHealth['status'],
  code: ConnectionHealth['code'],
  timestamp: string,
): ConnectionHealth {
  return validateConnectionHealth({
    version: '1',
    ownerId: connection.ownerId,
    connectionId: connection.connectionId,
    status,
    code,
    checkedAt: timestamp,
    ...(status === 'healthy'
      ? { lastHealthyAt: timestamp, ...(previous.lastFailureAt ? { lastFailureAt: previous.lastFailureAt } : {}) }
      : { lastFailureAt: timestamp, ...(previous.lastHealthyAt ? { lastHealthyAt: previous.lastHealthyAt } : {}) }),
  });
}

export function connectionCredentialName(prefix: string, ownerId: string, connectionId: string): string {
  return [prefix.replace(/\/$/, ''), sha256Hex(ownerId).slice(0, 32), connectionId].join('/');
}

export function defaultAlias(pluginId: string, label: string): string {
  const account = label
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
  return `${pluginId}${account ? `-${account}` : ''}`.slice(0, 128);
}

export function aliasCandidate(base: string, suffix: number): string {
  const ending = suffix === 1 ? '' : `-${suffix}`;
  return `${base.slice(0, 128 - ending.length)}${ending}`;
}
