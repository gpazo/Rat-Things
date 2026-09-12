import { randomUUID } from 'node:crypto';
import { emitMetric } from '../core/metrics.js';
import type {
  CredentialVault,
  IntegrationCredentialValue,
} from '../credentials/types.js';
import {
  validateConnectionSet,
  validateIntegrationConnection,
  validateSourceCapabilityBinding,
  type ConnectionHealth,
  type ConnectionGrant,
  type ConnectionSet,
  type IntegrationAuthScheme,
  type IntegrationConnection,
  type SourceCapabilityBinding,
} from '../domain/capabilities.js';
import { ValidationError } from '../domain/validation.js';
import type {
  IntegrationPluginRegistryLike,
  IntegrationStore,
  VerifiedIntegrationCredential,
} from './integration-types.js';
import { IntegrationProviderUnavailableError } from './integration-types.js';
import {
  aliasCandidate,
  connectionCredentialName,
  connectionGrant,
  connectionHealthObservation,
  connectionWithStatus,
  defaultAlias,
  newConnection,
  refreshedConnection,
  sameProviderIdentity,
  untestedConnectionHealth,
} from './connection-planning.js';
import {
  connectionDisplayName,
  requiredOwner,
  safeAlias,
  validateCredentialFields,
  validateGrantOperations,
} from './connection-validation.js';

export interface ConnectionServiceOptions {
  store: IntegrationStore;
  vault: CredentialVault;
  registry: IntegrationPluginRegistryLike;
  credentialNamePrefix: string;
  /** Trusted control-plane reader. This is never registered as an agent dynamic tool. */
  credentials?: {
    readRecord(
      reference: string | undefined,
      connection?: IntegrationConnection,
      signal?: AbortSignal,
    ): Promise<IntegrationCredentialValue>;
  };
  ids?: { random(): string };
  clock?: { now(): Date };
}

export interface CreateConnectionInput {
  ownerId: string;
  pluginId: string;
  alias?: string;
  authScheme: IntegrationAuthScheme;
  credential: IntegrationCredentialValue;
  grant: Omit<ConnectionGrant, 'version' | 'grantId' | 'ownerId' | 'connectionId'>;
}

export interface CreateConnectionSetInput {
  ownerId: string;
  name: string;
  connections: string[];
  defaults?: { [key: string]: string };
}

export interface CreateSourceBindingInput {
  ownerId: string;
  sourceKind: SourceCapabilityBinding['sourceKind'];
  selector: SourceCapabilityBinding['selector'];
  capabilityProfile?: string;
  connectionSetId?: string;
}

export class CredentialVerificationError extends ValidationError {
  public constructor(pluginTitle: string) {
    super(`${pluginTitle} could not verify the supplied credential`);
    this.name = 'CredentialVerificationError';
  }
}

export class ConnectionService {
  private readonly ids: { random(): string };
  private readonly clock: { now(): Date };

  public constructor(private readonly options: ConnectionServiceOptions) {
    this.ids = options.ids ?? { random: () => randomUUID() };
    this.clock = options.clock ?? { now: () => new Date() };
    if (!/^[A-Za-z0-9/_+=.@-]{1,256}$/.test(options.credentialNamePrefix)) {
      throw new Error('credential name prefix is invalid');
    }
  }

  public async create(input: CreateConnectionInput): Promise<{
    connection: IntegrationConnection;
    grant: ConnectionGrant;
  }> {
    requiredOwner(input.ownerId);
    if (input.alias) safeAlias(input.alias);
    const plugin = installedPlugin(this.options.registry, input.pluginId);
    const authentication = plugin.manifest.authentication.find(
      (candidate) => candidate.scheme === input.authScheme,
    );
    if (!authentication) {
      throw new ValidationError(`plugin ${input.pluginId} does not support ${input.authScheme}`);
    }
    validateCredentialFields(input.credential, authentication.fields);
    const verified = await verifyCredential(plugin, input.authScheme, input.credential);
    if (verified.authorization.scheme !== input.authScheme) {
      throw new Error(`plugin ${input.pluginId} verified the wrong authentication scheme`);
    }
    const alias = input.alias
      ? await this.requestedAlias(input.ownerId, input.alias)
      : await this.availableAlias(input.ownerId, defaultAlias(input.pluginId, verified.label));
    const connectionId = this.ids.random();
    const timestamp = this.clock.now().toISOString();
    const connection = newConnection({
      connectionId,
      ownerId: input.ownerId,
      pluginId: input.pluginId,
      alias,
    }, verified, timestamp);
    const grant = connectionGrant({
      grantId: this.ids.random(),
      ownerId: input.ownerId,
      connectionId,
    }, input.grant);
    validateGrantOperations(plugin.manifest, grant);
    const secretName = connectionCredentialName(this.options.credentialNamePrefix, input.ownerId, connectionId);
    const reference = await this.options.vault.create(secretName, input.credential);
    try {
      await this.options.store.putConnectionBundle(
        connection,
        {
          version: '1',
          ownerId: input.ownerId,
          connectionId,
          reference,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        grant,
      );
    } catch (error) {
      try {
        await this.options.vault.revoke(reference);
      } catch {
        emitMetric('connection-service', 'CleanupFailure', 1, 'Count');
      }
      throw error;
    }
    return { connection, grant };
  }

  public async list(ownerId: string): Promise<Array<{
    connection: IntegrationConnection;
    grant?: ConnectionGrant;
    health: ConnectionHealth;
  }>> {
    requiredOwner(ownerId);
    const connections = await this.options.store.listConnections(ownerId);
    return Promise.all(connections.map(async (connection) => {
      const [grant, health] = await Promise.all([
        this.options.store.getGrant(ownerId, connection.connectionId),
        this.connectionHealth(ownerId, connection.connectionId),
      ]);
      return { connection, ...(grant ? { grant } : {}), health };
    }));
  }

  public async get(ownerId: string, connectionIdOrAlias: string): Promise<{
    connection: IntegrationConnection;
    grant?: ConnectionGrant;
    health: ConnectionHealth;
  }> {
    const connection = await this.requiredConnection(ownerId, connectionIdOrAlias);
    const [grant, health] = await Promise.all([
      this.options.store.getGrant(ownerId, connection.connectionId),
      this.connectionHealth(ownerId, connection.connectionId),
    ]);
    return { connection, ...(grant ? { grant } : {}), health };
  }

  public async rename(
    ownerId: string,
    connectionIdOrAlias: string,
    displayName: string,
  ): Promise<IntegrationConnection> {
    const connection = await this.requiredConnection(ownerId, connectionIdOrAlias);
    const name = connectionDisplayName(displayName);
    const updated = validateIntegrationConnection({
      ...connection,
      displayName: name,
      updatedAt: this.clock.now().toISOString(),
    });
    await this.options.store.putConnection(updated);
    return updated;
  }

  public async test(
    ownerId: string,
    connectionIdOrAlias: string,
  ): Promise<{ connection: IntegrationConnection; health: ConnectionHealth }> {
    const connection = await this.requiredConnection(ownerId, connectionIdOrAlias);
    if (connection.status === 'revoked') {
      throw new ValidationError('revoked connections cannot be tested');
    }
    const binding = await this.options.store.getCredentialBinding(ownerId, connection.connectionId);
    if (!binding || binding.ownerId !== ownerId) {
      const expired = await this.updateStatus(connection, 'expired');
      const health = await this.recordHealth(expired, 'reauth-required', 'credential-missing');
      return { connection: expired, health };
    }
    if (!this.options.credentials) throw new Error('connection testing is not configured');
    const plugin = this.options.registry.plugin(connection.pluginId);
    try {
      const credential = await this.options.credentials.readRecord(binding.reference, connection);
      const verified = await verifyCredential(plugin, connection.authorization.scheme, credential);
      if (!sameProviderIdentity(connection, verified)) {
        const expired = await this.updateStatus(connection, 'expired');
        const health = await this.recordHealth(expired, 'reauth-required', 'identity-mismatch');
        return { connection: expired, health };
      }
      const active = refreshedConnection(connection, verified, this.clock.now().toISOString());
      await this.options.store.putConnection(active);
      const health = await this.recordHealth(active, 'healthy', 'verified');
      return { connection: active, health };
    } catch (error) {
      if (error instanceof IntegrationProviderUnavailableError) {
        const health = await this.recordHealth(connection, 'degraded', 'provider-unavailable');
        return { connection, health };
      }
      if (error instanceof CredentialVerificationError || error instanceof ValidationError) {
        const expired = await this.updateStatus(connection, 'expired');
        const health = await this.recordHealth(expired, 'reauth-required', 'credential-rejected');
        return { connection: expired, health };
      }
      throw error;
    }
  }

  public async replaceGrant(
    ownerId: string,
    connectionIdOrAlias: string,
    policy: Omit<ConnectionGrant, 'version' | 'grantId' | 'ownerId' | 'connectionId'>,
  ): Promise<ConnectionGrant> {
    const connection = await this.requiredConnection(ownerId, connectionIdOrAlias);
    const current = await this.options.store.getGrant(ownerId, connection.connectionId);
    const grant = connectionGrant({
      grantId: current?.grantId ?? this.ids.random(),
      ownerId,
      connectionId: connection.connectionId,
    }, policy);
    validateGrantOperations(this.options.registry.plugin(connection.pluginId).manifest, grant);
    await this.options.store.putGrant(grant);
    return grant;
  }

  public async rotate(
    ownerId: string,
    connectionIdOrAlias: string,
    credential: IntegrationCredentialValue,
  ): Promise<{ connection: IntegrationConnection; health: ConnectionHealth }> {
    const connection = await this.requiredConnection(ownerId, connectionIdOrAlias);
    if (connection.status === 'revoked') {
      throw new ValidationError('revoked connections cannot be rotated');
    }
    const plugin = this.options.registry.plugin(connection.pluginId);
    const authentication = plugin.manifest.authentication.find(
      (candidate) => candidate.scheme === connection.authorization.scheme,
    );
    if (!authentication) throw new Error('connection authentication scheme is no longer installed');
    validateCredentialFields(credential, authentication.fields);
    const verified = await verifyCredential(plugin, connection.authorization.scheme, credential);
    if (!sameProviderIdentity(connection, verified)) {
      throw new ValidationError('rotated credential belongs to a different provider account');
    }
    const binding = await this.options.store.getCredentialBinding(ownerId, connection.connectionId);
    if (!binding || binding.ownerId !== ownerId) throw new Error('connection credential is missing');
    await this.options.vault.replace(binding.reference, credential);
    const timestamp = this.clock.now().toISOString();
    await this.options.store.putCredentialBinding({
      ...binding,
      updatedAt: timestamp,
    });
    const active = refreshedConnection(connection, verified, timestamp);
    await this.options.store.putConnection(active);
    const health = await this.recordHealth(active, 'healthy', 'verified');
    return { connection: active, health };
  }

  public async revoke(ownerId: string, connectionIdOrAlias: string): Promise<IntegrationConnection> {
    const connection = await this.requiredConnection(ownerId, connectionIdOrAlias);
    const revoked = connectionWithStatus(connection, 'revoked', this.clock.now().toISOString());
    await this.options.store.putConnection(revoked);
    const binding = await this.options.store.getCredentialBinding(ownerId, connection.connectionId);
    if (binding) await this.options.vault.revoke(binding.reference);
    return revoked;
  }

  public async createSet(input: CreateConnectionSetInput): Promise<ConnectionSet> {
    requiredOwner(input.ownerId);
    const connectionIds: string[] = [];
    for (const selector of input.connections) {
      const connection = await this.requiredConnection(input.ownerId, selector);
      if (!connectionIds.includes(connection.connectionId)) connectionIds.push(connection.connectionId);
    }
    const defaults: Record<string, string> = {};
    for (const [capability, selector] of Object.entries(input.defaults ?? {})) {
      const connection = await this.requiredConnection(input.ownerId, selector);
      defaults[capability] = connection.connectionId;
    }
    const connectionSet = validateConnectionSet({
      version: '1',
      connectionSetId: this.ids.random(),
      ownerId: input.ownerId,
      name: input.name,
      connectionIds,
      ...(Object.keys(defaults).length > 0 ? { defaults } : {}),
    });
    await this.options.store.putConnectionSet(connectionSet);
    return connectionSet;
  }

  public listSets(ownerId: string): Promise<ConnectionSet[]> {
    requiredOwner(ownerId);
    return this.options.store.listConnectionSets(ownerId);
  }

  public async createSourceBinding(input: CreateSourceBindingInput): Promise<SourceCapabilityBinding> {
    requiredOwner(input.ownerId);
    if (input.connectionSetId) {
      const set = await this.options.store.getConnectionSet(input.ownerId, input.connectionSetId);
      if (!set) throw new Error(`connection set ${input.connectionSetId} was not found`);
    }
    const binding = validateSourceCapabilityBinding({
      version: '1',
      bindingId: this.ids.random(),
      ownerId: input.ownerId,
      sourceKind: input.sourceKind,
      selector: input.selector,
      ...(input.capabilityProfile ? { capabilityProfile: input.capabilityProfile } : {}),
      ...(input.connectionSetId ? { connectionSetId: input.connectionSetId } : {}),
    });
    await this.options.store.putSourceBinding(binding);
    return binding;
  }

  public listSourceBindings(ownerId: string): Promise<SourceCapabilityBinding[]> {
    requiredOwner(ownerId);
    return this.options.store.listSourceBindings(ownerId);
  }

  private async requiredConnection(
    ownerId: string,
    connectionIdOrAlias: string,
  ): Promise<IntegrationConnection> {
    requiredOwner(ownerId);
    const connection = await this.options.store.getConnection(ownerId, connectionIdOrAlias);
    if (!connection || connection.ownerId !== ownerId) throw new Error('integration connection not found');
    return connection;
  }

  private async connectionHealth(ownerId: string, connectionId: string): Promise<ConnectionHealth> {
    return await this.options.store.getConnectionHealth?.(ownerId, connectionId) ??
      untestedConnectionHealth(ownerId, connectionId);
  }

  private async recordHealth(
    connection: IntegrationConnection,
    status: ConnectionHealth['status'],
    code: ConnectionHealth['code'],
  ): Promise<ConnectionHealth> {
    const previous = await this.connectionHealth(connection.ownerId, connection.connectionId);
    const now = this.clock.now().toISOString();
    const health = connectionHealthObservation(connection, previous, status, code, now);
    await this.options.store.putConnectionHealth?.(health);
    return health;
  }

  private async updateStatus(
    connection: IntegrationConnection,
    status: IntegrationConnection['status'],
  ): Promise<IntegrationConnection> {
    if (connection.status === status) return connection;
    const updated = connectionWithStatus(connection, status, this.clock.now().toISOString());
    await this.options.store.putConnection(updated);
    return updated;
  }

  private async requestedAlias(ownerId: string, alias: string): Promise<string> {
    const existing = await this.options.store.getConnection(ownerId, alias);
    if (existing) throw new ValidationError(`connection alias ${alias} already exists`);
    return alias;
  }

  private async availableAlias(ownerId: string, base: string): Promise<string> {
    for (let suffix = 1; suffix <= 1_000; suffix += 1) {
      const candidate = aliasCandidate(base, suffix);
      if (!await this.options.store.getConnection(ownerId, candidate)) return candidate;
    }
    throw new Error(`could not allocate a connection alias for ${base}`);
  }
}

async function verifyCredential(
  plugin: ReturnType<IntegrationPluginRegistryLike['plugin']>,
  scheme: IntegrationAuthScheme,
  credential: IntegrationCredentialValue,
): Promise<VerifiedIntegrationCredential> {
  try {
    return await plugin.verifyCredential(scheme, credential);
  } catch (error) {
    if (error instanceof IntegrationProviderUnavailableError) throw error;
    throw new CredentialVerificationError(plugin.manifest.title);
  }
}

function installedPlugin(
  registry: IntegrationPluginRegistryLike,
  pluginId: string,
): ReturnType<IntegrationPluginRegistryLike['plugin']> {
  try {
    return registry.plugin(pluginId);
  } catch {
    throw new ValidationError(`integration plugin ${pluginId} is not installed`);
  }
}
