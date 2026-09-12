import { vi } from 'vitest';
import type { IntegrationConnection } from '../../src/domain/capabilities.js';
import type { OAuthAuthorizationRecord, OAuthAuthorizationStore } from '../../src/plugins/oauth.js';
import type { IntegrationPlugin, IntegrationPluginRegistryLike } from '../../src/plugins/integration-types.js';

export const fixedClock = { now: () => new Date('2026-08-27T20:00:00.000Z') };

export class MemoryOAuthStore implements OAuthAuthorizationStore {
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

export function applications() {
  return {
    configured: (pluginId: string) => pluginId === 'slack',
    application: vi.fn().mockResolvedValue({ clientId: 'client-public-id', clientSecret: 'client-super-secret' }),
  };
}

export function oauthConnections(create: ReturnType<typeof vi.fn>) {
  return {
    create,
    get: vi.fn(),
    rotate: vi.fn(),
  };
}

export function registry(scopeSeparator?: ' ' | ','): IntegrationPluginRegistryLike {
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

export function secondaryRegistry(): IntegrationPluginRegistryLike {
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

export function registryPlugin(): IntegrationPlugin {
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

export function connection(accessToken: string): IntegrationConnection {
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
