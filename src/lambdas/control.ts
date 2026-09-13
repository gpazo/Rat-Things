import { getSessionPublicationService } from '../app/composition.js';
import { parseAgentsContract } from '../domain/agents-api-validation.js';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyHandlerV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { cloudFrontSignedAccess } from '../adapters/cloudfront-publications.js';
import { createAwsClients, publicationShareObjectKey } from '../adapters/aws-runtime.js';
import { requiredEnv } from '../adapters/executors.js';
import {
  RAT_THINGS_OPENAPI,
  RAT_THINGS_SCHEMAS,
  ratThingsDiscovery,
} from '../app/discovery.js';
import { getConnectionConsumerService, getConnectionService, getIntegrationPluginRegistry, getCapabilityProfileRegistry, getOAuthAuthorizationService, getScheduleService } from '../app/composition.js';
import { NotFoundError } from '../core/run-service.js';
import type { IntegrationCredentialValue } from '../credentials/types.js';
import {
  validateConnectionGrant,
  type ConnectionGrant,
  type IntegrationAuthScheme,
} from '../domain/capabilities.js';
import type { PublicationShare, ShareGrant } from '../domain/publications.js';
import { parseOAuthApplicationSecretArns } from '../plugins/oauth.js';
import { validateShareGrant, validatePublicationId } from '../domain/publications.js';
import {
  isRecord,
  rejectUnknown,
  requiredRecord,
  ValidationError,
} from '../domain/validation.js';
import { apiIngressContext } from '../identity/context.js';
import { getAgentsApiServices } from '../app/composition.js';
import { agentsErrorResponse, routeAgentsRequest } from './agents-router.js';
import { AgentsApiError } from '../domain/agents-api-validation.js';
import { errorResponse, jsonBody, principal, response, secretValue } from './runtime.js';

const awsClients = createAwsClients();
const artifactClient = awsClients.s3;

let publicationPrivateKeyPromise: Promise<string> | undefined;

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const method = event.requestContext.http.method;
    const path = event.rawPath;
    if (method === 'GET' && path === '/health') {
      return response(200, { status: 'ok', service: 'rat-things' });
    }
    if (method === 'GET' && path === '/.well-known/rat-things') {
      return response(200, ratThingsDiscovery(process.env.RAT_THINGS_DOCS_URL), {
        'cache-control': 'public, max-age=300',
      });
    }
    if (method === 'GET' && path === '/openapi.json') {
      return response(200, RAT_THINGS_OPENAPI, {
        'cache-control': 'public, max-age=300',
      });
    }
    const schema = RAT_THINGS_SCHEMAS[path];
    if (method === 'GET' && schema) {
      return response(200, schema, {
        'cache-control': 'public, max-age=300',
        'content-type': 'application/schema+json; charset=utf-8',
      });
    }
    if (method === 'GET' && path === '/v1/integrations/oauth/callback') {
      try {
        await getOAuthAuthorizationService().complete({
          state: event.queryStringParameters?.state ?? '',
          ...(event.queryStringParameters?.code
            ? { code: event.queryStringParameters.code }
            : {}),
          ...(event.queryStringParameters?.error
            ? { providerError: event.queryStringParameters.error }
            : {}),
        });
        return oauthCallbackResponse(true, event.requestContext.requestId);
      } catch (error) {
        console.warn(JSON.stringify({
          level: 'warn',
          message: 'OAuth callback failed',
          error: error instanceof Error ? { name: error.name, message: error.message.slice(0, 500) } : {},
          requestId: event.requestContext.requestId,
        }));
        return oauthCallbackResponse(false, event.requestContext.requestId);
      }
    }
    const shareToken = sharePathParameter(event);
    if (
      method === 'GET' &&
      shareToken &&
      routeMatches(event, 'GET /__share/{token}', `/__share/${shareToken}`)
    ) {
      return artifactShareResponse(shareToken);
    }

    if (/^\/v1\/(agents|vaults|files|skills|webhooks)(\/|$)/.test(path)) {
      let apiResponse: Response;
      try {
        let owner: string;
        try { owner = principal(event); } catch { throw new AgentsApiError(401, 'Authentication required.', 'invalid_api_key'); }
        const request = new Request(`https://control.invalid${path}${event.rawQueryString ? `?${event.rawQueryString}` : ''}`, {
          method,
          headers: Object.fromEntries(Object.entries(event.headers).filter((entry): entry is [string, string] => entry[1] !== undefined)),
          ...(event.body && method !== 'GET' && method !== 'HEAD' ? { body: event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body } : {}),
        });
        apiResponse = await routeAgentsRequest(request, owner, getAgentsApiServices(), event.requestContext.requestId, false);
      } catch (error) { apiResponse = agentsErrorResponse(error, event.requestContext.requestId); }
      const headers: Record<string, string> = {};
      apiResponse.headers.forEach((value, key) => { headers[key] = value; });
      const binary = ['application/octet-stream', 'application/zip'].includes(apiResponse.headers.get('content-type') ?? '');
      return {
        statusCode: apiResponse.status,
        headers,
        body: binary ? Buffer.from(await apiResponse.arrayBuffer()).toString('base64') : await apiResponse.text(),
        ...(binary ? { isBase64Encoded: true } : {}),
      };
    }
    const context = apiIngressContext(principal(event));
    const ownerId = context.owner.id;
    const sessionPublication = /^\/v1\/sessions\/(sess_[A-Za-z0-9_-]+)\/publications$/.exec(path);
    if (method === 'POST' && sessionPublication) {
      return response(201, await getSessionPublicationService().publish(
        ownerId, sessionPublication[1]!, jsonBody(event),
      ));
    }

    if (method === 'GET' && path === '/v1/integrations/plugins') {
      const oauthApplicationSecretArns = parseOAuthApplicationSecretArns(
        process.env.INTEGRATION_OAUTH_APP_SECRET_ARNS,
      );
      const callbackUrl = oauthCallbackUrl(event);
      return response(200, {
        plugins: getIntegrationPluginRegistry().list().map((plugin) => ({
          ...plugin.manifest,
          ...(plugin.manifest.authentication.some((authentication) => authentication.oauth2)
            ? {
              oauthInstallation: {
                status: oauthApplicationSecretArns[plugin.manifest.id]
                  ? 'configured'
                  : 'host-required',
                callbackUrl,
              },
            }
            : {}),
        })),
      });
    }
    if (method === 'GET' && path === '/v1/capability-profiles') {
      return response(200, { profiles: getCapabilityProfileRegistry().list() });
    }
    if (method === 'GET' && path === '/v1/integrations/connections') {
      return response(200, { connections: await getConnectionService().list(ownerId) });
    }
    if (method === 'POST' && path === '/v1/integrations/connections') {
      const input = createConnectionBody(jsonBody(event), ownerId);
      return response(201, await getConnectionService().create(input));
    }
    if (method === 'POST' && path === '/v1/integrations/oauth/authorizations') {
      const body = strictBody(jsonBody(event), ['version', 'pluginId', 'alias', 'grant']);
      requireVersion(body.version);
      return response(201, await getOAuthAuthorizationService().start({
        ownerId,
        pluginId: boundedText(body.pluginId, 'pluginId', 64),
        callbackUrl: oauthCallbackUrl(event),
        grant: grantPolicy(body.grant),
        ...(body.alias !== undefined ? { alias: boundedText(body.alias, 'alias', 128) } : {}),
      }));
    }
    const integrationConnectionId = resourcePathParameter(event, 'connectionId', 256);
    if (
      method === 'GET' &&
      integrationConnectionId &&
      routeMatches(
        event,
        'GET /v1/integrations/connections/{connectionId}',
        `/v1/integrations/connections/${integrationConnectionId}`,
      )
    ) {
      return response(200, await getConnectionService().get(ownerId, integrationConnectionId));
    }
    if (
      method === 'PATCH' &&
      integrationConnectionId &&
      routeMatches(
        event,
        'PATCH /v1/integrations/connections/{connectionId}',
        `/v1/integrations/connections/${integrationConnectionId}`,
      )
    ) {
      const body = strictBody(jsonBody(event), ['version', 'displayName']);
      requireVersion(body.version);
      return response(200, await getConnectionService().rename(
        ownerId,
        integrationConnectionId,
        boundedText(body.displayName, 'displayName', 256),
      ));
    }
    if (
      method === 'POST' &&
      integrationConnectionId &&
      routeMatches(
        event,
        'POST /v1/integrations/connections/{connectionId}/test',
        `/v1/integrations/connections/${integrationConnectionId}/test`,
      )
    ) {
      strictBody(jsonBody(event), []);
      return response(200, await getConnectionService().test(ownerId, integrationConnectionId));
    }
    if (
      method === 'GET' &&
      integrationConnectionId &&
      routeMatches(
        event,
        'GET /v1/integrations/connections/{connectionId}/consumers',
        `/v1/integrations/connections/${integrationConnectionId}/consumers`,
      )
    ) {
      return response(200, await getConnectionConsumerService().list(ownerId, integrationConnectionId));
    }
    if (
      method === 'POST' &&
      integrationConnectionId &&
      routeMatches(
        event,
        'POST /v1/integrations/connections/{connectionId}/grant',
        `/v1/integrations/connections/${integrationConnectionId}/grant`,
      )
    ) {
      return response(200, await getConnectionService().replaceGrant(
        ownerId,
        integrationConnectionId,
        grantPolicy(jsonBody(event)),
      ));
    }
    if (
      method === 'POST' &&
      integrationConnectionId &&
      routeMatches(
        event,
        'POST /v1/integrations/connections/{connectionId}/oauth/reconnect',
        `/v1/integrations/connections/${integrationConnectionId}/oauth/reconnect`,
      )
    ) {
      const body = strictBody(jsonBody(event), ['version']);
      requireVersion(body.version);
      return response(201, await getOAuthAuthorizationService().startReconnect({
        ownerId,
        connectionIdOrAlias: integrationConnectionId,
        callbackUrl: oauthCallbackUrl(event),
      }));
    }
    if (
      method === 'POST' &&
      integrationConnectionId &&
      routeMatches(
        event,
        'POST /v1/integrations/connections/{connectionId}/credential',
        `/v1/integrations/connections/${integrationConnectionId}/credential`,
      )
    ) {
      const body = strictBody(jsonBody(event), ['version', 'credential']);
      requireVersion(body.version);
      return response(200, await getConnectionService().rotate(
        ownerId,
        integrationConnectionId,
        credentialValue(body.credential),
      ));
    }
    if (
      method === 'POST' &&
      integrationConnectionId &&
      routeMatches(
        event,
        'POST /v1/integrations/connections/{connectionId}/revoke',
        `/v1/integrations/connections/${integrationConnectionId}/revoke`,
      )
    ) {
      strictBody(jsonBody(event), []);
      return response(200, await getConnectionService().revoke(ownerId, integrationConnectionId));
    }
    if (method === 'GET' && path === '/v1/integrations/connection-sets') {
      return response(200, { connectionSets: await getConnectionService().listSets(ownerId) });
    }
    if (method === 'POST' && path === '/v1/integrations/connection-sets') {
      const body = strictBody(jsonBody(event), ['version', 'name', 'connections', 'defaults']);
      requireVersion(body.version);
      return response(201, await getConnectionService().createSet({
        ownerId,
        name: boundedText(body.name, 'name', 128),
        connections: stringArray(body.connections, 'connections', 128),
        ...(body.defaults !== undefined ? { defaults: stringRecord(body.defaults, 'defaults', 64) } : {}),
      }));
    }
    if (method === 'GET' && path === '/v1/integrations/source-bindings') {
      return response(200, {
        sourceBindings: await getConnectionService().listSourceBindings(ownerId),
      });
    }
    if (method === 'POST' && path === '/v1/integrations/source-bindings') {
      const body = strictBody(jsonBody(event), [
        'version',
        'sourceKind',
        'selector',
        'agentId', 'environment', 'vaultIds',
        'connectionSetId',
      ]);
      requireVersion(body.version);
      const sourceKind = boundedText(body.sourceKind, 'sourceKind', 32);
      if (!['api', 'github', 'gitlab', 'teams', 'slack'].includes(sourceKind)) {
        throw new ValidationError('sourceKind is invalid');
      }
      const agentId = boundedText(body.agentId, 'agentId', 256);
      await getAgentsApiServices().agents.retrieve(ownerId, agentId);
      const target = parseAgentsContract('SessionCreate', { agent_id: agentId, environment: body.environment, vault_ids: body.vaultIds ?? [], input: 'Validate source binding' });
      await getAgentsApiServices().vaults.requireVaults(ownerId, target.vault_ids ?? []);
      if (target.environment.type === 'openai_hosted' && target.environment.environment_template_id) await getAgentsApiServices().templates.retrieve(ownerId, target.environment.environment_template_id);
      return response(201, await getConnectionService().createSourceBinding({
        ownerId,
        sourceKind: sourceKind as 'api' | 'github' | 'gitlab' | 'teams' | 'slack',
        selector: stringRecord(body.selector, 'selector', 32),
        agentId, environment: target.environment, vaultIds: target.vault_ids ?? [],
        ...(body.connectionSetId !== undefined
          ? { connectionSetId: boundedText(body.connectionSetId, 'connectionSetId', 256) }
          : {}),
      }));
    }
    if (path === '/v1/schedules') {
      if (method === 'POST') return response(201, await getScheduleService().create(ownerId, jsonBody(event)));
      if (method === 'GET') return response(200, await getScheduleService().list(ownerId, { ...(event.queryStringParameters?.after ? { after: event.queryStringParameters.after } : {}), ...(event.queryStringParameters?.limit ? { limit: parseLimit(event.queryStringParameters.limit) ?? 20 } : {}) }));
    }
    const schedulePath = /^\/v1\/schedules\/([^/]+)(?:\/(pause|resume))?$/.exec(path);
    if (schedulePath) {
      const id = schedulePath[1]!;
      if (method === 'GET' && !schedulePath[2]) return response(200, await getScheduleService().retrieve(ownerId, id));
      if (method === 'PUT' && !schedulePath[2]) return response(200, await getScheduleService().update(ownerId, id, jsonBody(event)));
      if (method === 'DELETE' && !schedulePath[2]) return response(200, await getScheduleService().status(ownerId, id, 'deleted'));
      if (method === 'POST' && schedulePath[2]) return response(200, await getScheduleService().status(ownerId, id, schedulePath[2] === 'pause' ? 'paused' : 'active'));
    }
    return errorResponse(new NotFoundError('route not found'), event.requestContext.requestId);
  } catch (error) {
    return errorResponse(error, event.requestContext.requestId);
  }
};

function resourcePathParameter(
  event: APIGatewayProxyEventV2,
  name: string,
  maximum = 128,
): string | undefined {
  const value = event.pathParameters?.[name];
  return value && value.length <= maximum && /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(value)
    ? value
    : undefined;
}

function routeMatches(
  event: APIGatewayProxyEventV2,
  routeKey: string,
  decodedPath: string,
): boolean {
  return event.routeKey === routeKey || decodeURIComponent(event.rawPath) === decodedPath;
}

function parseLimit(value: string | undefined): number {
  if (!value) return 25;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 25;
}

function strictBody(value: unknown, allowed: string[]): Record<string, unknown> {
  const input = requiredRecord(value, 'request');
  rejectUnknown(input, allowed, 'request');
  return input;
}

function oauthCallbackUrl(event: APIGatewayProxyEventV2): string {
  const domain = event.requestContext.domainName;
  if (
    typeof domain !== 'string' ||
    !/^[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/.test(domain) ||
    domain.includes('..')
  ) throw new ValidationError('OAuth callback host is invalid');
  return `https://${domain}/v1/integrations/oauth/callback`;
}

function oauthCallbackResponse(
  succeeded: boolean,
  requestId: string,
): APIGatewayProxyStructuredResultV2 {
  const title = succeeded ? 'Connection installed' : 'Connection not installed';
  const detail = succeeded
    ? 'The provider account is connected to this Rat Things deployment. You can close this window and return to the console.'
    : 'Rat Things could not complete this authorization. Close this window, verify the OAuth application configuration, and try again.';
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>:root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0c0f0c;color:#edf2e8;font:16px/1.55 system-ui,sans-serif}.card{width:min(560px,calc(100vw - 40px));padding:32px;border:1px solid #30382f;border-radius:16px;background:#151a15;box-shadow:0 28px 80px #0008}.mark{display:grid;width:44px;height:44px;place-items:center;margin-bottom:24px;border-radius:12px;background:#b9df68;color:#11170d;font-weight:850}h1{margin:0 0 10px;color:#edf2e8;font-size:24px}p{margin:0;color:#aab3a4}.request{margin-top:20px;color:#7f897a;font:12px ui-monospace,monospace}</style></head><body><main class="card"><div class="mark">R</div><h1>${title}</h1><p>${detail}</p><p class="request">Request ${requestId.replace(/[^A-Za-z0-9-]/g, '').slice(0, 128)}</p></main></body></html>`;
  return {
    statusCode: succeeded ? 200 : 400,
    headers: {
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      'content-type': 'text/html; charset=utf-8',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
    },
    body,
  };
}

function boundedText(value: unknown, label: string, maximumBytes: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ValidationError(`${label} must be a non-empty string`);
  }
  if (Buffer.byteLength(value, 'utf8') > maximumBytes) {
    throw new ValidationError(`${label} exceeds ${maximumBytes} bytes`);
  }
  return value;
}

function createConnectionBody(body: unknown, ownerId: string) {
  const input = strictBody(body, [
    'version',
    'pluginId',
    'alias',
    'authScheme',
    'credential',
    'grant',
  ]);
  requireVersion(input.version);
  const authScheme = boundedText(input.authScheme, 'authScheme', 32);
  if (!['oauth2', 'api-key', 'session', 'basic'].includes(authScheme)) {
    throw new ValidationError('authScheme is invalid');
  }
  return {
    ownerId,
    pluginId: boundedText(input.pluginId, 'pluginId', 64),
    ...(input.alias !== undefined ? { alias: boundedText(input.alias, 'alias', 128) } : {}),
    authScheme: authScheme as IntegrationAuthScheme,
    credential: credentialValue(input.credential),
    grant: grantPolicy(input.grant),
  };
}

function credentialValue(value: unknown): IntegrationCredentialValue {
  const input = strictBody(value, Object.keys(isRecord(value) ? value : {}));
  const result: IntegrationCredentialValue = {};
  for (const [key, item] of Object.entries(input)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) {
      throw new ValidationError(`credential field ${key} is invalid`);
    }
    result[key] = boundedText(item, `credential.${key}`, 32_768);
  }
  if (Object.keys(result).length === 0) throw new ValidationError('credential requires at least one field');
  return result;
}

function grantPolicy(
  value: unknown,
): Omit<ConnectionGrant, 'version' | 'grantId' | 'ownerId' | 'connectionId'> {
  const input = strictBody(value, [
    'version',
    'preset',
    'allowOperations',
    'denyOperations',
    'resourceConstraints',
    'expiresAt',
  ]);
  requireVersion(input.version);
  const preset = boundedText(input.preset, 'preset', 32) as ConnectionGrant['preset'];
  if (!['read-only', 'read-write', 'full', 'custom'].includes(preset)) {
    throw new ValidationError('preset is invalid');
  }
  let validated: ConnectionGrant;
  try {
    validated = validateConnectionGrant({
      version: '1',
      grantId: 'validation-grant',
      ownerId: 'validation-owner',
      connectionId: 'validation-connection',
      preset,
      ...(input.allowOperations !== undefined
        ? { allowOperations: stringArray(input.allowOperations, 'allowOperations', 128) }
        : {}),
      ...(input.denyOperations !== undefined
        ? { denyOperations: stringArray(input.denyOperations, 'denyOperations', 128) }
        : {}),
      ...(input.resourceConstraints !== undefined
        ? { resourceConstraints: resourceConstraints(input.resourceConstraints) }
        : {}),
      ...(input.expiresAt !== undefined
        ? { expiresAt: boundedText(input.expiresAt, 'expiresAt', 64) }
        : {}),
    });
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError(error instanceof Error ? error.message : 'grant policy is invalid');
  }
  const { version: _version, grantId: _grantId, ownerId: _ownerId, connectionId: _connectionId, ...policy } = validated;
  return policy;
}

function resourceConstraints(value: unknown): NonNullable<ConnectionGrant['resourceConstraints']> {
  if (!isRecord(value) || Object.keys(value).length > 64) {
    throw new ValidationError('resourceConstraints must be an object with at most 64 entries');
  }
  return Object.fromEntries(Object.entries(value).map(([field, allowed]) => [
    boundedText(field, 'resourceConstraints field', 256),
    stringArray(allowed, `resourceConstraints.${field}`, 256),
  ]));
}

function requireVersion(value: unknown): void {
  if (value !== '1') throw new ValidationError('version must be "1"');
}

function stringArray(value: unknown, label: string, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new ValidationError(`${label} must be an array with at most ${maximum} entries`);
  }
  return value.map((item, index) => boundedText(item, `${label}[${index}]`, 512));
}

function stringRecord(value: unknown, label: string, maximum: number): Record<string, string> {
  if (!isRecord(value) || Object.keys(value).length > maximum) {
    throw new ValidationError(`${label} must be an object with at most ${maximum} entries`);
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    boundedText(key, `${label} key`, 256),
    boundedText(item, `${label}.${key}`, 512),
  ]));
}

function publicationHost(publicationId: string, ownerHash: string): string {
  validatePublicationId(publicationId);
  if (!/^[a-f0-9]{32}$/.test(ownerHash)) throw new Error('publication owner hash is invalid');
  const domain = requiredEnv('PUBLICATION_BASE_DOMAIN').toLowerCase().replace(/^\.+|\.+$/g, '');
  if (
    domain.length > 253 ||
    !domain.includes('.') ||
    domain.split('.').some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) throw new Error('PUBLICATION_BASE_DOMAIN is invalid');
  return `${publicationId}-${ownerHash}.${domain}`;
}

async function publicationPrivateKey(): Promise<string> {
  publicationPrivateKeyPromise ??= loadPublicationPrivateKey().catch((error: unknown) => {
    publicationPrivateKeyPromise = undefined;
    throw error;
  });
  return publicationPrivateKeyPromise;
}

async function loadPublicationPrivateKey(): Promise<string> {
  const result = await awsClients.secrets.send(new GetSecretValueCommand({
    SecretId: requiredEnv('PUBLICATION_PRIVATE_KEY_SECRET_ARN'),
  }));
  const raw = result.SecretString ?? (
    result.SecretBinary ? Buffer.from(result.SecretBinary).toString('utf8') : undefined
  );
  if (!raw) throw new Error('publication signing key secret is empty');
  const privateKey = secretValue(raw, ['privateKey', 'private_key', 'key']);
  if (!privateKey.includes('BEGIN PRIVATE KEY') && !privateKey.includes('BEGIN RSA PRIVATE KEY')) {
    throw new Error('publication signing key secret does not contain a PEM private key');
  }
  return privateKey;
}

async function artifactShareResponse(token: string) {
  const bucket = requiredEnv('ARTIFACT_BUCKET');
  let raw: string;
  try {
    const result = await artifactClient.send(new GetObjectCommand({
      Bucket: bucket,
      Key: publicationShareObjectKey(token),
    }));
    if (!result.Body) throw new NotFoundError('artifact share not found');
    raw = await result.Body.transformToString('utf8');
  } catch (error) {
    if (error instanceof NotFoundError) throw error;
    if (['NoSuchKey', 'NotFound'].includes(errorName(error))) {
      throw new NotFoundError('artifact share not found');
    }
    throw error;
  }
  const share = parseArtifactShare(raw, token);
  if (share.grant.revokedAt) {
    throw new NotFoundError('artifact share has been revoked');
  }
  const remainingSeconds = Math.ceil((Date.parse(share.grant.expiresAt) - Date.now()) / 1_000);
  if (remainingSeconds <= 0) throw new NotFoundError('artifact share has expired');
  const host = publicationHost(share.grant.publicationId, share.grant.ownerHash);
  const target = `https://${host}/`;
  const access = cloudFrontSignedAccess({
    grant: share.grant,
    resource: `https://${host}/*`,
    keyPairId: requiredEnv('PUBLICATION_KEY_PAIR_ID'),
    privateKey: await publicationPrivateKey(),
  }, target);
  return {
    statusCode: 302,
    headers: {
      'cache-control': 'private, no-store',
      location: access.url,
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    },
    cookies: access.cookies,
    body: '',
  };
}

function parseArtifactShare(raw: string, token: string): PublicationShare {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new NotFoundError('artifact share not found');
  }
  if (!isRecord(parsed) || parsed.version !== '2') {
    throw new NotFoundError('artifact share not found');
  }
  const ownerHash = token.slice(0, 32);
  if (
    !isRecord(parsed.grant) ||
    !['file', 'site', 'video'].includes(String(parsed.kind)) ||
    parsed.grant.id !== token ||
    parsed.grant.ownerHash !== ownerHash
  ) throw new NotFoundError('artifact share not found');
  try {
    validateShareGrant(parsed.grant as unknown as ShareGrant);
  } catch {
    throw new NotFoundError('artifact share not found');
  }
  return parsed as unknown as PublicationShare;
}

function sharePathParameter(event: APIGatewayProxyEventV2): string | undefined {
  const token = event.pathParameters?.token;
  return token && /^[a-f0-9]{32}-[a-f0-9]{64}$/.test(token) ? token : undefined;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : '';
}
