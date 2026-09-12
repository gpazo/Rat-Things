import type { OperationDefinition } from '../../src/domain/capabilities.js';
import type { SelectedConnection } from '../../src/plugins/integration-tool-planning.js';

export const operation: OperationDefinition = {
  id: 'mail.messages.search', title: 'Search messages', kind: 'search', access: 'read', risk: 'routine',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, additionalProperties: false },
};

export function selected(id: string, pluginId = 'mail', alias = `${pluginId}-${id}`): SelectedConnection {
  return {
    connection: {
      version: '1', connectionId: id, ownerId: 'owner-1', pluginId, alias, label: alias, status: 'active',
      authorization: { scheme: 'oauth2', access: 'full', scopeModel: 'unknown', scopes: [] },
      createdAt: '2026-08-20T00:00:00.000Z', updatedAt: '2026-08-20T00:00:00.000Z',
    },
    grant: { version: '1', grantId: `grant-${id}`, ownerId: 'owner-1', connectionId: id, preset: 'full' },
    plugin: {
      manifest: { version: '1', id: pluginId, title: pluginId, description: 'Account operations', authentication: [], operations: [operation] },
      verifyCredential: async () => { throw new Error('pure planning must not verify credentials'); },
      execute: async () => { throw new Error('pure planning must not execute provider operations'); },
    },
  };
}

export function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
