import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { IntegrationConnection } from '../../src/domain/capabilities.js';
import { IntegrationPluginRegistry } from '../../src/plugins/integration-registry.js';
import {
  OAuthAuthorizationService,
  OAuthRefreshingCredentialBroker,
  parseOAuthApplicationSecretArns,
  SecretOAuthApplicationRegistry,
  type OAuthAuthorizationRecord,
  type OAuthAuthorizationStore,
} from '../../src/plugins/oauth.js';
import type { IntegrationPlugin, IntegrationPluginRegistryLike } from '../../src/plugins/integration-types.js';

describe('OAuth connector installation', () => {
  it('starts a short-lived PKCE authorization without persisting the raw state or app secret', async () => {
    const store = new MemoryOAuthStore();
    let randomCall = 0;
    const service = new OAuthAuthorizationService({
      registry: registry(),
      applications: applications(),
      store,
      connections: oauthConnections(vi.fn()),
      clock: fixedClock,
      randomBytes: (size) => Buffer.alloc(size, ++randomCall),
    });

    const result = await service.start({
      ownerId: 'api:owner-1',
      pluginId: 'slack',
      callbackUrl: 'https://api.example.test/v1/integrations/oauth/callback',
      alias: 'slack-work',
      grant: { preset: 'read-only' },
    });

    const authorization = new URL(result.authorizationUrl);
    const state = authorization.searchParams.get('state')!;
    expect(authorization.origin + authorization.pathname).toBe('https://provider.example.test/authorize');
    expect(authorization.searchParams.get('client_id')).toBe('client-public-id');
    expect(authorization.searchParams.get('redirect_uri')).toBe(result.callbackUrl);
    expect(authorization.searchParams.get('scope')).toBe('messages:read messages:write');
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorization.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.authorizationUrl).not.toContain('client-super-secret');
    expect([...store.pending.keys()]).toEqual([createHash('sha256').update(state).digest('hex')]);
    expect(JSON.stringify([...store.pending.entries()])).not.toContain(state);
    expect(store.pending.values().next().value).toMatchObject({
      ownerId: 'api:owner-1',
      pluginId: 'slack',
      alias: 'slack-work',
      grant: { preset: 'read-only' },
      expiresAt: 1_787_861_400,
    });
  });

  it('uses a provider-declared comma separator for OAuth scopes', async () => {
    const service = new OAuthAuthorizationService({
      registry: registry(','),
      applications: applications(),
      store: new MemoryOAuthStore(),
      connections: oauthConnections(vi.fn()),
      clock: fixedClock,
      randomBytes: (size) => Buffer.alloc(size, 1),
    });

    const result = await service.start({
      ownerId: 'api:owner-1',
      pluginId: 'slack',
      callbackUrl: 'https://api.example.test/v1/integrations/oauth/callback',
      grant: { preset: 'read-only' },
    });

    expect(new URL(result.authorizationUrl).searchParams.get('scope'))
      .toBe('messages:read,messages:write');
  });

  it('atomically consumes callback state, exchanges the code, and hands verified credentials to connection creation', async () => {
    const store = new MemoryOAuthStore();
    const create = vi.fn().mockImplementation(async (input) => ({
      connection: connection(input.credential.access_token),
      grant: { version: '1', grantId: 'grant-1', ownerId: input.ownerId, connectionId: 'connection-1', ...input.grant },
    }));
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: 'xoxb-new',
      refresh_token: 'refresh-new',
      token_type: 'bot',
      scope: 'messages:read,messages:write',
      expires_in: 3600,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    let randomCall = 0;
    const service = new OAuthAuthorizationService({
      registry: registry(), applications: applications(), store, connections: oauthConnections(create),
      fetch: fetcher, clock: fixedClock, randomBytes: (size) => Buffer.alloc(size, ++randomCall),
    });
    const started = await service.start({
      ownerId: 'api:owner-1',
      pluginId: 'slack',
      callbackUrl: 'https://api.example.test/v1/integrations/oauth/callback',
      grant: { preset: 'read-write' },
    });
    const state = new URL(started.authorizationUrl).searchParams.get('state')!;

    await expect(service.complete({ state, code: 'provider-code' })).resolves.toEqual({
      connection: expect.objectContaining({ connectionId: 'connection-1' }),
    });
    expect(fetcher).toHaveBeenCalledOnce();
    const [, init] = fetcher.mock.calls[0]!;
    const form = new URLSearchParams(String(init.body));
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('provider-code');
    expect(form.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(form.get('client_secret')).toBe('client-super-secret');
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      ownerId: 'api:owner-1',
      pluginId: 'slack',
      authScheme: 'oauth2',
      grant: { preset: 'read-write' },
      credential: {
        access_token: 'xoxb-new',
        refresh_token: 'refresh-new',
        token_type: 'bot',
        scope: 'messages:read,messages:write',
        expires_at: '2026-08-27T21:00:00.000Z',
      },
    }));
    await expect(service.complete({ state, code: 'replay' })).rejects.toThrow('invalid or expired');
  });

  it('binds reconnect state to one existing account and replaces it without changing grants', async () => {
    const store = new MemoryOAuthStore();
    const current = connection('original-subject');
    const create = vi.fn();
    const rotate = vi.fn().mockResolvedValue({
      connection: { ...current, status: 'active' },
      health: {
        version: '1', ownerId: current.ownerId, connectionId: current.connectionId,
        status: 'healthy', code: 'verified', checkedAt: fixedClock.now().toISOString(),
      },
    });
    const get = vi.fn().mockResolvedValue({
      connection: current,
      grant: {
        version: '1', grantId: 'grant-1', ownerId: current.ownerId,
        connectionId: current.connectionId, preset: 'custom',
        allowOperations: ['slack.messages.search'],
        resourceConstraints: { channel: ['C123'] },
      },
      health: { version: '1', ownerId: current.ownerId, connectionId: current.connectionId, status: 'unknown', code: 'not-tested' },
    });
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: 'replacement-token',
      scope: 'messages:read,messages:write',
    }), { status: 200 }));
    let randomCall = 0;
    const service = new OAuthAuthorizationService({
      registry: registry(), applications: applications(), store,
      connections: { create, get, rotate }, fetch: fetcher, clock: fixedClock,
      randomBytes: (size) => Buffer.alloc(size, ++randomCall),
    });

    const started = await service.startReconnect({
      ownerId: current.ownerId,
      connectionIdOrAlias: current.alias,
      callbackUrl: 'https://api.example.test/v1/integrations/oauth/callback',
    });
    const stateValue = new URL(started.authorizationUrl).searchParams.get('state')!;
    expect(started.connectionId).toBe(current.connectionId);
    expect(store.pending.values().next().value).toMatchObject({
      ownerId: current.ownerId,
      pluginId: 'slack',
      reconnectConnectionId: current.connectionId,
      grant: {
        preset: 'custom',
        allowOperations: ['slack.messages.search'],
        resourceConstraints: { channel: ['C123'] },
      },
    });

    await service.complete({ state: stateValue, code: 'provider-code' });
    expect(rotate).toHaveBeenCalledWith(current.ownerId, current.connectionId, expect.objectContaining({
      access_token: 'replacement-token',
    }));
    expect(create).not.toHaveBeenCalled();
  });

  it('stores a provider-issued secondary user token and refreshes it independently', async () => {
    const store = new MemoryOAuthStore();
    const create = vi.fn().mockImplementation(async (input) => ({
      connection: connection(input.credential.access_token),
      grant: { version: '1', grantId: 'grant-1', ownerId: input.ownerId, connectionId: 'connection-1', ...input.grant },
    }));
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'xoxb-new',
        refresh_token: 'bot-refresh',
        token_type: 'bot',
        scope: 'chat:write',
        expires_in: 3600,
        authed_user: {
          access_token: 'xoxp-user',
          refresh_token: 'user-refresh',
          token_type: 'user',
          scope: 'search:read',
          expires_in: 1800,
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'xoxb-refreshed',
        refresh_token: 'bot-refresh-2',
        token_type: 'bot',
        scope: 'chat:write',
        expires_in: 5400,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'xoxp-user-refreshed',
        refresh_token: 'user-refresh-2',
        token_type: 'user',
        scope: 'search:read',
        expires_in: 7200,
      }), { status: 200 }));
    let randomCall = 0;
    const service = new OAuthAuthorizationService({
      registry: secondaryRegistry(), applications: applications(), store, connections: oauthConnections(create),
      fetch: fetcher, clock: fixedClock, randomBytes: (size) => Buffer.alloc(size, ++randomCall),
    });
    const started = await service.start({
      ownerId: 'api:owner-1',
      pluginId: 'slack',
      callbackUrl: 'https://api.example.test/v1/integrations/oauth/callback',
      grant: { preset: 'read-write' },
    });
    const authorization = new URL(started.authorizationUrl);
    expect(authorization.searchParams.get('scope')).toBe('chat:write');
    expect(authorization.searchParams.get('user_scope')).toBe('search:read');
    const stateValue = authorization.searchParams.get('state')!;
    await service.complete({ state: stateValue, code: 'provider-code' });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      credential: expect.objectContaining({
        access_token: 'xoxb-new',
        user_access_token: 'xoxp-user',
        user_refresh_token: 'user-refresh',
        user_scope: 'search:read',
        user_expires_at: '2026-08-27T20:30:00.000Z',
      }),
    }));

    const credential = (create.mock.calls[0]![0] as { credential: Record<string, string> }).credential;
    const replace = vi.fn();
    const broker = new OAuthRefreshingCredentialBroker({
      credentials: { readRecord: vi.fn().mockResolvedValue({
        ...credential,
        expires_at: '2026-08-27T20:01:00.000Z',
        user_expires_at: '2026-08-27T20:01:00.000Z',
      }) },
      vault: { replace },
      registry: secondaryRegistry(),
      applications: applications(),
      store,
      fetch: fetcher,
      clock: fixedClock,
      randomId: () => 'secondary-lock',
    });
    await expect(broker.readRecord('secret-ref', connection('xoxb-new'))).resolves.toMatchObject({
      access_token: 'xoxb-refreshed',
      refresh_token: 'bot-refresh-2',
      expires_at: '2026-08-27T21:30:00.000Z',
      user_access_token: 'xoxp-user-refreshed',
      user_refresh_token: 'user-refresh-2',
      user_expires_at: '2026-08-27T22:00:00.000Z',
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    const botRefreshForm = new URLSearchParams(String(fetcher.mock.calls[1]![1].body));
    const userRefreshForm = new URLSearchParams(String(fetcher.mock.calls[2]![1].body));
    expect(botRefreshForm.get('refresh_token')).toBe('bot-refresh');
    expect(userRefreshForm.get('refresh_token')).toBe('user-refresh');
    expect(replace).toHaveBeenCalledWith('secret-ref', expect.objectContaining({
      access_token: 'xoxb-refreshed',
      user_access_token: 'xoxp-user-refreshed',
    }));
  });

  it('refreshes an expiring OAuth credential behind a per-connection lease', async () => {
    const store = new MemoryOAuthStore();
    const replace = vi.fn().mockResolvedValue(undefined);
    const expired = {
      access_token: 'old-access',
      refresh_token: 'old-refresh',
      expires_at: '2026-08-27T19:59:00.000Z',
      scope: 'messages:read',
    };
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: 'new-access',
      expires_in: 7200,
    }), { status: 200 }));
    const broker = new OAuthRefreshingCredentialBroker({
      credentials: { readRecord: vi.fn().mockResolvedValue(expired) },
      vault: { replace },
      registry: registry(),
      applications: applications(),
      store,
      fetch: fetcher,
      clock: fixedClock,
      randomId: () => 'lock-1',
    });

    await expect(broker.readRecord('secret-ref', connection('old-access'))).resolves.toEqual({
      access_token: 'new-access',
      refresh_token: 'old-refresh',
      expires_at: '2026-08-27T22:00:00.000Z',
      scope: 'messages:read',
    });
    expect(replace).toHaveBeenCalledWith('secret-ref', expect.objectContaining({
      access_token: 'new-access', refresh_token: 'old-refresh',
    }));
    expect(store.acquired).toEqual([['api:owner-1', 'connection-1', 'lock-1', 1_787_860_830]]);
    expect(store.released).toEqual([['api:owner-1', 'connection-1', 'lock-1']]);
  });

  it('reports a failed lock cleanup without replacing a successful refresh', async () => {
    const metricLines: string[] = [];
    const log = vi.spyOn(console, 'info').mockImplementation((line) => {
      metricLines.push(String(line));
    });
    const store: OAuthAuthorizationStore = {
      create: vi.fn(),
      consume: vi.fn(),
      acquireRefreshLock: vi.fn().mockResolvedValue(true),
      releaseRefreshLock: vi.fn().mockRejectedValue(new Error('Dynamo unavailable')),
    };
    const broker = new OAuthRefreshingCredentialBroker({
      credentials: { readRecord: vi.fn().mockResolvedValue({
        access_token: 'old-access',
        refresh_token: 'old-refresh',
        expires_at: '2026-08-27T19:59:00.000Z',
      }) },
      vault: { replace: vi.fn().mockResolvedValue(undefined) },
      registry: registry(),
      applications: applications(),
      store,
      fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({
        access_token: 'new-access',
        expires_in: 7200,
      }), { status: 200 })),
      clock: fixedClock,
      randomId: () => 'lock-1',
    });
    try {
      await expect(broker.readRecord('secret-ref', connection('old-access'))).resolves.toMatchObject({
        access_token: 'new-access',
      });
      expect(metricLines.map((line) => JSON.parse(line) as unknown)).toContainEqual(
        expect.objectContaining({ Component: 'oauth-refresh', CleanupFailure: 1 }),
      );
    } finally {
      log.mockRestore();
    }
  });

  it('waits with bounded backoff for the worker that owns a contested refresh lease', async () => {
    const expired = {
      access_token: 'old-access',
      refresh_token: 'old-refresh',
      expires_at: '2026-08-27T19:59:00.000Z',
    };
    const fresh = {
      access_token: 'winner-access',
      refresh_token: 'old-refresh',
      expires_at: '2026-08-27T22:00:00.000Z',
    };
    const readRecord = vi.fn()
      .mockResolvedValueOnce(expired)
      .mockResolvedValueOnce(expired)
      .mockResolvedValueOnce(fresh);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const store: OAuthAuthorizationStore = {
      create: vi.fn(),
      consume: vi.fn(),
      acquireRefreshLock: vi.fn().mockResolvedValue(false),
      releaseRefreshLock: vi.fn(),
    };
    const fetcher = vi.fn();
    const replace = vi.fn();
    const broker = new OAuthRefreshingCredentialBroker({
      credentials: { readRecord },
      vault: { replace },
      registry: registry(),
      applications: applications(),
      store,
      fetch: fetcher,
      clock: fixedClock,
      sleep,
    });

    await expect(broker.readRecord('secret-ref', connection('old-access'))).resolves.toEqual(fresh);
    expect(sleep.mock.calls).toEqual([[250], [500]]);
    expect(fetcher).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it('loads app credentials only from declared Secrets Manager references', async () => {
    const secrets = { get: vi.fn().mockResolvedValue(JSON.stringify({ client_id: 'id-1', client_secret: 'secret-1' })) };
    const registry = new SecretOAuthApplicationRegistry(secrets, {
      slack: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:oauth/slack-abc123',
    });
    expect(registry.configured('slack')).toBe(true);
    await expect(registry.application('slack')).resolves.toEqual({ clientId: 'id-1', clientSecret: 'secret-1' });
    await expect(registry.application('stripe')).rejects.toThrow('not configured');
  });

  it('validates the Terraform-projected OAuth application map', () => {
    expect(parseOAuthApplicationSecretArns(JSON.stringify({
      slack: 'arn:aws:secretsmanager:us-west-2:123456789012:secret:rat/oauth/slack-AbCdEf',
    }))).toEqual({
      slack: 'arn:aws:secretsmanager:us-west-2:123456789012:secret:rat/oauth/slack-AbCdEf',
    });
    expect(() => parseOAuthApplicationSecretArns('{oops')).toThrow('valid JSON');
    expect(() => parseOAuthApplicationSecretArns(JSON.stringify({ Slack: 'not-an-arn' }))).toThrow('invalid entry');
  });

  it('rejects plugin metadata that could override protocol-owned OAuth parameters', () => {
    const plugin = registryPlugin();
    plugin.manifest.authentication[0]!.oauth2!.authorizationParameters = { scope: 'admin' };

    expect(() => new IntegrationPluginRegistry([plugin])).toThrow(
      'OAuth authorization parameters are invalid',
    );
  });
});

const fixedClock = { now: () => new Date('2026-08-27T20:00:00.000Z') };

class MemoryOAuthStore implements OAuthAuthorizationStore {
  public readonly pending = new Map<string, OAuthAuthorizationRecord>();
  public readonly acquired: unknown[][] = [];
  public readonly released: unknown[][] = [];

  public async create(stateHash: string, record: OAuthAuthorizationRecord): Promise<void> {
    if (this.pending.has(stateHash)) throw new Error('duplicate state');
    this.pending.set(stateHash, record);
  }

  public async consume(stateHash: string): Promise<OAuthAuthorizationRecord | undefined> {
    const value = this.pending.get(stateHash);
    this.pending.delete(stateHash);
    return value;
  }

  public async acquireRefreshLock(ownerId: string, connectionId: string, token: string, expiresAt: number): Promise<boolean> {
    this.acquired.push([ownerId, connectionId, token, expiresAt]);
    return true;
  }

  public async releaseRefreshLock(ownerId: string, connectionId: string, token: string): Promise<void> {
    this.released.push([ownerId, connectionId, token]);
  }
}

function applications() {
  return {
    configured: (pluginId: string) => pluginId === 'slack',
    application: vi.fn().mockResolvedValue({ clientId: 'client-public-id', clientSecret: 'client-super-secret' }),
  };
}

function oauthConnections(create: ReturnType<typeof vi.fn>) {
  return {
    create,
    get: vi.fn(),
    rotate: vi.fn(),
  };
}

function registry(scopeSeparator?: ' ' | ','): IntegrationPluginRegistryLike {
  const plugin: IntegrationPlugin = {
    manifest: {
      id: 'slack',
      version: '1',
      title: 'Slack',
      description: 'Slack test connector',
      authentication: [{
        scheme: 'oauth2',
        title: 'Install with OAuth',
        fields: [{ key: 'access_token', label: 'Access token', secret: true }],
        oauth2: {
          authorizationUrl: 'https://provider.example.test/authorize',
          tokenUrl: 'https://provider.example.test/token',
          scopes: ['messages:read', 'messages:write'],
          ...(scopeSeparator ? { scopeSeparator } : {}),
          tokenEndpointAuthMethod: 'client-secret-post',
        },
      }],
      operations: [],
    },
    verifyCredential: vi.fn(),
    execute: vi.fn(),
  };
  return { plugin: (id) => {
    if (id !== 'slack') throw new Error('not installed');
    return plugin;
  }, list: () => [plugin] };
}

function secondaryRegistry(): IntegrationPluginRegistryLike {
  const plugin = registry().plugin('slack');
  plugin.manifest.authentication[0]!.oauth2 = {
    authorizationUrl: 'https://provider.example.test/authorize',
    tokenUrl: 'https://provider.example.test/token',
    scopes: ['chat:write'],
    secondaryToken: {
      authorizationParameter: 'user_scope',
      responseField: 'authed_user',
      credentialPrefix: 'user',
      scopes: ['search:read'],
    },
    tokenEndpointAuthMethod: 'client-secret-post',
  };
  return { plugin: (id) => {
    if (id !== 'slack') throw new Error('not installed');
    return plugin;
  }, list: () => [plugin] };
}

function registryPlugin(): IntegrationPlugin {
  return {
    manifest: {
      id: 'slack',
      version: '1',
      title: 'Slack',
      description: 'Slack test connector',
      authentication: [{
        scheme: 'oauth2',
        title: 'Install with OAuth',
        fields: [{ key: 'access_token', label: 'Access token', secret: true, computed: true }],
        oauth2: {
          authorizationUrl: 'https://provider.example.test/authorize',
          tokenUrl: 'https://provider.example.test/token',
          scopes: ['messages:read'],
          tokenEndpointAuthMethod: 'client-secret-post',
        },
      }],
      operations: [{
        id: 'slack.messages.search',
        title: 'Search messages',
        kind: 'search',
        access: 'read',
        risk: 'routine',
      }],
    },
    verifyCredential: vi.fn(),
    execute: vi.fn(),
  };
}

function connection(accessToken: string): IntegrationConnection {
  return {
    version: '1',
    connectionId: 'connection-1',
    ownerId: 'api:owner-1',
    pluginId: 'slack',
    alias: 'slack-work',
    label: 'Acme — Rat',
    authorization: { scheme: 'oauth2', access: 'full', scopeModel: 'granular', scopes: ['messages:read'] },
    status: 'active',
    createdAt: fixedClock.now().toISOString(),
    updatedAt: fixedClock.now().toISOString(),
    externalSubjectId: accessToken,
  };
}
