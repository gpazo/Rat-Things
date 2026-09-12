import { vi } from 'vitest';
import type { IntegrationConnection } from '../../src/domain/capabilities.js';
import type { TrustedHttpPluginOptions, TrustedHttpRequest } from '../../src/plugins/http.js';

export function httpOptions(request: TrustedHttpRequest = { method: 'GET', path: 'records' }): TrustedHttpPluginOptions {
  return {
    manifest: {
      id: 'fixture', version: '1', title: 'Fixture', description: 'HTTP boundary fixture',
      authentication: [{ scheme: 'api-key', title: 'API key', fields: [{ key: 'api_key', label: 'Key', secret: true }] }],
      operations: [{ id: 'fixture.records.read', title: 'Read', kind: 'tool', access: 'read', risk: 'routine' }],
    },
    baseUrl: 'https://provider.example/api/',
    operations: [{ id: 'fixture.records.read', request: vi.fn(() => request) }],
    authorization: vi.fn(() => ({ authorization: 'Bearer test-credential' })),
    verification: {
      request: vi.fn<TrustedHttpPluginOptions['verification']['request']>(() => ({ method: 'GET', path: 'me' })),
      result: vi.fn<TrustedHttpPluginOptions['verification']['result']>(() => ({ label: 'Fixture', authorization: { scheme: 'api-key', access: 'full', scopeModel: 'unknown', scopes: [] } })),
    },
    fetch: vi.fn<typeof fetch>(async () => new Response('{"ok":true}')),
    validateResponse: vi.fn(),
  };
}

export function httpContext() {
  const connection: IntegrationConnection = {
    version: '1', connectionId: 'connection-1', ownerId: 'owner-1', pluginId: 'fixture', alias: 'fixture-account',
    label: 'Fixture', status: 'active', createdAt: '2026-08-20T00:00:00.000Z', updatedAt: '2026-08-20T00:00:00.000Z',
    authorization: { scheme: 'api-key', access: 'full', scopeModel: 'unknown', scopes: [] },
  };
  return { connection, credential: { api_key: 'test-credential' } };
}
