import { createHash } from 'node:crypto';
import type { ConnectionGrant } from '../domain/capabilities.js';
import { ValidationError } from '../domain/validation.js';
import type { OAuth2AuthorizationDefinition } from './integration-types.js';

const AUTHORIZATION_LIFETIME_SECONDS = 10 * 60;

export interface OAuthAuthorizationRecord {
  version: '1';
  ownerId: string;
  pluginId: string;
  callbackUrl: string;
  codeVerifier: string;
  grant: Omit<ConnectionGrant, 'version' | 'grantId' | 'ownerId' | 'connectionId'>;
  alias?: string;
  reconnectConnectionId?: string;
  createdAt: string;
  expiresAt: number;
}

export interface StartOAuthAuthorizationInput {
  ownerId: string;
  pluginId: string;
  callbackUrl: string;
  grant: Omit<ConnectionGrant, 'version' | 'grantId' | 'ownerId' | 'connectionId'>;
  alias?: string;
}

export function oauthAuthorizationRecord(
  input: StartOAuthAuthorizationInput & { reconnectConnectionId?: string },
  callbackUrl: string,
  codeVerifier: string,
  now: Date,
): OAuthAuthorizationRecord {
  const expiresAt = Math.floor(now.getTime() / 1_000) + AUTHORIZATION_LIFETIME_SECONDS;
  return {
    version: '1',
    ownerId: input.ownerId,
    pluginId: input.pluginId,
    callbackUrl,
    codeVerifier,
    grant: input.grant,
    ...(input.alias ? { alias: input.alias } : {}),
    ...(input.reconnectConnectionId ? { reconnectConnectionId: input.reconnectConnectionId } : {}),
    createdAt: now.toISOString(),
    expiresAt,
  };
}

export function oauthAuthorizationUrl(input: {
  definition: OAuth2AuthorizationDefinition;
  clientId: string;
  callbackUrl: string;
  state: string;
  codeChallenge: string;
}): string {
  const authorizationUrl = new URL(input.definition.authorizationUrl);
  authorizationUrl.searchParams.set('response_type', 'code');
  authorizationUrl.searchParams.set('client_id', input.clientId);
  authorizationUrl.searchParams.set('redirect_uri', input.callbackUrl);
  authorizationUrl.searchParams.set('state', input.state);
  authorizationUrl.searchParams.set('code_challenge', input.codeChallenge);
  authorizationUrl.searchParams.set('code_challenge_method', 'S256');
  authorizationUrl.searchParams.set(
    'scope',
    input.definition.scopes.join(input.definition.scopeSeparator ?? ' '),
  );
  if (input.definition.secondaryToken) {
    authorizationUrl.searchParams.set(
      input.definition.secondaryToken.authorizationParameter,
      input.definition.secondaryToken.scopes.join(' '),
    );
  }
  for (const [key, value] of Object.entries(input.definition.authorizationParameters ?? {})) {
    authorizationUrl.searchParams.set(key, value);
  }
  return authorizationUrl.href;
}

export function oauthCodeChallenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier).digest('base64url');
}

export function trustedCallbackUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.hostname ||
    url.pathname !== '/v1/integrations/oauth/callback'
  ) throw new ValidationError('OAuth callback URL is invalid');
  return url;
}

export function hashState(state: string): string {
  return createHash('sha256').update(state).digest('hex');
}

export function parseOAuthApplicationSecretArns(value: string | undefined): Record<string, string> {
  if (!value) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error('INTEGRATION_OAUTH_APP_SECRET_ARNS must be valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('INTEGRATION_OAUTH_APP_SECRET_ARNS must be a JSON object');
  }
  const result: Record<string, string> = {};
  for (const [pluginId, reference] of Object.entries(parsed)) {
    if (
      !/^[a-z][a-z0-9-]{0,63}$/.test(pluginId) ||
      typeof reference !== 'string' ||
      !/^arn:[A-Za-z0-9-]+:secretsmanager:[A-Za-z0-9-]+:[0-9]{12}:secret:[^\s]{1,512}$/.test(reference)
    ) throw new Error('INTEGRATION_OAUTH_APP_SECRET_ARNS contains an invalid entry');
    result[pluginId] = reference;
  }
  return result;
}
