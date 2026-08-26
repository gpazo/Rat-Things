import { describe, expect, it, vi } from 'vitest';
import type { IntegrationCredentialBinding } from '../../src/credentials/types.js';
import type {
  ConnectionGrant,
  ConnectionSet,
  IntegrationConnection,
  SourceCapabilityBinding,
} from '../../src/domain/capabilities.js';
import { ConnectionService } from '../../src/plugins/connection-service.js';
import { IntegrationPluginRegistry } from '../../src/plugins/integration-registry.js';
import type { IntegrationPlugin, IntegrationStore } from '../../src/plugins/integration-types.js';

describe('connection service', () => {
  it('stores credentials separately and returns only connection metadata plus its grant', async () => {
    const state = memoryStore();
    const create = vi.fn().mockResolvedValue(
      'arn:aws:secretsmanager:us-east-1:123456789012:secret:rat/connections/secret',
    );
    const service = connectionService(state.store, {
      create,
      replace: vi.fn(),
      revoke: vi.fn(),
    });

    const result = await service.create({
      ownerId: 'api:owner-1',
      pluginId: 'slack',
      alias: 'slack-shop',
      authScheme: 'api-key',
      credential: { token: 'must-never-enter-dynamo' },
      grant: { preset: 'read-only' },
    });

    expect(result.connection).toMatchObject({
      connectionId: 'id-1',
      alias: 'slack-shop',
      label: 'Acme — Rat',
      pluginId: 'slack',
      externalTenantId: 'T123',
      externalSubjectId: 'U123',
      authorization: { scheme: 'api-key', access: 'full', scopeModel: 'unknown', scopes: [] },
      status: 'active',
    });
    expect(result.grant).toMatchObject({ connectionId: 'id-1', preset: 'read-only' });
    expect(JSON.stringify(result)).not.toContain('must-never-enter-dynamo');
    expect(JSON.stringify(result)).not.toContain('secretsmanager');
    expect(create).toHaveBeenCalledWith(
      expect.stringMatching(/^rat-things\/connections\/[a-f0-9]{32}\/id-1$/),
      { token: 'must-never-enter-dynamo' },
    );
    expect(state.bindings[0]?.reference).toContain('secretsmanager');
    expect(JSON.stringify(state.connections)).not.toContain('must-never-enter-dynamo');
    expect(JSON.stringify(state.grants)).not.toContain('must-never-enter-dynamo');
  });

  it('creates a reusable set from multiple account aliases', async () => {
    const state = memoryStore();
    state.connections.push(
      connection('slack-1', 'slack-shop', 'slack'),
      connection('stripe-1', 'stripe-shop', 'stripe'),
    );
    const service = connectionService(state.store, {
      create: vi.fn(),
      replace: vi.fn(),
      revoke: vi.fn(),
    });

    await expect(service.createSet({
      ownerId: 'api:owner-1',
      name: 'Shop operations',
      connections: ['slack-shop', 'stripe-shop'],
      defaults: { messaging: 'slack-shop', billing: 'stripe-shop' },
    })).resolves.toMatchObject({
      connectionSetId: 'id-1',
      name: 'Shop operations',
      connectionIds: ['slack-1', 'stripe-1'],
      defaults: { messaging: 'slack-1', billing: 'stripe-1' },
    });
  });

  it('schedules a newly created secret for recovery when metadata persistence fails', async () => {
    const state = memoryStore();
    state.store.putConnectionBundle = vi.fn().mockRejectedValue(new Error('Dynamo unavailable'));
    const revoke = vi.fn().mockResolvedValue(undefined);
    const service = connectionService(state.store, {
      create: vi.fn().mockResolvedValue('secret-ref'),
      replace: vi.fn(),
      revoke,
    });

    await expect(service.create({
      ownerId: 'api:owner-1',
      pluginId: 'stripe',
      alias: 'stripe-shop',
      authScheme: 'api-key',
      credential: { api_key: 'sk_test_secret' },
      grant: { preset: 'read-only' },
    })).rejects.toThrow('Dynamo unavailable');
    expect(revoke).toHaveBeenCalledWith('secret-ref');
  });

  it('rejects grant operation IDs that are not installed by the connection plugin', async () => {
    const state = memoryStore();
    state.connections.push(connection('slack-1', 'slack-shop', 'slack'));
    const create = vi.fn();
    const service = connectionService(state.store, {
      create,
      replace: vi.fn(),
      revoke: vi.fn(),
    });

    await expect(service.replaceGrant('api:owner-1', 'slack-shop', {
      preset: 'custom',
      allowOperations: ['slack.channels.erase-everything'],
    })).rejects.toThrow('is not installed by plugin slack');
    expect(state.grants).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects aliases that cannot round-trip through one API path segment', async () => {
    const state = memoryStore();
    const service = connectionService(state.store, {
      create: vi.fn(),
      replace: vi.fn(),
      revoke: vi.fn(),
    });

    await expect(service.create({
      ownerId: 'api:owner-1',
      pluginId: 'slack',
      alias: 'client/slack',
      authScheme: 'api-key',
      credential: { token: 'not-stored' },
      grant: { preset: 'read-only' },
    })).rejects.toThrow('safe ASCII');
    expect(state.connections).toEqual([]);
  });

  it('verifies credentials before creating a secret and derives a unique account alias', async () => {
    const state = memoryStore();
    state.connections.push(connection('existing', 'slack-acme-rat', 'slack'));
    const create = vi.fn().mockResolvedValue('secret-ref');
    const service = connectionService(state.store, {
      create,
      replace: vi.fn(),
      revoke: vi.fn(),
    });

    await expect(service.create({
      ownerId: 'api:owner-1',
      pluginId: 'slack',
      authScheme: 'api-key',
      credential: { token: 'invalid' },
      grant: { preset: 'read-only' },
    })).rejects.toThrow('slack could not verify the supplied credential');
    expect(create).not.toHaveBeenCalled();

    await expect(service.create({
      ownerId: 'api:owner-1',
      pluginId: 'slack',
      authScheme: 'api-key',
      credential: { token: 'valid' },
      grant: { preset: 'read-only' },
    })).resolves.toMatchObject({
      connection: { alias: 'slack-acme-rat-2', label: 'Acme — Rat' },
    });
  });

  it('rejects credential rotation to another provider account', async () => {
    const state = memoryStore();
    state.connections.push(connection('slack-1', 'slack-shop', 'slack'));
    state.bindings.push({
      version: '1',
      ownerId: 'api:owner-1',
      connectionId: 'slack-1',
      reference: 'secret-ref',
      createdAt: '2026-08-20T00:00:00.000Z',
      updatedAt: '2026-08-20T00:00:00.000Z',
    });
    const replace = vi.fn();
    const service = connectionService(state.store, {
      create: vi.fn(),
      replace,
      revoke: vi.fn(),
    });

    await expect(service.rotate('api:owner-1', 'slack-shop', { token: 'other-account' }))
      .rejects.toThrow('different provider account');
    expect(replace).not.toHaveBeenCalled();
  });
});

function connection(connectionId: string, alias: string, pluginId: string): IntegrationConnection {
  return {
    version: '1',
    connectionId,
    ownerId: 'api:owner-1',
    pluginId,
    alias,
    label: alias,
    externalTenantId: pluginId === 'slack' ? 'T123' : 'acct_123',
    ...(pluginId === 'slack' ? { externalSubjectId: 'U123' } : {}),
    authorization: { scheme: 'api-key', access: 'full', scopeModel: 'unknown', scopes: [] },
    status: 'active',
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
  };
}

function connectionService(store: IntegrationStore, vault: {
  create: ReturnType<typeof vi.fn>;
  replace: ReturnType<typeof vi.fn>;
  revoke: ReturnType<typeof vi.fn>;
}) {
  let id = 0;
  return new ConnectionService({
    store,
    vault,
    registry: new IntegrationPluginRegistry([
      testPlugin('slack', 'token'),
      testPlugin('stripe', 'api_key'),
    ]),
    credentialNamePrefix: 'rat-things/connections',
    ids: { random: () => `id-${++id}` },
    clock: { now: () => new Date('2026-08-20T00:00:00.000Z') },
  });
}

function testPlugin(id: 'slack' | 'stripe', credentialField: string): IntegrationPlugin {
  return {
    manifest: {
      id,
      version: '1',
      title: id,
      description: `${id} test plugin`,
      authentication: [{
        scheme: 'api-key',
        title: 'API key',
        fields: [{ key: credentialField, label: 'API key', secret: true }],
      }],
      operations: [{
        id: `${id}.records.search`,
        title: 'Search records',
        kind: 'search',
        access: 'read',
        risk: 'routine',
      }],
    },
    verifyCredential: async (scheme, credential) => {
      const value = credential[credentialField];
      if (value === 'invalid') throw new Error('credential was rejected');
      const other = value === 'other-account';
      return id === 'slack'
        ? {
          label: other ? 'Other — User' : 'Acme — Rat',
          externalTenantId: other ? 'T999' : 'T123',
          externalSubjectId: other ? 'U999' : 'U123',
          authorization: { scheme, access: 'full', scopeModel: 'unknown', scopes: [] },
        }
        : {
          label: 'Acme Stripe',
          externalTenantId: 'acct_123',
          authorization: { scheme, access: 'full', scopeModel: 'unknown', scopes: [] },
        };
    },
    execute: async () => ({ ok: true }),
  };
}

function memoryStore() {
  const connections: IntegrationConnection[] = [];
  const grants: ConnectionGrant[] = [];
  const bindings: IntegrationCredentialBinding[] = [];
  const sets: ConnectionSet[] = [];
  const sourceBindings: SourceCapabilityBinding[] = [];
  const store: IntegrationStore = {
    listConnections: async (ownerId) => connections.filter((item) => item.ownerId === ownerId),
    getConnection: async (ownerId, selector) => connections.find((item) => (
      item.ownerId === ownerId && (item.connectionId === selector || item.alias === selector)
    )),
    putConnection: async (value) => {
      const index = connections.findIndex((item) => item.connectionId === value.connectionId);
      if (index === -1) connections.push(value);
      else connections[index] = value;
    },
    putConnectionBundle: async (value, binding, grant) => {
      connections.push(value);
      bindings.push(binding);
      grants.push(grant);
    },
    putCredentialBinding: async (value) => {
      bindings.push(value);
    },
    getCredentialBinding: async (ownerId, connectionId) => bindings.find((item) => (
      item.ownerId === ownerId && item.connectionId === connectionId
    )),
    putGrant: async (value) => {
      grants.push(value);
    },
    getGrant: async (ownerId, connectionId) => grants.find((item) => (
      item.ownerId === ownerId && item.connectionId === connectionId
    )),
    putConnectionSet: async (value) => {
      sets.push(value);
    },
    getConnectionSet: async (ownerId, selector) => sets.find((item) => (
      item.ownerId === ownerId && (item.connectionSetId === selector || item.name === selector)
    )),
    listConnectionSets: async (ownerId) => sets.filter((item) => item.ownerId === ownerId),
    putSourceBinding: async (value) => {
      sourceBindings.push(value);
    },
    listSourceBindings: async (ownerId) => sourceBindings.filter((item) => item.ownerId === ownerId),
    matchingSourceBindings: async (sourceKind) => sourceBindings.filter(
      (item) => item.sourceKind === sourceKind,
    ),
  };
  return { store, connections, grants, bindings, sets, sourceBindings };
}
