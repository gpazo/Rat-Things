import type { JsonValue } from '../../domain/contracts.js';
import {
  optionalInputString,
  requiredCredential,
  requiredInputString,
  TrustedHttpIntegrationPlugin,
} from '../http.js';

const ISSUE_SUMMARY_FIELDS = `
  id
  identifier
  title
  url
  priority
  priorityLabel
  updatedAt
  team { id key name }
  state { id name type }
  assignee { id name }
`;

const ISSUE_FIELDS = `${ISSUE_SUMMARY_FIELDS}\n  description`;

export function createLinearIntegrationPlugin(options: { fetch?: typeof fetch } = {}): TrustedHttpIntegrationPlugin {
  return new TrustedHttpIntegrationPlugin({
    baseUrl: 'https://api.linear.app/',
    ...(options.fetch ? { fetch: options.fetch } : {}),
    manifest: {
      id: 'linear',
      version: '1',
      title: 'Linear',
      description: 'Find Linear issues, inspect issue context, create and update issues, and add comments.',
      authentication: [
        {
          scheme: 'oauth2',
          title: 'Install Rat Things in Linear',
          fields: [
            { key: 'access_token', label: 'Access token', secret: true },
            { key: 'refresh_token', label: 'Refresh token', secret: true, computed: true, required: false },
            { key: 'expires_at', label: 'Access-token expiry', secret: false, computed: true, required: false },
            { key: 'token_type', label: 'Token type', secret: false, computed: true, required: false },
            { key: 'scope', label: 'Granted scopes', secret: false, computed: true, required: false },
          ],
          oauth2: {
            authorizationUrl: 'https://linear.app/oauth/authorize',
            tokenUrl: 'https://api.linear.app/oauth/token',
            scopes: ['read', 'write'],
            scopeSeparator: ',',
            tokenEndpointAuthMethod: 'client-secret-post',
            authorizationParameters: { actor: 'app', prompt: 'consent' },
          },
        },
        {
          scheme: 'api-key',
          title: 'Personal API key',
          fields: [{ key: 'api_key', label: 'Personal API key', secret: true }],
        },
      ],
      operations: [
        {
          id: 'linear.teams.list',
          title: 'List Linear teams and workflow states',
          kind: 'search',
          access: 'read',
          risk: 'routine',
          requiredProviderScopes: ['read'],
          inputSchema: objectSchema({}, []),
        },
        {
          id: 'linear.issues.search',
          title: 'Search Linear issues',
          kind: 'search',
          access: 'read',
          risk: 'routine',
          requiredProviderScopes: ['read'],
          inputSchema: objectSchema({
            query: stringSchema('Text to search for'),
            teamId: stringSchema('Optional Linear team UUID'),
          }, ['query']),
        },
        {
          id: 'linear.issues.get',
          title: 'Get a Linear issue and its recent comments',
          kind: 'tool',
          access: 'read',
          risk: 'routine',
          requiredProviderScopes: ['read'],
          inputSchema: objectSchema({
            issueId: stringSchema('Issue UUID or identifier such as ENG-123'),
          }, ['issueId']),
        },
        {
          id: 'linear.issues.create',
          title: 'Create a Linear issue',
          kind: 'action',
          access: 'write',
          risk: 'consequential',
          requiredProviderScopes: ['write'],
          inputSchema: objectSchema({
            teamId: stringSchema('Linear team UUID'),
            title: stringSchema('Issue title'),
            description: stringSchema('Optional Markdown issue description'),
          }, ['teamId', 'title']),
        },
        {
          id: 'linear.issues.update',
          title: 'Update a Linear issue',
          kind: 'action',
          access: 'write',
          risk: 'consequential',
          requiredProviderScopes: ['write'],
          inputSchema: objectSchema({
            issueId: stringSchema('Issue UUID or identifier such as ENG-123'),
            title: stringSchema('Optional replacement title'),
            description: stringSchema('Optional replacement Markdown description'),
            stateId: stringSchema('Optional workflow state UUID'),
            assigneeId: stringSchema('Optional assignee UUID'),
          }, ['issueId']),
        },
        {
          id: 'linear.comments.create',
          title: 'Add a comment to a Linear issue',
          kind: 'action',
          access: 'write',
          risk: 'consequential',
          requiredProviderScopes: ['write'],
          inputSchema: objectSchema({
            issueId: stringSchema('Issue UUID or identifier such as ENG-123'),
            body: stringSchema('Markdown comment body'),
          }, ['issueId', 'body']),
        },
      ],
    },
    authorization: (credential) => ({
      authorization: credential.access_token
        ? `Bearer ${requiredCredential(credential, 'access_token')}`
        : requiredCredential(credential, 'api_key'),
    }),
    verification: {
      request: () => graphqlRequest(`
        query RatThingsVerifyLinear {
          viewer { id name }
          organization { id name }
        }
      `),
      result: (value, scheme, credential) => {
        const envelope = requiredRecord(value, 'Linear verification response');
        const data = requiredRecord(envelope.data, 'Linear verification data');
        const viewer = requiredRecord(data.viewer, 'Linear viewer');
        const organization = requiredRecord(data.organization, 'Linear organization');
        const scopes = scheme === 'oauth2' ? parseScopes(credential.scope) : [];
        return {
          label: `${requiredResultString(organization, 'name')} — ${requiredResultString(viewer, 'name')}`,
          authorization: scheme === 'oauth2' && scopes.length > 0
            ? { scheme, access: 'full', scopeModel: 'granular', scopes }
            : { scheme, access: 'full', scopeModel: 'unknown', scopes: [] },
          externalTenantId: requiredResultString(organization, 'id'),
          externalSubjectId: requiredResultString(viewer, 'id'),
        };
      },
    },
    validateResponse: validateLinearResponse,
    operations: [
      {
        id: 'linear.teams.list',
        request: () => graphqlRequest(`
          query RatThingsLinearTeams {
            teams(first: 100) {
              nodes {
                id
                key
                name
                states { nodes { id name type } }
              }
            }
          }
        `),
      },
      {
        id: 'linear.issues.search',
        request: (input) => graphqlRequest(`
          query RatThingsSearchLinearIssues($term: String!, $teamId: String) {
            searchIssues(term: $term, teamId: $teamId, first: 20) {
              nodes { ${ISSUE_SUMMARY_FIELDS} }
              pageInfo { hasNextPage endCursor }
            }
          }
        `, compactJson({
          term: requiredInputString(input, 'query', 1_024),
          teamId: optionalInputString(input, 'teamId', 256),
        })),
      },
      {
        id: 'linear.issues.get',
        request: (input) => graphqlRequest(`
          query RatThingsGetLinearIssue($id: String!) {
            issue(id: $id) {
              ${ISSUE_FIELDS}
              comments(first: 20) {
                nodes { id body createdAt user { id name } }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        `, { id: requiredInputString(input, 'issueId', 256) }),
      },
      {
        id: 'linear.issues.create',
        request: (input) => graphqlRequest(`
          mutation RatThingsCreateLinearIssue($input: IssueCreateInput!) {
            issueCreate(input: $input) {
              success
              issue { ${ISSUE_FIELDS} }
            }
          }
        `, { input: compactJson({
          teamId: requiredInputString(input, 'teamId', 256),
          title: requiredInputString(input, 'title', 1_024),
          description: optionalInputString(input, 'description', 32_000),
        }) }),
      },
      {
        id: 'linear.issues.update',
        request: (input) => {
          const issueId = requiredInputString(input, 'issueId', 256);
          const update = compactJson({
            title: optionalInputString(input, 'title', 1_024),
            description: optionalInputString(input, 'description', 32_000),
            stateId: optionalInputString(input, 'stateId', 256),
            assigneeId: optionalInputString(input, 'assigneeId', 256),
          });
          if (Object.keys(update).length === 0) {
            throw new Error('Linear issue update requires at least one change');
          }
          return graphqlRequest(`
            mutation RatThingsUpdateLinearIssue($id: String!, $input: IssueUpdateInput!) {
              issueUpdate(id: $id, input: $input) {
                success
                issue { ${ISSUE_FIELDS} }
              }
            }
          `, { id: issueId, input: update });
        },
      },
      {
        id: 'linear.comments.create',
        request: (input) => graphqlRequest(`
          mutation RatThingsCreateLinearComment($input: CommentCreateInput!) {
            commentCreate(input: $input) {
              success
              comment { id body createdAt url user { id name } }
            }
          }
        `, { input: {
          issueId: requiredInputString(input, 'issueId', 256),
          body: requiredInputString(input, 'body', 32_000),
        } }),
      },
    ],
  });
}

function graphqlRequest(query: string, variables?: { [key: string]: JsonValue }) {
  return {
    method: 'POST' as const,
    path: 'graphql',
    json: {
      query: query.replace(/\s+/g, ' ').trim(),
      ...(variables ? { variables } : {}),
    },
  };
}

function validateLinearResponse(value: JsonValue): void {
  const envelope = requiredRecord(value, 'Linear response');
  if (Array.isArray(envelope.errors) && envelope.errors.length > 0) {
    const first = envelope.errors[0];
    const extensions = isRecord(first) && isRecord(first.extensions) ? first.extensions : undefined;
    const code = typeof extensions?.code === 'string' && /^[A-Za-z0-9_:-]{1,128}$/.test(extensions.code)
      ? extensions.code
      : 'unknown';
    throw new Error(`Linear returned a GraphQL error: ${code}`);
  }
  const data = envelope.data;
  if (isRecord(data) && Object.values(data).some((entry) => isRecord(entry) && entry.success === false)) {
    throw new Error('Linear rejected the operation');
  }
}

function parseScopes(value: string | undefined): string[] {
  return [...new Set((value ?? '').split(/[\s,]+/).map((scope) => scope.trim()).filter(Boolean))];
}

function isRecord(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredRecord(value: JsonValue | undefined, label: string): { [key: string]: JsonValue } {
  if (!isRecord(value)) throw new Error(`${label} is invalid`);
  return value;
}

function requiredResultString(value: { [key: string]: JsonValue }, key: string): string {
  const result = value[key];
  if (typeof result !== 'string' || !result || Buffer.byteLength(result, 'utf8') > 512) {
    throw new Error(`Linear response ${key} is invalid`);
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
