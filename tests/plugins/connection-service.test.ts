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
import type { IntegrationStore } from '../../src/plugins/integration-types.js';
import { createBuiltinIntegrationPlugins } from '../../src/plugins/integrations/builtins.js';

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
      authorization: {
        scheme: 'api-key',
        access: 'full',
        scopeModel: 'coarse',
        scopes: [],
      },
      credential: { token: 'must-never-enter-dynamo' },
      externalTenantId: 'T123',
      grant: { preset: 'read-only' },
    });

    expect(result.connection).toMatchObject({
      connectionId: 'id-1',
      alias: 'slack-shop',
      pluginId: 'slack',
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
      authorization: { scheme: 'api-key', access: 'full', scopeModel: 'coarse', scopes: [] },
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
      authorization: { scheme: 'api-key', access: 'full', scopeModel: 'coarse', scopes: [] },
      credential: { token: 'not-stored' },
      grant: { preset: 'read-only' },
    })).rejects.toThrow('safe ASCII');
    expect(state.connections).toEqual([]);
  });
});

function connection(connectionId: string, alias: string, pluginId: string): IntegrationConnection {
  return {
    version: '1',
    connectionId,
    ownerId: 'api:owner-1',
    pluginId,
    alias,
    authorization: { scheme: 'api-key', access: 'full', scopeModel: 'coarse', scopes: [] },
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
    registry: new IntegrationPluginRegistry(createBuiltinIntegrationPlugins()),
    credentialNamePrefix: 'rat-things/connections',
    ids: { random: () => `id-${++id}` },
    clock: { now: () => new Date('2026-08-20T00:00:00.000Z') },
  });
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
