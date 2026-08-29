import type { JsonValue } from '../../domain/contracts.js';
import {
  optionalInputString,
  requiredCredential,
  requiredInputString,
  TrustedHttpIntegrationPlugin,
} from '../http.js';

export function createSlackIntegrationPlugin(options: { fetch?: typeof fetch } = {}): TrustedHttpIntegrationPlugin {
  return new TrustedHttpIntegrationPlugin({
    baseUrl: 'https://slack.com/api/',
    ...(options.fetch ? { fetch: options.fetch } : {}),
    manifest: {
      id: 'slack',
      version: '1',
      title: 'Slack',
      description: 'Test API reachability, search messages, post messages, and add reactions in connected Slack workspaces.',
      authentication: [
        {
          scheme: 'oauth2',
          title: 'Install with Slack OAuth',
          fields: [
            { key: 'access_token', label: 'Access token', secret: true },
            { key: 'refresh_token', label: 'Refresh token', secret: true, computed: true, required: false },
            { key: 'expires_at', label: 'Access-token expiry', secret: false, computed: true, required: false },
            { key: 'token_type', label: 'Token type', secret: false, computed: true, required: false },
            { key: 'scope', label: 'Granted scopes', secret: false, computed: true, required: false },
            { key: 'user_access_token', label: 'User access token', secret: true, computed: true, required: false },
            { key: 'user_refresh_token', label: 'User refresh token', secret: true, computed: true, required: false },
            { key: 'user_expires_at', label: 'User access-token expiry', secret: false, computed: true, required: false },
            { key: 'user_token_type', label: 'User token type', secret: false, computed: true, required: false },
            { key: 'user_scope', label: 'Granted user scopes', secret: false, computed: true, required: false },
          ],
          oauth2: {
            authorizationUrl: 'https://slack.com/oauth/v2/authorize',
            tokenUrl: 'https://slack.com/api/oauth.v2.access',
            scopes: ['app_mentions:read', 'chat:write', 'reactions:write'],
            secondaryToken: {
              authorizationParameter: 'user_scope',
              responseField: 'authed_user',
              credentialPrefix: 'user',
              scopes: ['search:read'],
            },
            tokenEndpointAuthMethod: 'client-secret-post',
          },
        },
        {
          scheme: 'api-key',
          title: 'Bot or app token',
          fields: [{ key: 'token', label: 'Token', secret: true }],
        },
      ],
      operations: [
        {
          id: 'slack.api.test',
          title: 'Test Slack API reachability',
          kind: 'tool',
          access: 'read',
          risk: 'routine',
          inputSchema: objectSchema({ marker: stringSchema('Opaque diagnostic marker') }, ['marker']),
        },
        {
          id: 'slack.messages.search',
          title: 'Search Slack messages',
          kind: 'search',
          access: 'read',
          risk: 'routine',
          requiredProviderScopes: ['search:read'],
          inputSchema: objectSchema({ query: stringSchema('Slack search query') }, ['query']),
        },
        {
          id: 'slack.messages.post',
          title: 'Post a Slack message',
          kind: 'action',
          access: 'write',
          risk: 'consequential',
          requiredProviderScopes: ['chat:write'],
          inputSchema: objectSchema({
            channel: stringSchema('Channel ID'),
            text: stringSchema('Message text'),
            threadTs: stringSchema('Optional parent message timestamp'),
          }, ['channel', 'text']),
        },
        {
          id: 'slack.reactions.add',
          title: 'Add a Slack reaction',
          kind: 'action',
          access: 'write',
          risk: 'consequential',
          requiredProviderScopes: ['reactions:write'],
          inputSchema: objectSchema({
            channel: stringSchema('Channel ID'),
            timestamp: stringSchema('Message timestamp'),
            name: stringSchema('Emoji name without colons'),
          }, ['channel', 'timestamp', 'name']),
        },
      ],
    },
    authorization: (credential, operationId) => operationId === 'slack.api.test'
      ? {}
      : {
        authorization: `Bearer ${operationId === 'slack.messages.search'
          ? requiredCredential(credential, 'user_access_token')
          : requiredCredential(credential, 'access_token', 'token', 'value')}`,
      },
    verification: {
      request: (credential) => ({
        method: 'POST',
        path: 'auth.test',
        headers: {
          authorization: `Bearer ${requiredCredential(credential, 'access_token', 'token')}`,
        },
      }),
      result: (value, scheme, credential) => {
        const result = requiredRecord(value, 'Slack verification response');
        const team = requiredResultString(result, 'team');
        const user = requiredResultString(result, 'user');
        const scopes = scheme === 'oauth2'
          ? [...new Set([credential.scope, credential.user_scope]
            .flatMap((value) => (value ?? '').split(','))
            .map((scope) => scope.trim())
            .filter(Boolean))]
          : [];
        return {
          label: `${team} — ${user}`,
          authorization: scheme === 'oauth2' && scopes.length > 0
            ? { scheme, access: 'full', scopeModel: 'granular', scopes }
            : { scheme, access: 'full', scopeModel: 'unknown', scopes: [] },
          externalTenantId: requiredResultString(result, 'team_id'),
          externalSubjectId: requiredResultString(result, 'user_id'),
        };
      },
    },
    validateResponse: (value) => {
      if (isRecord(value) && value.ok === false) {
        const code = typeof value.error === 'string' && /^[A-Za-z0-9_:-]{1,128}$/.test(value.error)
          ? value.error
          : 'unknown';
        throw new Error(`Slack returned an API error: ${code}`);
      }
    },
    operations: [
      {
        id: 'slack.api.test',
        request: (input) => ({
          method: 'POST',
          path: 'api.test',
          form: new URLSearchParams({ marker: requiredInputString(input, 'marker', 256) }),
        }),
      },
      {
        id: 'slack.messages.search',
        request: (input) => ({
          method: 'GET',
          path: 'search.messages',
          query: new URLSearchParams({ query: requiredInputString(input, 'query') }),
        }),
      },
      {
        id: 'slack.messages.post',
        request: (input) => ({
          method: 'POST',
          path: 'chat.postMessage',
          json: compactJson({
            channel: requiredInputString(input, 'channel', 256),
            text: requiredInputString(input, 'text', 40_000),
            thread_ts: optionalInputString(input, 'threadTs', 64),
          }),
        }),
      },
      {
        id: 'slack.reactions.add',
        request: (input) => ({
          method: 'POST',
          path: 'reactions.add',
          json: {
            channel: requiredInputString(input, 'channel', 256),
            timestamp: requiredInputString(input, 'timestamp', 64),
            name: requiredInputString(input, 'name', 128),
          },
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

function requiredResultString(value: { [key: string]: JsonValue }, key: string): string {
  const result = value[key];
  if (typeof result !== 'string' || !result || Buffer.byteLength(result, 'utf8') > 512) {
    throw new Error(`Slack verification response ${key} is invalid`);
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

function compactJson(value: { [key: string]: JsonValue | undefined }): { [key: string]: JsonValue } {
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, JsonValue] => entry[1] !== undefined),
  );
}
