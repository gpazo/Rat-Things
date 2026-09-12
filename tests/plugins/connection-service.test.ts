import { describe, expect, it, vi } from 'vitest';
import type { IntegrationCredentialBinding } from '../../src/credentials/types.js';
import type {
  ConnectionHealth,
  ConnectionGrant,
  ConnectionSet,
  IntegrationConnection,
  SourceCapabilityBinding,
} from '../../src/domain/capabilities.js';
import { ValidationError } from '../../src/domain/validation.js';
import { ConnectionService, CredentialVerificationError, type ConnectionServiceOptions } from '../../src/plugins/connection-service.js';
import { IntegrationPluginRegistry } from '../../src/plugins/integration-registry.js';
import {
  IntegrationProviderUnavailableError,
  type IntegrationPlugin,
  type IntegrationStore,
} from '../../src/plugins/integration-types.js';

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

  it('reports failed secret cleanup without replacing the persistence error', async () => {
    const state = memoryStore();
    const persistenceError = new Error('Dynamo unavailable');
    state.store.putConnectionBundle = vi.fn().mockRejectedValue(persistenceError);
    const metricLines: string[] = [];
    const log = vi.spyOn(console, 'info').mockImplementation((line) => {
      metricLines.push(String(line));
    });
    const service = connectionService(state.store, {
      create: vi.fn().mockResolvedValue('secret-ref'),
      replace: vi.fn(),
      revoke: vi.fn().mockRejectedValue(new Error('Secrets Manager unavailable')),
    });
    try {
      await expect(service.create({
        ownerId: 'api:owner-1',
        pluginId: 'stripe',
        alias: 'stripe-shop',
        authScheme: 'api-key',
        credential: { api_key: 'sk_test_secret' },
        grant: { preset: 'read-only' },
      })).rejects.toBe(persistenceError);
      expect(metricLines.map((line) => JSON.parse(line) as unknown)).toContainEqual(
        expect.objectContaining({ Component: 'connection-service', CleanupFailure: 1 }),
      );
    } finally {
      log.mockRestore();
    }
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

  it('reactivates the same provider account after a verified credential reconnect', async () => {
    const state = memoryStore();
    state.connections.push({ ...connection('slack-1', 'slack-shop', 'slack'), status: 'expired' });
    state.bindings.push(binding('slack-1'));
    const replace = vi.fn().mockResolvedValue(undefined);
    const service = connectionService(state.store, {
      create: vi.fn(),
      replace,
      revoke: vi.fn(),
    });

    await expect(service.rotate('api:owner-1', 'slack-shop', { token: 'valid' })).resolves.toMatchObject({
      connection: { connectionId: 'slack-1', alias: 'slack-shop', status: 'active' },
      health: { status: 'healthy', code: 'verified' },
    });
    expect(replace).toHaveBeenCalledWith('secret-ref', { token: 'valid' });
    expect(state.connections).toHaveLength(1);
    expect(state.health).toEqual([expect.objectContaining({ connectionId: 'slack-1', status: 'healthy' })]);
  });

  it('keeps the stable alias when an operator changes the display name', async () => {
    const state = memoryStore();
    state.connections.push(connection('slack-1', 'slack-shop', 'slack'));
    const service = connectionService(state.store, vault());

    await expect(service.list('api:owner-1')).resolves.toEqual([
      expect.objectContaining({
        connection: expect.objectContaining({ alias: 'slack-shop' }),
        health: expect.objectContaining({ status: 'unknown', code: 'not-tested' }),
      }),
    ]);
    await expect(service.rename('api:owner-1', 'slack-shop', 'Support workspace'))
      .resolves.toMatchObject({ alias: 'slack-shop', displayName: 'Support workspace' });
    expect(state.connections[0]).toMatchObject({
      connectionId: 'slack-1',
      alias: 'slack-shop',
      displayName: 'Support workspace',
    });
  });

  it('tests a connection through the trusted credential reader and stores only bounded health', async () => {
    const state = memoryStore();
    state.connections.push(connection('slack-1', 'slack-shop', 'slack'));
    state.bindings.push(binding('slack-1'));
    const readRecord = vi.fn().mockResolvedValue({ token: 'valid' });
    const service = connectionService(state.store, vault(), { readRecord });

    const result = await service.test('api:owner-1', 'slack-shop');

    expect(readRecord).toHaveBeenCalledWith('secret-ref', expect.objectContaining({ alias: 'slack-shop' }));
    expect(result).toMatchObject({
      connection: { status: 'active', alias: 'slack-shop' },
      health: { status: 'healthy', code: 'verified', checkedAt: '2026-08-20T00:00:00.000Z' },
    });
    expect(JSON.stringify(result)).not.toContain('valid');
    expect(JSON.stringify(state.health)).not.toContain('secret-ref');
  });

  it('requires reauthentication when the stored credential resolves to another provider identity', async () => {
    const state = memoryStore();
    state.connections.push(connection('slack-1', 'slack-shop', 'slack'));
    state.bindings.push(binding('slack-1'));
    const service = connectionService(state.store, vault(), {
      readRecord: vi.fn().mockResolvedValue({ token: 'other-account' }),
    });

    await expect(service.test('api:owner-1', 'slack-shop')).resolves.toMatchObject({
      connection: { status: 'expired' },
      health: { status: 'reauth-required', code: 'identity-mismatch' },
    });
  });

  it('reports provider downtime without expiring an otherwise active connection', async () => {
    const state = memoryStore();
    state.connections.push(connection('slack-1', 'slack-shop', 'slack'));
    state.bindings.push(binding('slack-1'));
    const service = connectionService(state.store, vault(), {
      readRecord: vi.fn().mockResolvedValue({ token: 'unavailable' }),
    });

    await expect(service.test('api:owner-1', 'slack-shop')).resolves.toMatchObject({
      connection: { status: 'active' },
      health: { status: 'degraded', code: 'provider-unavailable' },
    });
  });
});

describe('connection lifecycle effect boundaries', () => {
  it('verifies and resolves aliases before consuming IDs, then validates before creating a secret', async () => {
    const state = memoryStore();
    const events: string[] = [];
    const plugin = testPlugin('slack', 'token');
    const verify = plugin.verifyCredential;
    plugin.verifyCredential = vi.fn(async (...args: Parameters<IntegrationPlugin['verifyCredential']>) => {
      events.push('verify'); return verify(...args);
    });
    state.store.getConnection = vi.fn(async (_owner, alias) => {
      events.push(`alias:${alias}`);
      return alias === 'slack-acme-rat' ? connection('existing', alias, 'slack') : undefined;
    });
    state.store.putConnectionBundle = vi.fn(async () => { events.push('bundle'); });
    const secrets = vault();
    secrets.create.mockImplementation(async () => { events.push('secret'); return 'secret-ref'; });
    let id = 0;
    const service = connectionService(state.store, secrets, undefined, {
      registry: new IntegrationPluginRegistry([plugin]),
      ids: { random: () => { events.push(`id:${++id}`); return `id-${id}`; } },
      clock: { now: () => { events.push('clock'); return new Date('2026-08-20T00:00:00.000Z'); } },
    });
    const input = createInput();
    await service.create(input);
    expect(events).toEqual(['verify', 'alias:slack-acme-rat', 'alias:slack-acme-rat-2', 'id:1', 'clock', 'id:2', 'secret', 'bundle']);
    events.length = 0;
    await expect(service.create({ ...input, grant: { preset: 'custom', allowOperations: ['slack.records.delete'] } }))
      .rejects.toThrow('is not installed');
    expect(events).toEqual(['verify', 'alias:slack-acme-rat', 'alias:slack-acme-rat-2', 'id:3', 'clock', 'id:4']);
  });

  it('rejects malformed verified metadata before generating a grant ID or storing credentials', async () => {
    const state = memoryStore();
    const plugin = testPlugin('slack', 'token');
    const verified = await plugin.verifyCredential('api-key', { token: 'valid' });
    plugin.verifyCredential = vi.fn().mockResolvedValue({ ...verified, label: '' });
    const ids = { random: vi.fn().mockReturnValue('id-1') };
    const secrets = vault();
    const service = connectionService(state.store, secrets, undefined, {
      registry: new IntegrationPluginRegistry([plugin]), ids,
    });
    await expect(service.create(createInput())).rejects.toThrow('connection label');
    expect(ids.random).toHaveBeenCalledTimes(1);
    expect(secrets.create).not.toHaveBeenCalled();
  });

  it('validates credential fields before verification and sanitizes provider rejection', async () => {
    const state = memoryStore();
    const plugin = testPlugin('slack', 'token');
    const verify = vi.spyOn(plugin, 'verifyCredential');
    const lookup = vi.spyOn(state.store, 'getConnection');
    const service = connectionService(state.store, vault(), undefined, { registry: new IntegrationPluginRegistry([plugin]) });
    await expect(service.create({ ...createInput(), credential: { unexpected: 'private-value' } }))
      .rejects.toThrow('integration credential requires token');
    expect(verify).not.toHaveBeenCalled();
    await expect(service.create({ ...createInput(), credential: { token: 'invalid' } }))
      .rejects.toBeInstanceOf(CredentialVerificationError);
    const unavailable = new IntegrationProviderUnavailableError('slack');
    verify.mockRejectedValueOnce(unavailable);
    await expect(service.create(createInput())).rejects.toBe(unavailable);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('stops alias allocation at the existing bound without generating an ID', async () => {
    const state = memoryStore();
    const lookup = vi.spyOn(state.store, 'getConnection').mockResolvedValue(connection('existing', 'slack-acme-rat', 'slack'));
    const ids = { random: vi.fn() };
    const service = connectionService(state.store, vault(), undefined, { ids });
    await expect(service.create(createInput())).rejects.toThrow('could not allocate a connection alias');
    expect(lookup).toHaveBeenCalledTimes(1_000);
    expect(lookup).toHaveBeenLastCalledWith('api:owner-1', 'slack-acme-rat-1000');
    expect(ids.random).not.toHaveBeenCalled();
  });

  it('replaces a secret before updating binding, connection, and health with separate clock reads', async () => {
    const state = memoryStore();
    state.connections.push(connection('slack-1', 'slack-shop', 'slack'));
    state.bindings.push(binding('slack-1'));
    const events: string[] = [];
    const secrets = vault();
    secrets.replace.mockImplementation(async () => { events.push('replace'); });
    vi.spyOn(state.store, 'putCredentialBinding').mockImplementation(async () => { events.push('binding'); });
    vi.spyOn(state.store, 'putConnection').mockImplementation(async () => { events.push('connection'); });
    state.store.getConnectionHealth = vi.fn(async () => { events.push('read-health'); return undefined; });
    state.store.putConnectionHealth = vi.fn(async () => { events.push('health'); });
    let tick = 0;
    const service = connectionService(state.store, secrets, undefined, {
      clock: { now: () => { events.push('clock'); return new Date(Date.parse('2026-08-20T00:00:00.000Z') + tick++ * 1_000); } },
    });
    const result = await service.rotate('api:owner-1', 'slack-shop', { token: 'valid' });
    expect(events).toEqual(['replace', 'clock', 'binding', 'connection', 'read-health', 'clock', 'health']);
    expect(result.connection.updatedAt).toBe('2026-08-20T00:00:00.000Z');
    expect(result.health.checkedAt).toBe('2026-08-20T00:00:01.000Z');
  });

  it('retains secret replacement when the binding write fails and stops before updating the connection', async () => {
    const state = memoryStore();
    state.connections.push(connection('slack-1', 'slack-shop', 'slack'));
    state.bindings.push(binding('slack-1'));
    const failure = new Error('binding unavailable');
    vi.spyOn(state.store, 'putCredentialBinding').mockRejectedValue(failure);
    const write = vi.spyOn(state.store, 'putConnection');
    const health = vi.spyOn(state.store, 'getConnectionHealth');
    const secrets = vault();
    const service = connectionService(state.store, secrets);
    await expect(service.rotate('api:owner-1', 'slack-shop', { token: 'valid' })).rejects.toBe(failure);
    expect(secrets.replace).toHaveBeenCalledWith('secret-ref', { token: 'valid' });
    expect(write).not.toHaveBeenCalled();
    expect(health).not.toHaveBeenCalled();
    expect(secrets.revoke).not.toHaveBeenCalled();
  });

  it('keeps an already expired connection unchanged when credentials are missing but records health', async () => {
    const state = memoryStore();
    const current = { ...connection('slack-1', 'slack-shop', 'slack'), status: 'expired' as const };
    state.connections.push(current);
    const write = vi.spyOn(state.store, 'putConnection');
    const now = vi.fn(() => new Date('2026-08-20T00:00:01.000Z'));
    const result = await connectionService(state.store, vault(), undefined, { clock: { now } }).test('api:owner-1', 'slack-shop');
    expect(result.connection).toBe(current);
    expect(result.health).toMatchObject({ status: 'reauth-required', code: 'credential-missing' });
    expect(write).not.toHaveBeenCalled();
    expect(now).toHaveBeenCalledTimes(1);
  });

  it('retains the verification catch boundary around persistence validation errors', async () => {
    const state = memoryStore();
    state.connections.push(connection('slack-1', 'slack-shop', 'slack'));
    state.bindings.push(binding('slack-1'));
    const write = vi.spyOn(state.store, 'putConnection').mockRejectedValueOnce(new ValidationError('persistence rejected active metadata'));
    const service = connectionService(state.store, vault(), { readRecord: vi.fn().mockResolvedValue({ token: 'valid' }) });
    await expect(service.test('api:owner-1', 'slack-shop')).resolves.toMatchObject({
      connection: { status: 'expired' }, health: { status: 'reauth-required', code: 'credential-rejected' },
    });
    expect(write.mock.calls.map(([value]) => value.status)).toEqual(['active', 'expired']);
  });

  it('validates display names after ownership lookup and before reading the clock', async () => {
    const state = memoryStore();
    const now = vi.fn();
    const service = connectionService(state.store, vault(), undefined, { clock: { now } });
    await expect(service.rename('api:owner-1', 'missing', '')).rejects.toThrow('integration connection not found');
    state.connections.push(connection('slack-1', 'slack-shop', 'slack'));
    await expect(service.rename('api:owner-1', 'slack-shop', '  ')).rejects.toThrow('connection display name must be 1-256 UTF-8 bytes');
    expect(now).not.toHaveBeenCalled();
  });

  it('persists revocation before reading and revoking its secret, preserving a failed cleanup', async () => {
    const state = memoryStore();
    state.connections.push(connection('slack-1', 'slack-shop', 'slack'));
    state.bindings.push(binding('slack-1'));
    const events: string[] = [];
    const put = state.store.putConnection;
    vi.spyOn(state.store, 'putConnection').mockImplementation(async value => { events.push('connection'); await put(value); });
    const get = state.store.getCredentialBinding;
    vi.spyOn(state.store, 'getCredentialBinding').mockImplementation(async (...args) => { events.push('binding'); return get(...args); });
    const failure = new Error('secret unavailable');
    const secrets = vault();
    secrets.revoke.mockImplementation(async () => { events.push('revoke'); throw failure; });
    const service = connectionService(state.store, secrets);
    await expect(service.revoke('api:owner-1', 'slack-shop')).rejects.toBe(failure);
    expect(events).toEqual(['connection', 'binding', 'revoke']);
    expect(state.connections[0]?.status).toBe('revoked');
  });
});

function createInput() {
  return { ownerId: 'api:owner-1', pluginId: 'slack', authScheme: 'api-key' as const,
    credential: { token: 'valid' }, grant: { preset: 'read-only' as const } };
}

function vault() {
  return { create: vi.fn(), replace: vi.fn(), revoke: vi.fn() };
}

function binding(connectionId: string): IntegrationCredentialBinding {
  return {
    version: '1',
    ownerId: 'api:owner-1',
    connectionId,
    reference: 'secret-ref',
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
  };
}

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
}, credentials?: {
  readRecord: ReturnType<typeof vi.fn>;
}, overrides: Partial<ConnectionServiceOptions> = {}) {
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
    ...(credentials ? { credentials } : {}),
    ...overrides,
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
      if (value === 'unavailable') throw new IntegrationProviderUnavailableError(id);
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
  const health: ConnectionHealth[] = [];
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
    putConnectionHealth: async (value) => {
      const index = health.findIndex((item) => item.connectionId === value.connectionId);
      if (index === -1) health.push(value);
      else health[index] = value;
    },
    getConnectionHealth: async (ownerId, connectionId) => health.find((item) => (
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
  return { store, connections, grants, bindings, sets, sourceBindings, health };
}
