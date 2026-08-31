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
});

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
