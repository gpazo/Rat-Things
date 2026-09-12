import { describe, expect, it } from 'vitest';
import {
  aliasCandidate,
  connectionCredentialName,
  connectionGrant,
  connectionHealthObservation,
  connectionWithStatus,
  defaultAlias,
  newConnection,
  refreshedConnection,
  sameProviderIdentity,
  untestedConnectionHealth,
} from '../../src/plugins/connection-planning.js';
import type { VerifiedIntegrationCredential } from '../../src/plugins/integration-types.js';
import { sha256Hex } from '../../src/domain/json.js';

const timestamp = '2026-08-20T00:00:00.000Z';
const later = '2026-08-21T00:00:00.000Z';
const identity = freeze({ connectionId: 'connection-1', ownerId: 'api:owner-1', pluginId: 'slack', alias: 'slack-shop' });
const verified = freeze<VerifiedIntegrationCredential>({
  label: 'Acme — Rat', externalTenantId: 'T123', externalSubjectId: 'U123',
  authorization: { scheme: 'api-key', access: 'full', scopeModel: 'unknown', scopes: [] },
});

describe('connection metadata calculations', () => {
  it('constructs detached metadata from verified values without retaining credential-shaped extras', () => {
    const input = freeze({ ...identity, credential: { token: 'private-token' }, reference: 'private-reference' });
    const proof = freeze({ ...verified, credential: { token: 'provider-token' } });
    const connection = newConnection(input, proof, timestamp);
    expect(connection).toEqual({ version: '1', ...identity, ...verified, status: 'active', createdAt: timestamp, updatedAt: timestamp });
    expect(connection.authorization).not.toBe(verified.authorization);
    connection.authorization.scopes.push('new-scope');
    expect(verified.authorization.scopes).toEqual([]);
    expect(JSON.stringify(connection)).not.toMatch(/token|reference/);
    expect(input.credential).toEqual({ token: 'private-token' });
  });

  it('omits absent and empty provider identifiers at creation', () => {
    const result = newConnection(identity, { label: verified.label, authorization: verified.authorization, externalTenantId: '' }, timestamp);
    expect(result).not.toHaveProperty('externalTenantId');
    expect(result).not.toHaveProperty('externalSubjectId');
  });

  it('refreshes provider metadata while preserving stable identity and caller ownership', () => {
    const connection = freeze({ ...newConnection(identity, verified, timestamp), status: 'expired' as const, displayName: 'Support' });
    const proof = freeze({ ...verified, label: 'Acme renamed', authorization: { ...verified.authorization, scopes: ['channels:read'] } });
    const before = structuredClone({ connection, proof });
    const active = refreshedConnection(connection, proof, later);
    expect(active).toEqual({ ...connection, label: 'Acme renamed', authorization: proof.authorization, status: 'active', updatedAt: later });
    expect(active).not.toBe(connection);
    expect(active.authorization).not.toBe(proof.authorization);
    expect({ connection, proof }).toEqual(before);
  });

  it('matches scheme, tenant, and subject independently of mutable labels or scopes', () => {
    const connection = freeze(newConnection(identity, verified, timestamp));
    expect(sameProviderIdentity(connection, { ...verified, label: 'Renamed', authorization: { ...verified.authorization, scopes: ['new-scope'] } })).toBe(true);
    expect(sameProviderIdentity(connection, { ...verified, authorization: { ...verified.authorization, scheme: 'oauth2' } })).toBe(false);
    expect(sameProviderIdentity(connection, { ...verified, externalTenantId: 'T999' })).toBe(false);
    expect(sameProviderIdentity(connection, { ...verified, externalSubjectId: 'U999' })).toBe(false);
    expect(sameProviderIdentity(connection, { label: verified.label, authorization: verified.authorization, externalTenantId: 'T123' })).toBe(false);
    const noIdentity = newConnection(identity, { label: verified.label, authorization: verified.authorization }, timestamp);
    expect(sameProviderIdentity(noIdentity, { ...verified, externalTenantId: '', externalSubjectId: '' })).toBe(true);
  });

  it.each(['active', 'expired', 'revoked'] as const)('produces a validated %s snapshot without changing the previous record', status => {
    const connection = freeze(newConnection(identity, verified, timestamp));
    const updated = connectionWithStatus(connection, status, later);
    expect(updated).toEqual({ ...connection, status, updatedAt: later });
    expect(updated).not.toBe(connection);
    expect(connection.updatedAt).toBe(timestamp);
  });

  it('rejects invalid snapshots and policies without mutating their inputs', () => {
    expect(() => newConnection(identity, { ...verified, label: '' }, timestamp)).toThrow('connection label');
    const policy = freeze({ preset: 'custom' as const, allowOperations: ['slack.records.search'], denyOperations: ['slack.records.search'] });
    expect(() => connectionGrant({ grantId: 'grant-1', ...identity }, policy)).toThrow('both allowed and denied');
    expect(policy.allowOperations).toEqual(['slack.records.search']);
  });

  it('retains explicit empty restrictions and detaches nested grant policy values', () => {
    const policy = freeze({ preset: 'read-only' as const, allowOperations: [], denyOperations: [], resourceConstraints: { channel: [] } });
    const grant = connectionGrant({ grantId: 'grant-1', ...identity }, policy);
    expect(grant).toEqual({ version: '1', grantId: 'grant-1', ownerId: identity.ownerId, connectionId: identity.connectionId, ...policy });
    expect(grant.resourceConstraints).not.toBe(policy.resourceConstraints);
    grant.resourceConstraints!.channel!.push('channel-1');
    expect(policy.resourceConstraints.channel).toEqual([]);
  });
});

describe('connection health history', () => {
  const connection = freeze(newConnection(identity, verified, timestamp));

  it('represents untested health without reading time or inventing prior checks', () => {
    expect(untestedConnectionHealth(identity.ownerId, identity.connectionId)).toEqual({
      version: '1', ownerId: identity.ownerId, connectionId: identity.connectionId, status: 'unknown', code: 'not-tested',
    });
  });

  it('retains the last failure through recovery and the last success through a later failure', () => {
    const previous = freeze({ ...untestedConnectionHealth(identity.ownerId, identity.connectionId), lastFailureAt: timestamp });
    const healthy = connectionHealthObservation(connection, previous, 'healthy', 'verified', later);
    expect(healthy).toEqual({ ...previous, status: 'healthy', code: 'verified', checkedAt: later, lastHealthyAt: later });
    const after = '2026-08-22T00:00:00.000Z';
    const degraded = connectionHealthObservation(connection, freeze(healthy), 'degraded', 'provider-unavailable', after);
    expect(degraded).toEqual({ ...healthy, status: 'degraded', code: 'provider-unavailable', checkedAt: after, lastFailureAt: after });
    expect(previous).not.toHaveProperty('checkedAt');
    expect(healthy.lastFailureAt).toBe(timestamp);
  });

  it('omits missing opposite history and binds the observation to the supplied connection', () => {
    const previous = freeze(untestedConnectionHealth('other-owner', 'other-connection'));
    const failed = connectionHealthObservation(connection, previous, 'reauth-required', 'credential-missing', timestamp);
    expect(failed).toMatchObject({ ownerId: identity.ownerId, connectionId: identity.connectionId, checkedAt: timestamp, lastFailureAt: timestamp });
    expect(failed).not.toHaveProperty('lastHealthyAt');
    const healthy = connectionHealthObservation(connection, previous, 'healthy', 'verified', timestamp);
    expect(healthy).not.toHaveProperty('lastFailureAt');
  });
});

describe('connection names', () => {
  it('normalizes account labels while retaining the plugin prefix and bounded length', () => {
    expect(defaultAlias('slack', ' Àcme — ＲＡＴ ')).toBe('slack-acme-rat');
    expect(defaultAlias('slack', '🌍 !!!')).toBe('slack');
    expect(defaultAlias('slack', 'x'.repeat(200))).toBe(`slack-${'x'.repeat(96)}`);
    expect(defaultAlias('p'.repeat(100), 'x'.repeat(200))).toHaveLength(128);
  });

  it('reserves suffix space without changing the base alias', () => {
    const base = 'x'.repeat(128);
    expect(aliasCandidate(base, 1)).toBe(base);
    expect(aliasCandidate(base, 2)).toBe(`${'x'.repeat(126)}-2`);
    expect(aliasCandidate(base, 1_000)).toBe(`${'x'.repeat(123)}-1000`);
  });

  it('scopes credential names by owner and removes exactly one trailing separator', () => {
    const suffix = `${sha256Hex(identity.ownerId).slice(0, 32)}/${identity.connectionId}`;
    expect(connectionCredentialName('connections', identity.ownerId, identity.connectionId)).toBe(`connections/${suffix}`);
    expect(connectionCredentialName('connections/', identity.ownerId, identity.connectionId)).toBe(`connections/${suffix}`);
    expect(connectionCredentialName('connections//', identity.ownerId, identity.connectionId)).toBe(`connections//${suffix}`);
    expect(connectionCredentialName('connections', 'other-owner', identity.connectionId)).not.toBe(`connections/${suffix}`);
  });
});

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
