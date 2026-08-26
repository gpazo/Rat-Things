import type { JsonValue } from '../../domain/contracts.js';
import {
  requiredCredential,
  requiredInputString,
  TrustedHttpIntegrationPlugin,
} from '../http.js';

export function createFixtureCrmIntegrationPlugin(
  baseUrl: string,
  options: { fetch?: typeof fetch } = {},
): TrustedHttpIntegrationPlugin {
  return new TrustedHttpIntegrationPlugin({
    baseUrl,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    manifest: {
      id: 'fixture-crm',
      version: '1',
      title: 'Fixture CRM',
      description: 'Disposable CRM used to prove verified multi-account integration behavior end to end.',
      authentication: [{
        scheme: 'api-key',
        title: 'API key',
        fields: [{ key: 'api_key', label: 'API key', secret: true }],
      }],
      operations: [
        {
          id: 'fixture-crm.records.search',
          title: 'Search customer records',
          kind: 'search',
          access: 'read',
          risk: 'routine',
          requiredProviderScopes: ['records:read'],
          inputSchema: objectSchema({ query: stringSchema('Customer search query') }, ['query']),
        },
        {
          id: 'fixture-crm.records.create',
          title: 'Create a customer record',
          kind: 'action',
          access: 'write',
          risk: 'consequential',
          requiredProviderScopes: ['records:write'],
          inputSchema: objectSchema({ name: stringSchema('Customer name') }, ['name']),
        },
      ],
    },
    authorization: (credential) => ({
      authorization: `Bearer ${requiredCredential(credential, 'api_key')}`,
    }),
    verification: {
      request: () => ({ method: 'GET', path: 'me' }),
      result: (value, scheme) => {
        const profile = requiredRecord(value, 'Fixture CRM verification response');
        const access = requiredString(profile, 'access');
        if (!['read', 'write', 'full'].includes(access)) {
          throw new Error('Fixture CRM verification response access is invalid');
        }
        const scopes = profile.scopes;
        if (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== 'string')) {
          throw new Error('Fixture CRM verification response scopes are invalid');
        }
        return {
          label: requiredString(profile, 'label'),
          externalTenantId: requiredString(profile, 'tenant_id'),
          externalSubjectId: requiredString(profile, 'subject_id'),
          authorization: {
            scheme,
            access: access as 'read' | 'write' | 'full',
            scopeModel: 'granular',
            scopes: scopes as string[],
          },
        };
      },
    },
    validateResponse: (value) => {
      if (isRecord(value) && value.ok === false) {
        throw new Error('Fixture CRM returned an API error');
      }
    },
    operations: [
      {
        id: 'fixture-crm.records.search',
        request: (input) => ({
          method: 'GET',
          path: 'records/search',
          query: new URLSearchParams({ query: requiredInputString(input, 'query') }),
        }),
      },
      {
        id: 'fixture-crm.records.create',
        request: (input) => ({
          method: 'POST',
          path: 'records',
          json: { name: requiredInputString(input, 'name', 256) },
        }),
      },
    ],
  });
}

function isRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredRecord(value: JsonValue, label: string): { [key: string]: JsonValue } {
  if (!isRecord(value)) throw new Error(`${label} is invalid`);
  return value;
}

function requiredString(value: { [key: string]: JsonValue }, key: string): string {
  const result = value[key];
  if (typeof result !== 'string' || !result || Buffer.byteLength(result, 'utf8') > 512) {
    throw new Error(`Fixture CRM verification response ${key} is invalid`);
  }
  return result;
}

function stringSchema(description: string): JsonValue {
  return { type: 'string', description };
}

function objectSchema(
  properties: { [key: string]: JsonValue },
  required: string[],
): { [key: string]: JsonValue } {
  return { type: 'object', properties, required, additionalProperties: false };
}
