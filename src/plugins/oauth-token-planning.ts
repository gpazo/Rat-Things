import type { OAuthApplication } from '../credentials/oauth-application.js';
import type { IntegrationCredentialValue } from '../credentials/types.js';
import { ValidationError } from '../domain/validation.js';
import type { OAuth2AuthorizationDefinition } from './integration-types.js';
import { IntegrationProviderUnavailableError } from './integration-types.js';

const REFRESH_LEEWAY_MS = 2 * 60_000;

export function tokenNeedsRefresh(
  credential: IntegrationCredentialValue,
  now: Date,
  prefix = '',
): boolean {
  const expires = credential[tokenField(prefix, 'expires_at')];
  if (!expires) return false;
  const expiresAt = Date.parse(expires);
  return !Number.isFinite(expiresAt) || expiresAt <= now.getTime() + REFRESH_LEEWAY_MS;
}

export function tokenPrefixes(definition: OAuth2AuthorizationDefinition): string[] {
  return ['', ...(definition.secondaryToken ? [definition.secondaryToken.credentialPrefix] : [])];
}

export function tokenField(prefix: string, field: string): string {
  return prefix ? `${prefix}_${field}` : field;
}

export function oauthTokenRequest(input: {
  definition: OAuth2AuthorizationDefinition;
  application: OAuthApplication;
  parameters: Readonly<Record<string, string>>;
}): { headers: Record<string, string>; body: string } {
  const form = new URLSearchParams(input.parameters);
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/x-www-form-urlencoded',
  };
  if (input.definition.tokenEndpointAuthMethod === 'client-secret-basic') {
    headers.authorization = `Basic ${Buffer.from(
      `${formEncoded(input.application.clientId)}:${formEncoded(input.application.clientSecret)}`,
      'utf8',
    ).toString('base64')}`;
  } else {
    form.set('client_id', input.application.clientId);
    form.set('client_secret', input.application.clientSecret);
  }
  return { headers, body: form.toString() };
}

export function oauthTokenResponse(input: {
  pluginTitle: string;
  definition: OAuth2AuthorizationDefinition;
  ok: boolean;
  status: number;
  text: string;
  credentialPrefix?: string;
  includeSecondaryToken?: boolean;
  now: Date;
}): IntegrationCredentialValue {
  if (Buffer.byteLength(input.text, 'utf8') > 64 * 1024) {
    throw new IntegrationProviderUnavailableError(input.pluginTitle);
  }
  let value: unknown;
  try {
    value = JSON.parse(input.text) as unknown;
  } catch {
    throw new IntegrationProviderUnavailableError(input.pluginTitle);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new IntegrationProviderUnavailableError(input.pluginTitle);
  }
  const record = value as Record<string, unknown>;
  if (!input.ok || typeof record.error === 'string' || record.ok === false) {
    if (input.status === 429 || input.status >= 500) {
      throw new IntegrationProviderUnavailableError(input.pluginTitle);
    }
    throw new ValidationError(`${input.pluginTitle} rejected the OAuth token exchange`);
  }
  const result = tokenCredential(record, input.now, input.credentialPrefix ?? '');
  if (input.includeSecondaryToken && input.definition.secondaryToken) {
    const secondary = record[input.definition.secondaryToken.responseField];
    if (!secondary || typeof secondary !== 'object' || Array.isArray(secondary)) {
      throw new ValidationError(`${input.pluginTitle} did not issue the requested delegated user token`);
    }
    Object.assign(result, tokenCredential(
      secondary as Record<string, unknown>,
      input.now,
      input.definition.secondaryToken.credentialPrefix,
    ));
  }
  return result;
}

function tokenCredential(
  record: Record<string, unknown>,
  now: Date,
  prefix: string,
): IntegrationCredentialValue {
  const result: IntegrationCredentialValue = {
    [tokenField(prefix, 'access_token')]: boundedToken(record.access_token, 'OAuth access token'),
  };
  const refreshToken = optionalToken(record.refresh_token, 'OAuth refresh token');
  const tokenType = optionalToken(record.token_type, 'OAuth token type', 128);
  const scope = optionalToken(record.scope, 'OAuth scope', 16_384);
  if (refreshToken) result[tokenField(prefix, 'refresh_token')] = refreshToken;
  if (tokenType) result[tokenField(prefix, 'token_type')] = tokenType;
  if (scope) result[tokenField(prefix, 'scope')] = scope;
  const expiresIn = numericSeconds(record.expires_in);
  if (expiresIn !== undefined) {
    result[tokenField(prefix, 'expires_at')] = new Date(now.getTime() + expiresIn * 1_000).toISOString();
  }
  return result;
}

function boundedToken(value: unknown, label: string, maximumBytes = 32_768): string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > maximumBytes) {
    throw new ValidationError(`${label} is missing or invalid`);
  }
  return value;
}

function optionalToken(value: unknown, label: string, maximumBytes = 32_768): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return boundedToken(value, label, maximumBytes);
}

function numericSeconds(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 366 * 24 * 60 * 60) {
    throw new ValidationError('OAuth expires_in is invalid');
  }
  return Math.floor(parsed);
}

function formEncoded(value: string): string {
  return new URLSearchParams({ value }).toString().slice('value='.length);
}
