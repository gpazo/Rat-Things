import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { emitMetric } from '../core/metrics.js';
import type { CredentialBroker } from '../credentials/broker.js';
import type {
  CredentialVault,
  IntegrationCredentialValue,
  SecretReader,
} from '../credentials/types.js';
import type { ConnectionGrant, IntegrationConnection } from '../domain/capabilities.js';
import { ValidationError } from '../domain/validation.js';
import type { ConnectionService } from './connection-service.js';
import type {
  IntegrationAuthenticationDefinition,
  IntegrationPluginRegistryLike,
  OAuth2AuthorizationDefinition,
} from './integration-types.js';
import { IntegrationProviderUnavailableError } from './integration-types.js';

const AUTHORIZATION_LIFETIME_SECONDS = 10 * 60;
const REFRESH_LEEWAY_MS = 2 * 60_000;

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

export interface OAuthAuthorizationStore {
  create(stateHash: string, record: OAuthAuthorizationRecord): Promise<void>;
  consume(stateHash: string): Promise<OAuthAuthorizationRecord | undefined>;
  acquireRefreshLock(ownerId: string, connectionId: string, token: string, expiresAt: number): Promise<boolean>;
  releaseRefreshLock(ownerId: string, connectionId: string, token: string): Promise<void>;
}

export interface OAuthApplication {
  clientId: string;
  clientSecret: string;
}

export interface OAuthApplicationRegistryLike {
  configured(pluginId: string): boolean;
  application(pluginId: string): Promise<OAuthApplication>;
}

export interface OAuthAuthorizationServiceOptions {
  registry: IntegrationPluginRegistryLike;
  applications: OAuthApplicationRegistryLike;
  store: OAuthAuthorizationStore;
  connections: Pick<ConnectionService, 'create' | 'get' | 'rotate'>;
  fetch?: typeof fetch;
  clock?: { now(): Date };
  randomBytes?: (size: number) => Buffer;
}

export interface StartOAuthAuthorizationInput {
  ownerId: string;
  pluginId: string;
  callbackUrl: string;
  grant: Omit<ConnectionGrant, 'version' | 'grantId' | 'ownerId' | 'connectionId'>;
  alias?: string;
}

export interface ReconnectOAuthAuthorizationInput {
  ownerId: string;
  connectionIdOrAlias: string;
  callbackUrl: string;
}

export class OAuthAuthorizationService {
  private readonly fetcher: typeof fetch;
  private readonly clock: { now(): Date };
  private readonly random: (size: number) => Buffer;

  public constructor(private readonly options: OAuthAuthorizationServiceOptions) {
    this.fetcher = options.fetch ?? fetch;
    this.clock = options.clock ?? { now: () => new Date() };
    this.random = options.randomBytes ?? randomBytes;
  }

  public configured(pluginId: string): boolean {
    return this.options.applications.configured(pluginId);
  }

  public async start(input: StartOAuthAuthorizationInput): Promise<{
    version: '1';
    pluginId: string;
    authorizationUrl: string;
    callbackUrl: string;
    expiresAt: string;
  }> {
    return this.startAuthorization(input);
  }

  /**
   * Starts an operator-only OAuth reconnect. The target connection and its
   * existing grant are bound into server-side state; the browser cannot select
   * a different account, grant, or plugin during the callback.
   */
  public async startReconnect(input: ReconnectOAuthAuthorizationInput): Promise<{
    version: '1';
    pluginId: string;
    connectionId: string;
    authorizationUrl: string;
    callbackUrl: string;
    expiresAt: string;
  }> {
    const current = await this.options.connections.get(input.ownerId, input.connectionIdOrAlias);
    if (current.connection.status === 'revoked') {
      throw new ValidationError('revoked connections cannot be reconnected');
    }
    if (current.connection.authorization.scheme !== 'oauth2') {
      throw new ValidationError('connection does not use hosted OAuth');
    }
    if (!current.grant) throw new Error('connection grant is missing');
    const started = await this.startAuthorization({
      ownerId: input.ownerId,
      pluginId: current.connection.pluginId,
      callbackUrl: input.callbackUrl,
      grant: {
        preset: current.grant.preset,
        ...(current.grant.allowOperations ? { allowOperations: current.grant.allowOperations } : {}),
        ...(current.grant.denyOperations ? { denyOperations: current.grant.denyOperations } : {}),
        ...(current.grant.resourceConstraints ? { resourceConstraints: current.grant.resourceConstraints } : {}),
        ...(current.grant.expiresAt ? { expiresAt: current.grant.expiresAt } : {}),
      },
      reconnectConnectionId: current.connection.connectionId,
    });
    return { ...started, connectionId: current.connection.connectionId };
  }

  private async startAuthorization(input: StartOAuthAuthorizationInput & {
    reconnectConnectionId?: string;
  }): Promise<{
    version: '1';
    pluginId: string;
    authorizationUrl: string;
    callbackUrl: string;
    expiresAt: string;
  }> {
    const authentication = oauthAuthentication(this.options.registry, input.pluginId);
    if (!this.options.applications.configured(input.pluginId)) {
      throw new ValidationError(`OAuth application for ${input.pluginId} is not configured in this deployment`);
    }
    const callbackUrl = trustedCallbackUrl(input.callbackUrl).href;
    const application = await this.options.applications.application(input.pluginId);
    const state = this.random(32).toString('base64url');
    const codeVerifier = this.random(64).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    const now = this.clock.now();
    const expiresAt = Math.floor(now.getTime() / 1_000) + AUTHORIZATION_LIFETIME_SECONDS;
    await this.options.store.create(hashState(state), {
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
    });
    const authorizationUrl = new URL(authentication.oauth2!.authorizationUrl);
    authorizationUrl.searchParams.set('response_type', 'code');
    authorizationUrl.searchParams.set('client_id', application.clientId);
    authorizationUrl.searchParams.set('redirect_uri', callbackUrl);
    authorizationUrl.searchParams.set('state', state);
    authorizationUrl.searchParams.set('code_challenge', codeChallenge);
    authorizationUrl.searchParams.set('code_challenge_method', 'S256');
    authorizationUrl.searchParams.set(
      'scope',
      authentication.oauth2!.scopes.join(authentication.oauth2!.scopeSeparator ?? ' '),
    );
    if (authentication.oauth2!.secondaryToken) {
      authorizationUrl.searchParams.set(
        authentication.oauth2!.secondaryToken.authorizationParameter,
        authentication.oauth2!.secondaryToken.scopes.join(' '),
      );
    }
    for (const [key, value] of Object.entries(authentication.oauth2!.authorizationParameters ?? {})) {
      authorizationUrl.searchParams.set(key, value);
    }
    return {
      version: '1',
      pluginId: input.pluginId,
      authorizationUrl: authorizationUrl.href,
      callbackUrl,
      expiresAt: new Date(expiresAt * 1_000).toISOString(),
    };
  }

  public async complete(input: {
    state: string;
    code?: string;
    providerError?: string;
  }): Promise<{ connection: IntegrationConnection }> {
    if (!/^[A-Za-z0-9_-]{40,128}$/.test(input.state)) {
      throw new ValidationError('OAuth state is invalid or expired');
    }
    const pending = await this.options.store.consume(hashState(input.state));
    if (!pending || pending.version !== '1' || pending.expiresAt <= Math.floor(this.clock.now().getTime() / 1_000)) {
      throw new ValidationError('OAuth state is invalid or expired');
    }
    if (input.providerError) throw new ValidationError('The provider declined or could not complete authorization');
    if (!input.code || Buffer.byteLength(input.code, 'utf8') > 8_192) {
      throw new ValidationError('OAuth callback did not include an authorization code');
    }
    const authentication = oauthAuthentication(this.options.registry, pending.pluginId);
    const application = await this.options.applications.application(pending.pluginId);
    const credential = await exchangeToken({
      fetcher: this.fetcher,
      pluginTitle: this.options.registry.plugin(pending.pluginId).manifest.title,
      definition: authentication.oauth2!,
      application,
      includeSecondaryToken: true,
      parameters: {
        grant_type: 'authorization_code',
        code: input.code,
        redirect_uri: pending.callbackUrl,
        code_verifier: pending.codeVerifier,
      },
      now: this.clock.now(),
    });
    const result = pending.reconnectConnectionId
      ? await this.options.connections.rotate(
        pending.ownerId,
        pending.reconnectConnectionId,
        credential,
      )
      : await this.options.connections.create({
        ownerId: pending.ownerId,
        pluginId: pending.pluginId,
        ...(pending.alias ? { alias: pending.alias } : {}),
        authScheme: 'oauth2',
        credential,
        grant: pending.grant,
      });
    return { connection: result.connection };
  }
}

export class SecretOAuthApplicationRegistry implements OAuthApplicationRegistryLike {
  public constructor(
    private readonly secrets: SecretReader,
    private readonly secretArns: Readonly<Record<string, string>>,
  ) {}

  public configured(pluginId: string): boolean {
    return Boolean(this.secretArns[pluginId]);
  }

  public async application(pluginId: string): Promise<OAuthApplication> {
    const reference = this.secretArns[pluginId];
    if (!reference) throw new ValidationError(`OAuth application for ${pluginId} is not configured`);
    let value: unknown;
    try {
      value = JSON.parse(await this.secrets.get(reference)) as unknown;
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error(`OAuth application secret for ${pluginId} is invalid`);
      throw error;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`OAuth application secret for ${pluginId} is invalid`);
    }
    const clientId = (value as Record<string, unknown>).client_id;
    const clientSecret = (value as Record<string, unknown>).client_secret;
    if (
      typeof clientId !== 'string' ||
      !clientId ||
      Buffer.byteLength(clientId, 'utf8') > 2_048 ||
      typeof clientSecret !== 'string' ||
      !clientSecret ||
      Buffer.byteLength(clientSecret, 'utf8') > 8_192
    ) throw new Error(`OAuth application secret for ${pluginId} requires client_id and client_secret`);
    return { clientId, clientSecret };
  }
}

export interface OAuthRefreshingCredentialBrokerOptions {
  credentials: Pick<CredentialBroker, 'readRecord'>;
  vault: Pick<CredentialVault, 'replace'>;
  registry: IntegrationPluginRegistryLike;
  applications: OAuthApplicationRegistryLike;
  store: OAuthAuthorizationStore;
  fetch?: typeof fetch;
  clock?: { now(): Date };
  sleep?: (milliseconds: number) => Promise<void>;
  randomId?: () => string;
}

/** Resolves one credential and refreshes an expiring OAuth token behind a short Dynamo lease. */
export class OAuthRefreshingCredentialBroker {
  private readonly fetcher: typeof fetch;
  private readonly clock: { now(): Date };
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly randomId: () => string;

  public constructor(private readonly options: OAuthRefreshingCredentialBrokerOptions) {
    this.fetcher = options.fetch ?? fetch;
    this.clock = options.clock ?? { now: () => new Date() };
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.randomId = options.randomId ?? randomUUID;
  }

  public async readRecord(
    reference: string | undefined,
    connection?: IntegrationConnection,
    signal?: AbortSignal,
  ): Promise<IntegrationCredentialValue> {
    const credential = await this.options.credentials.readRecord(reference);
    if (!connection || connection.authorization.scheme !== 'oauth2') return credential;
    const authentication = oauthAuthentication(this.options.registry, connection.pluginId);
    const prefixes = tokenPrefixes(authentication.oauth2!);
    if (!prefixes.some((prefix) => tokenNeedsRefresh(credential, this.clock.now(), prefix))) return credential;
    for (const prefix of prefixes) {
      if (tokenNeedsRefresh(credential, this.clock.now(), prefix) && !credential[tokenField(prefix, 'refresh_token')]) {
        throw new ValidationError(`OAuth connection ${connection.alias} expired and must be reconnected`);
      }
    }
    if (!this.options.applications.configured(connection.pluginId)) {
      throw new ValidationError(`OAuth application for ${connection.pluginId} is no longer configured`);
    }
    const lockToken = this.randomId();
    const acquired = await this.options.store.acquireRefreshLock(
      connection.ownerId,
      connection.connectionId,
      lockToken,
      Math.floor(this.clock.now().getTime() / 1_000) + 30,
    );
    if (!acquired) {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await this.sleep(Math.min(250 * (2 ** attempt), 4_000));
        const refreshed = await this.options.credentials.readRecord(reference);
        if (!prefixes.some((prefix) => tokenNeedsRefresh(refreshed, this.clock.now(), prefix))) return refreshed;
      }
      throw new IntegrationProviderUnavailableError(this.options.registry.plugin(connection.pluginId).manifest.title);
    }
    try {
      const application = await this.options.applications.application(connection.pluginId);
      let replacement = { ...credential };
      for (const prefix of prefixes) {
        if (!tokenNeedsRefresh(replacement, this.clock.now(), prefix)) continue;
        const refreshField = tokenField(prefix, 'refresh_token');
        const refreshToken = replacement[refreshField]!;
        const refreshed = await exchangeToken({
          fetcher: this.fetcher,
          pluginTitle: this.options.registry.plugin(connection.pluginId).manifest.title,
          definition: authentication.oauth2!,
          application,
          parameters: {
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
          },
          credentialPrefix: prefix,
          now: this.clock.now(),
          ...(signal ? { signal } : {}),
        });
        replacement = {
          ...replacement,
          ...refreshed,
          [refreshField]: refreshed[refreshField] ?? refreshToken,
        };
      }
      await this.options.vault.replace(reference!, replacement);
      return replacement;
    } finally {
      try {
        await this.options.store.releaseRefreshLock(
          connection.ownerId,
          connection.connectionId,
          lockToken,
        );
      } catch {
        emitMetric('oauth-refresh', 'CleanupFailure', 1, 'Count');
      }
    }
  }
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

function oauthAuthentication(
  registry: IntegrationPluginRegistryLike,
  pluginId: string,
): IntegrationAuthenticationDefinition {
  let plugin: ReturnType<IntegrationPluginRegistryLike['plugin']>;
  try {
    plugin = registry.plugin(pluginId);
  } catch {
    throw new ValidationError(`integration plugin ${pluginId} is not installed`);
  }
  const authentication = plugin.manifest.authentication.find((candidate) => (
    candidate.scheme === 'oauth2' && candidate.oauth2
  ));
  if (!authentication) throw new ValidationError(`integration plugin ${pluginId} does not support hosted OAuth`);
  return authentication;
}

function trustedCallbackUrl(value: string): URL {
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

function tokenNeedsRefresh(
  credential: IntegrationCredentialValue,
  now: Date,
  prefix = '',
): boolean {
  const expires = credential[tokenField(prefix, 'expires_at')];
  if (!expires) return false;
  const expiresAt = Date.parse(expires);
  return !Number.isFinite(expiresAt) || expiresAt <= now.getTime() + REFRESH_LEEWAY_MS;
}

function tokenPrefixes(definition: OAuth2AuthorizationDefinition): string[] {
  return ['', ...(definition.secondaryToken ? [definition.secondaryToken.credentialPrefix] : [])];
}

function tokenField(prefix: string, field: string): string {
  return prefix ? `${prefix}_${field}` : field;
}

async function exchangeToken(input: {
  fetcher: typeof fetch;
  pluginTitle: string;
  definition: OAuth2AuthorizationDefinition;
  application: OAuthApplication;
  parameters: Record<string, string>;
  credentialPrefix?: string;
  includeSecondaryToken?: boolean;
  now: Date;
  signal?: AbortSignal;
}): Promise<IntegrationCredentialValue> {
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
  let response: Response;
  let text: string;
  try {
    response = await input.fetcher(input.definition.tokenUrl, {
      method: 'POST',
      headers,
      body: form.toString(),
      redirect: 'error',
      signal: input.signal
        ? AbortSignal.any([input.signal, AbortSignal.timeout(20_000)])
        : AbortSignal.timeout(20_000),
    });
    text = await response.text();
  } catch {
    throw new IntegrationProviderUnavailableError(input.pluginTitle);
  }
  if (Buffer.byteLength(text, 'utf8') > 64 * 1024) {
    throw new IntegrationProviderUnavailableError(input.pluginTitle);
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new IntegrationProviderUnavailableError(input.pluginTitle);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new IntegrationProviderUnavailableError(input.pluginTitle);
  }
  const record = value as Record<string, unknown>;
  if (!response.ok || typeof record.error === 'string' || record.ok === false) {
    if (response.status === 429 || response.status >= 500) {
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

function hashState(state: string): string {
  return createHash('sha256').update(state).digest('hex');
}
