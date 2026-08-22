import { describe, expect, it } from 'vitest';
import {
  authorizeConnectionOperation,
  sourceBindingMatches,
  validateConnectionGrant,
  validateConnectionSet,
  validateIntegrationConnection,
  validateOperationDefinition,
  validateSourceCapabilityBinding,
} from '../../src/domain/capabilities.js';
import type {
  ConnectionGrant,
  IntegrationConnection,
  OperationDefinition,
} from '../../src/domain/capabilities.js';

const now = '2026-08-20T12:00:00.000Z';

function connection(overrides: Partial<IntegrationConnection> = {}): IntegrationConnection {
  return {
    version: '1',
    connectionId: 'google-work',
    ownerId: 'owner-1',
    pluginId: 'google-workspace',
    alias: 'work-google',
    label: 'Work Google',
    authorization: {
      scheme: 'api-key',
      access: 'full',
      scopeModel: 'coarse',
      scopes: [],
    },
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function grant(overrides: Partial<ConnectionGrant> = {}): ConnectionGrant {
  return {
    version: '1',
    grantId: 'support-read',
    ownerId: 'owner-1',
    connectionId: 'google-work',
    preset: 'read-only',
    ...overrides,
  };
}

function operation(overrides: Partial<OperationDefinition> = {}): OperationDefinition {
  return {
    id: 'gmail.messages.search',
    title: 'Search messages',
    kind: 'search',
    access: 'read',
    risk: 'routine',
    defaultApproval: 'never',
    ...overrides,
  };
}

describe('integration capability contracts', () => {
  it('uses a Rat grant to reduce a coarse full-access credential to read-only', () => {
    expect(authorizeConnectionOperation({
      connection: connection(),
      grant: grant(),
      operation: operation(),
    })).toEqual({
      allowed: true,
      requiresApproval: false,
      approval: 'never',
      enforcement: 'broker',
    });

    expect(authorizeConnectionOperation({
      connection: connection(),
      grant: grant(),
      operation: operation({
        id: 'gmail.messages.send',
        title: 'Send message',
        kind: 'action',
        access: 'write',
        risk: 'consequential',
        defaultApproval: 'on-request',
      }),
    })).toMatchObject({
      allowed: false,
      reason: 'operation requires write access',
    });
  });

  it('requires both provider scopes and broker permission for granular OAuth', () => {
    const oauth = connection({
      authorization: {
        scheme: 'oauth2',
        access: 'write',
        scopeModel: 'granular',
        scopes: ['gmail.readonly'],
      },
    });
    const send = operation({
      id: 'gmail.messages.send',
      title: 'Send message',
      kind: 'action',
      access: 'write',
      risk: 'consequential',
      requiredProviderScopes: ['gmail.send'],
      defaultApproval: 'on-request',
    });
    expect(authorizeConnectionOperation({
      connection: oauth,
      grant: grant({ preset: 'read-write' }),
      operation: send,
    })).toMatchObject({
      allowed: false,
      enforcement: 'provider-and-broker',
      reason: 'provider authorization is missing a required scope',
    });

    expect(authorizeConnectionOperation({
      connection: connection({
        authorization: { ...oauth.authorization, scopes: ['gmail.readonly', 'gmail.send'] },
      }),
      grant: grant({ preset: 'read-write' }),
      operation: send,
    })).toEqual({
      allowed: true,
      requiresApproval: true,
      approval: 'on-request',
      enforcement: 'provider-and-broker',
    });
  });

  it('applies deny rules before presets and allowlists', () => {
    expect(authorizeConnectionOperation({
      connection: connection(),
      grant: grant({
        preset: 'full',
        allowOperations: ['gmail.messages.search'],
        denyOperations: ['gmail.messages.send'],
      }),
      operation: operation({ id: 'gmail.messages.send' }),
    })).toMatchObject({ allowed: false, reason: 'operation is explicitly denied' });
  });

  it('validates connection, operation, grant, set, and source binding records', () => {
    expect(validateIntegrationConnection(connection())).toEqual(connection());
    expect(validateOperationDefinition(operation())).toEqual(operation());
    expect(validateConnectionGrant(grant())).toEqual(grant());
    expect(validateConnectionSet({
      version: '1',
      connectionSetId: 'acme-operations',
      ownerId: 'owner-1',
      name: 'Acme operations',
      connectionIds: ['google-work', 'slack-acme'],
      defaults: { google: 'google-work' },
    })).toMatchObject({ connectionSetId: 'acme-operations' });
    expect(validateSourceCapabilityBinding({
      version: '1',
      bindingId: 'github-acme',
      ownerId: 'owner-1',
      sourceKind: 'github',
      selector: { repository: 'acme/support' },
      capabilityProfile: 'trusted-browser',
      connectionSetId: 'acme-operations',
    })).toMatchObject({ bindingId: 'github-acme' });
  });

  it('matches provider source bindings exactly', () => {
    const binding = validateSourceCapabilityBinding({
      version: '1',
      bindingId: 'github-acme',
      ownerId: 'owner-1',
      sourceKind: 'github',
      selector: { repository: 'acme/support', installationId: '42' },
    });
    expect(sourceBindingMatches(binding, {
      kind: 'github',
      deliveryId: 'delivery-1',
      event: 'issues',
      repository: 'acme/support',
      installationId: '42',
    })).toBe(true);
    expect(sourceBindingMatches(binding, {
      kind: 'github',
      deliveryId: 'delivery-2',
      event: 'issues',
      repository: 'other/support',
      installationId: '42',
    })).toBe(false);
  });

  it('rejects ambiguous custom grants and invalid connection-set defaults', () => {
    expect(() => validateConnectionGrant(grant({ preset: 'custom' })))
      .toThrow('custom grant requires allowed operations');
    expect(() => validateConnectionSet({
      version: '1',
      connectionSetId: 'acme',
      ownerId: 'owner-1',
      name: 'Acme',
      connectionIds: ['google-work'],
      defaults: { slack: 'slack-acme' },
    })).toThrow('default connection slack-acme is not in the connection set');
  });
});
