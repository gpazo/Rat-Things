import { describe, expect, it, vi } from 'vitest';
import { CredentialBroker } from '../../src/credentials/broker.js';
import type {
  ConnectionGrant,
  IntegrationConnection,
} from '../../src/domain/capabilities.js';
import { IntegrationPluginRegistry } from '../../src/plugins/integration-registry.js';
import { IntegrationRuntime } from '../../src/plugins/integration-runtime.js';
import type {
  IntegrationPlugin,
  IntegrationStore,
} from '../../src/plugins/integration-types.js';

const now = '2026-08-20T00:00:00.000Z';

describe('integration tool runtime', () => {
  it('supports two accounts while intersecting provider, stored, and per-run permissions', async () => {
    const execute = vi.fn().mockImplementation((operationId, input, context) => Promise.resolve({
      operationId,
      input,
      account: context.connection.alias,
      authenticated: Boolean(context.credential.token),
    }));
    const plugin = mailPlugin(execute);
    const personal = connection('personal-id', 'mail-personal', 'full', ['mail.read', 'mail.send']);
    const business = connection('business-id', 'mail-business', 'full', ['mail.read', 'mail.send']);
    const store = memoryStore(
      [personal, business],
      [grant(personal, 'full'), grant(business, 'full')],
    );
    const getSecret = vi.fn().mockImplementation((reference: string) => Promise.resolve(
      JSON.stringify({ token: `${reference}-token` }),
    ));
    const runtime = new IntegrationRuntime({
      registry: new IntegrationPluginRegistry([plugin]),
      store,
      credentials: new CredentialBroker({ get: getSecret }),
    });

    const session = await runtime.prepare({
      ownerId: 'owner-1',
      request: {
        connections: [
          { connection: 'mail-personal', preset: 'read-only' },
          { connection: 'mail-business', preset: 'read-write' },
        ],
      },
    });

    expect(session.tools).toHaveLength(1);
    const tools = session.tools[0]?.tools ?? [];
    expect(tools.map((tool) => tool.name)).toEqual(['messages_search', 'messages_send']);
    expect(tools[0]?.inputSchema).toMatchObject({
      properties: { account: { enum: ['mail-personal', 'mail-business'] } },
    });
    expect(tools[1]?.inputSchema).toMatchObject({
      properties: { account: { enum: ['mail-business'] } },
    });

    await expect(session.call({
      namespace: 'mail',
      tool: 'messages_search',
      arguments: { account: 'mail-personal', input: { query: 'invoice' } },
    })).resolves.toMatchObject({ account: 'mail-personal', authenticated: true });
    await expect(session.call({
      namespace: 'mail',
      tool: 'messages_send',
      arguments: { account: 'mail-personal', input: { to: 'customer@example.com' } },
    })).rejects.toThrow('not authorized');
    await expect(session.call({
      namespace: 'mail',
      tool: 'messages_send',
      arguments: { account: 'mail-business', input: { to: 'customer@example.com' } },
    })).resolves.toMatchObject({ account: 'mail-business', authenticated: true });

    expect(getSecret).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('does not expose an operation when granular provider scopes are missing', async () => {
    const plugin = mailPlugin(vi.fn());
    const scoped = connection('scoped-id', 'mail-scoped', 'write', ['mail.read']);
    const runtime = new IntegrationRuntime({
      registry: new IntegrationPluginRegistry([plugin]),
      store: memoryStore([scoped], [grant(scoped, 'full')]),
      credentials: new CredentialBroker({ get: vi.fn() }),
    });
    const session = await runtime.prepare({
      ownerId: 'owner-1',
      request: { connections: [{ connection: 'mail-scoped', preset: 'read-write' }] },
    });

    expect(session.tools[0]?.tools.map((tool) => tool.name)).toEqual(['messages_search']);
  });

  it('applies a capability-profile integration ceiling to connection sets', async () => {
    const plugin = mailPlugin(vi.fn());
    const full = connection('full-id', 'mail-full', 'full', ['mail.read', 'mail.send']);
    const runtime = new IntegrationRuntime({
      registry: new IntegrationPluginRegistry([plugin]),
      store: memoryStore([full], [grant(full, 'full')]),
      credentials: new CredentialBroker({ get: vi.fn() }),
    });
    const session = await runtime.prepare({
      ownerId: 'owner-1',
      request: { connections: [{ connection: 'mail-full' }] },
      maximumIntegrationAccess: 'read-only',
    });

    expect(session.tools[0]?.tools.map((tool) => tool.name)).toEqual(['messages_search']);
  });

  it('accepts the equivalent flat operation input emitted by an agent', async () => {
    const execute = vi.fn().mockImplementation((_operationId, input) => Promise.resolve(input));
    const personal = connection('personal-id', 'mail-personal', 'full', ['mail.read']);
    const runtime = new IntegrationRuntime({
      registry: new IntegrationPluginRegistry([mailPlugin(execute)]),
      store: memoryStore([personal], [grant(personal, 'full')]),
      credentials: new CredentialBroker({
        get: vi.fn().mockResolvedValue(JSON.stringify({ token: 'mail-token' })),
      }),
    });
    const session = await runtime.prepare({
      ownerId: 'owner-1',
      request: { connections: [{ connection: 'mail-personal', preset: 'read-only' }] },
    });

    await expect(session.call({
      namespace: 'mail',
      tool: 'messages_search',
      arguments: { query: 'invoice' },
    })).resolves.toEqual({ query: 'invoice' });
    expect(execute).toHaveBeenCalledWith(
      'mail.messages.search',
      { query: 'invoice' },
      expect.objectContaining({ connection: expect.objectContaining({ alias: 'mail-personal' }) }),
    );
  });

  it('enforces resource constraints before credential access', async () => {
    const execute = vi.fn();
    const plugin = mailPlugin(execute);
    const scoped = connection('scoped-id', 'mail-scoped', 'full', ['mail.read', 'mail.send']);
    const constrained = {
      ...grant(scoped, 'full'),
      resourceConstraints: { to: ['allowed@example.com'] },
    };
    const getSecret = vi.fn();
    const runtime = new IntegrationRuntime({
      registry: new IntegrationPluginRegistry([plugin]),
      store: memoryStore([scoped], [constrained]),
      credentials: new CredentialBroker({ get: getSecret }),
    });
    const session = await runtime.prepare({
      ownerId: 'owner-1',
      request: { connections: [{ connection: 'mail-scoped' }] },
    });

    await expect(session.call({
      namespace: 'mail',
      tool: 'messages_send',
      arguments: { account: 'mail-scoped', input: { to: 'blocked@example.com' } },
    })).rejects.toThrow('outside the connection resource grant');
    expect(getSecret).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects a grant that expires after tool preparation before reading credentials', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(now));
      const expiresAt = '2026-08-20T00:01:00.000Z';
      const account = connection('personal-id', 'mail-personal', 'full', ['mail.read']);
      const execute = vi.fn();
      const getSecret = vi.fn();
      const runtime = new IntegrationRuntime({
        registry: new IntegrationPluginRegistry([mailPlugin(execute)]),
        store: memoryStore([account], [{ ...grant(account, 'full'), expiresAt }]),
        credentials: new CredentialBroker({ get: getSecret }),
      });
      const session = await runtime.prepare({
        ownerId: 'owner-1',
        request: { connections: [{ connection: account.alias, preset: 'read-only' }] },
        maximumIntegrationAccess: 'read-only',
      });
      expect(session.tools[0]?.tools.map((tool) => tool.name)).toEqual(['messages_search']);

      vi.setSystemTime(new Date(expiresAt));
      await expect(session.call({ namespace: 'mail', tool: 'messages_search', arguments: { query: 'invoice' } }))
        .rejects.toThrow('grant has expired');
      expect(getSecret).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('integration runtime effect boundaries', () => {
  it('resolves requested aliases before loading selected accounts and their grants in set order', async () => {
    const first = connection('first', 'mail-first', 'full', ['mail.read', 'mail.send']);
    const second = connection('second', 'mail-second', 'full', ['mail.read', 'mail.send']);
    const store = memoryStore([first, second], [grant(first, 'full'), grant(second, 'full')]);
    const events: string[] = [];
    store.getConnectionSet = vi.fn(async () => {
      events.push('set');
      return { version: '1' as const, connectionSetId: 'set-1', ownerId: 'owner-1', name: 'Mail', connectionIds: ['second', 'first'] };
    });
    const get = store.getConnection;
    store.getConnection = vi.fn(async (ownerId: string, selector: string) => { events.push(`connection:${selector}`); return get(ownerId, selector); });
    const getGrant = store.getGrant;
    store.getGrant = vi.fn(async (ownerId: string, connectionId: string) => { events.push(`grant:${connectionId}`); return getGrant(ownerId, connectionId); });
    const credentials = { readRecord: vi.fn() };
    const runtime = new IntegrationRuntime({ registry: new IntegrationPluginRegistry([mailPlugin(vi.fn())]), store, credentials });
    const session = await runtime.prepare({ ownerId: 'owner-1', request: { connectionSet: 'set-1', connections: [
      { connection: first.alias, preset: 'full' }, { connection: first.connectionId, preset: 'read-only' },
    ] } });
    expect(events).toEqual(['set', 'connection:mail-first', 'connection:first', 'connection:second', 'grant:second', 'connection:first', 'grant:first']);
    expect(session.tools[0]?.tools.map(tool => tool.inputSchema.properties)).toEqual([
      expect.objectContaining({ account: expect.objectContaining({ enum: ['mail-second', 'mail-first'] }) }),
      expect.objectContaining({ account: expect.objectContaining({ enum: ['mail-second'] }) }),
    ]);
    expect(credentials.readRecord).not.toHaveBeenCalled();
  });

  it('checks all selected grants before rejecting duplicate account aliases', async () => {
    const first = connection('first', 'mail-same', 'full', ['mail.read']);
    const second = connection('second', 'mail-same', 'full', ['mail.read']);
    const store = memoryStore([first, second], [grant(first, 'full'), grant(second, 'full')]);
    const getGrant = vi.spyOn(store, 'getGrant');
    const runtime = new IntegrationRuntime({ registry: new IntegrationPluginRegistry([mailPlugin(vi.fn())]), store, credentials: { readRecord: vi.fn() } });
    await expect(runtime.prepare({ ownerId: 'owner-1', request: { connections: [{ connection: 'first' }, { connection: 'second' }] } }))
      .rejects.toThrow('duplicate connection alias mail-same');
    expect(getGrant.mock.calls).toEqual([['owner-1', 'first'], ['owner-1', 'second']]);
  });

  it('validates arguments before checking expiry and checks expiry before resource constraints or credential lookup', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(now));
      const test = runtimeFixture();
      test.policy.expiresAt = '2026-08-20T00:01:00.000Z';
      test.policy.resourceConstraints = { query: ['allowed'] };
      const session = await test.runtime.prepare(test.input);
      vi.setSystemTime(new Date(test.policy.expiresAt));
      await expect(session.call({ namespace: 'mail', tool: 'messages_search', arguments: { input: false } })).rejects.toThrow('integration operation input must be an object');
      await expect(session.call({ namespace: 'mail', tool: 'messages_search', arguments: { input: { query: 'blocked' } } })).rejects.toThrow('grant has expired');
      expect(test.store.getCredentialBinding).not.toHaveBeenCalled();
      expect(test.credentials.readRecord).not.toHaveBeenCalled();
      expect(test.execute).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('loads the binding, reads credentials, and executes with the original abort signal in that order', async () => {
    const test = runtimeFixture();
    const events: string[] = [];
    test.store.getCredentialBinding.mockImplementation(async () => {
      events.push('binding'); return { version: '1', ownerId: 'owner-1', connectionId: 'personal-id', reference: 'secret-ref', createdAt: now, updatedAt: now };
    });
    test.credentials.readRecord.mockImplementation(async () => { events.push('credential'); return { token: 'test-token' }; });
    test.execute.mockImplementation(async () => { events.push('execute'); return false; });
    const session = await test.runtime.prepare(test.input);
    const controller = new AbortController();
    await expect(session.call({ namespace: 'mail', tool: 'messages_search', arguments: { input: {} } }, controller.signal)).resolves.toBe(false);
    expect(events).toEqual(['binding', 'credential', 'execute']);
    expect(test.credentials.readRecord).toHaveBeenCalledWith('secret-ref', test.account, controller.signal);
    expect(test.execute).toHaveBeenCalledWith('mail.messages.search', {}, { connection: test.account, credential: { token: 'test-token' }, signal: controller.signal });
  });

  it('rejects a foreign credential binding and preserves reader failure before invoking the provider', async () => {
    const test = runtimeFixture();
    const session = await test.runtime.prepare(test.input);
    test.store.getCredentialBinding.mockResolvedValueOnce({ version: '1', ownerId: 'other-owner', connectionId: 'personal-id', reference: 'foreign-ref', createdAt: now, updatedAt: now });
    const call = { namespace: 'mail', tool: 'messages_search', arguments: { input: {} } };
    await expect(session.call(call)).rejects.toThrow('credential for mail-personal is not configured');
    expect(test.credentials.readRecord).not.toHaveBeenCalled();
    const failure = new Error('credential unavailable');
    test.credentials.readRecord.mockRejectedValueOnce(failure);
    await expect(session.call(call)).rejects.toBe(failure);
    expect(test.execute).not.toHaveBeenCalled();
  });

  it.each([false, 0, '', null])('returns a valid falsey provider result unchanged: %j', async result => {
    const test = runtimeFixture();
    test.execute.mockResolvedValue(result);
    const session = await test.runtime.prepare(test.input);
    await expect(session.call({ namespace: 'mail', tool: 'messages_search', arguments: { input: {} } })).resolves.toBe(result);
    expect(test.execute).toHaveBeenCalledTimes(1);
  });

  it('checks result size only after provider execution and preserves provider errors', async () => {
    const test = runtimeFixture();
    test.execute.mockResolvedValueOnce('x'.repeat(128 * 1024));
    const session = await test.runtime.prepare(test.input);
    const call = { namespace: 'mail', tool: 'messages_search', arguments: { input: {} } };
    await expect(session.call(call)).rejects.toThrow('integration tool result exceeds 131072 bytes');
    expect(test.credentials.readRecord).toHaveBeenCalledTimes(1);
    expect(test.execute).toHaveBeenCalledTimes(1);
    const failure = new Error('provider unavailable');
    test.execute.mockRejectedValueOnce(failure);
    await expect(session.call(call)).rejects.toBe(failure);
  });
});

function runtimeFixture() {
  const account = connection('personal-id', 'mail-personal', 'full', ['mail.read', 'mail.send']);
  const policy = grant(account, 'full');
  const base = memoryStore([account], [policy]);
  const store = { ...base, getCredentialBinding: vi.fn(base.getCredentialBinding) };
  const execute = vi.fn<IntegrationPlugin['execute']>().mockResolvedValue({ ok: true });
  const credentials = { readRecord: vi.fn().mockResolvedValue({ token: 'test-token' }) };
  const runtime = new IntegrationRuntime({ registry: new IntegrationPluginRegistry([mailPlugin(execute)]), store, credentials });
  const input = { ownerId: 'owner-1', request: { connections: [{ connection: account.alias }] } };
  return { account, policy, store, execute, credentials, runtime, input };
}

function mailPlugin(execute: IntegrationPlugin['execute']): IntegrationPlugin {
  return {
    manifest: {
      id: 'mail',
      version: '1',
      title: 'Mail',
      description: 'Search and send mail.',
      authentication: [{
        scheme: 'oauth2',
        title: 'OAuth access token',
        fields: [{ key: 'access_token', label: 'Access token', secret: true }],
      }],
      operations: [
        {
          id: 'mail.messages.search',
          title: 'Search messages',
          kind: 'search',
          access: 'read',
          risk: 'routine',
          requiredProviderScopes: ['mail.read'],
          inputSchema: { type: 'object' },
        },
        {
          id: 'mail.messages.send',
          title: 'Send message',
          kind: 'action',
          access: 'write',
          risk: 'consequential',
          requiredProviderScopes: ['mail.send'],
          inputSchema: { type: 'object' },
        },
      ],
    },
    verifyCredential: async (scheme) => ({
      label: 'Mail account',
      authorization: { scheme, access: 'full', scopeModel: 'unknown', scopes: [] },
    }),
    execute,
  };
}

function connection(
  connectionId: string,
  alias: string,
  access: IntegrationConnection['authorization']['access'],
  scopes: string[],
): IntegrationConnection {
  return {
    version: '1',
    connectionId,
    ownerId: 'owner-1',
    pluginId: 'mail',
    alias,
    label: alias,
    authorization: { scheme: 'oauth2', access, scopeModel: 'granular', scopes },
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
}

function grant(
  candidate: IntegrationConnection,
  preset: ConnectionGrant['preset'],
): ConnectionGrant {
  return {
    version: '1',
    grantId: `grant:${candidate.connectionId}`,
    ownerId: candidate.ownerId,
    connectionId: candidate.connectionId,
    preset,
  };
}

function memoryStore(
  connections: IntegrationConnection[],
  grants: ConnectionGrant[],
): IntegrationStore {
  return {
    listConnections: async () => connections,
    getConnection: async (ownerId, selector) => connections.find((candidate) => (
      candidate.ownerId === ownerId &&
      (candidate.connectionId === selector || candidate.alias === selector)
    )),
    putConnection: async () => undefined,
    putConnectionBundle: async () => undefined,
    putCredentialBinding: async () => undefined,
    getCredentialBinding: async (ownerId, connectionId) => ({
      version: '1',
      ownerId,
      connectionId,
      reference: `secret:${connectionId}`,
      createdAt: now,
      updatedAt: now,
    }),
    putGrant: async () => undefined,
    getGrant: async (ownerId, connectionId) => grants.find((candidate) => (
      candidate.ownerId === ownerId && candidate.connectionId === connectionId
    )),
    putConnectionSet: async () => undefined,
    getConnectionSet: async () => undefined,
    listConnectionSets: async () => [],
    putSourceBinding: async () => undefined,
    listSourceBindings: async () => [],
    matchingSourceBindings: async () => [],
  };
}
