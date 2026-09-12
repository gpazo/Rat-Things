import { randomBytes, randomUUID } from 'node:crypto';
import { emitMetric } from '../core/metrics.js';
import type { CredentialBroker } from '../credentials/broker.js';
import { oauthApplication, type OAuthApplication } from '../credentials/oauth-application.js';
import type {
  CredentialVault,
  IntegrationCredentialValue,
  SecretReader,
} from '../credentials/types.js';
import type { IntegrationConnection } from '../domain/capabilities.js';
import { ValidationError } from '../domain/validation.js';
import type { ConnectionService } from './connection-service.js';
import type {
  IntegrationAuthenticationDefinition,
  IntegrationPluginRegistryLike,
  OAuth2AuthorizationDefinition,
} from './integration-types.js';
import { IntegrationProviderUnavailableError } from './integration-types.js';
import {
  hashState,
  oauthAuthorizationRecord,
  oauthAuthorizationUrl,
  oauthCodeChallenge,
  trustedCallbackUrl,
  type OAuthAuthorizationRecord,
  type StartOAuthAuthorizationInput,
} from './oauth-planning.js';
import {
  oauthTokenRequest,
  oauthTokenResponse,
  tokenField,
  tokenNeedsRefresh,
  tokenPrefixes,
} from './oauth-token-planning.js';

export type { OAuthApplication } from '../credentials/oauth-application.js';
export { parseOAuthApplicationSecretArns } from './oauth-planning.js';
export type { OAuthAuthorizationRecord, StartOAuthAuthorizationInput } from './oauth-planning.js';

export interface OAuthAuthorizationStore {
  create(stateHash: string, record: OAuthAuthorizationRecord): Promise<void>;
  consume(stateHash: string): Promise<OAuthAuthorizationRecord | undefined>;
  acquireRefreshLock(ownerId: string, connectionId: string, token: string, expiresAt: number): Promise<boolean>;
  releaseRefreshLock(ownerId: string, connectionId: string, token: string): Promise<void>;
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
    const codeChallenge = oauthCodeChallenge(codeVerifier);
    const now = this.clock.now();
    const record = oauthAuthorizationRecord(input, callbackUrl, codeVerifier, now);
    const expiresAt = record.expiresAt;
    await this.options.store.create(hashState(state), record);
    const authorizationUrl = oauthAuthorizationUrl({
      definition: authentication.oauth2!,
      clientId: application.clientId,
      callbackUrl,
      state,
      codeChallenge,
    });
    return {
      version: '1',
      pluginId: input.pluginId,
      authorizationUrl,
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
    return oauthApplication(value, pluginId);
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
  const request = oauthTokenRequest(input);
  let response: Response;
  let text: string;
  try {
    response = await input.fetcher(input.definition.tokenUrl, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
      redirect: 'error',
      signal: input.signal
        ? AbortSignal.any([input.signal, AbortSignal.timeout(20_000)])
        : AbortSignal.timeout(20_000),
    });
    text = await response.text();
  } catch {
    throw new IntegrationProviderUnavailableError(input.pluginTitle);
  }
  return oauthTokenResponse({
    pluginTitle: input.pluginTitle,
    definition: input.definition,
    ok: response.ok,
    status: response.status,
    text,
    now: input.now,
    ...(input.credentialPrefix !== undefined ? { credentialPrefix: input.credentialPrefix } : {}),
    ...(input.includeSecondaryToken !== undefined ? { includeSecondaryToken: input.includeSecondaryToken } : {}),
  });
}
