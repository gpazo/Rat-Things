import { createHash, randomUUID } from 'node:crypto';
import type {
  CredentialVault,
  IntegrationCredentialValue,
} from '../credentials/types.js';
import {
  validateConnectionGrant,
  validateConnectionSet,
  validateIntegrationConnection,
  validateSourceCapabilityBinding,
  type ConnectionGrant,
  type ConnectionSet,
  type IntegrationConnection,
  type ProviderAuthorization,
  type SourceCapabilityBinding,
} from '../domain/capabilities.js';
import type {
  IntegrationPluginRegistryLike,
  IntegrationStore,
} from './integration-types.js';

export interface ConnectionServiceOptions {
  store: IntegrationStore;
  vault: CredentialVault;
  registry: IntegrationPluginRegistryLike;
  credentialNamePrefix: string;
  ids?: { random(): string };
  clock?: { now(): Date };
}

export interface CreateConnectionInput {
  ownerId: string;
  pluginId: string;
  alias: string;
  authorization: ProviderAuthorization;
  credential: IntegrationCredentialValue;
  externalTenantId?: string;
  externalSubjectId?: string;
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
    safeAlias(input.alias);
    const plugin = this.options.registry.plugin(input.pluginId);
    if (!plugin.manifest.authSchemes.includes(input.authorization.scheme)) {
      throw new Error(`plugin ${input.pluginId} does not support ${input.authorization.scheme}`);
    }
    const existing = await this.options.store.getConnection(input.ownerId, input.alias);
    if (existing) throw new Error(`connection alias ${input.alias} already exists`);
    const connectionId = this.ids.random();
    const timestamp = this.clock.now().toISOString();
    const connection = validateIntegrationConnection({
      version: '1',
      connectionId,
      ownerId: input.ownerId,
      pluginId: input.pluginId,
      alias: input.alias,
      ...(input.externalTenantId ? { externalTenantId: input.externalTenantId } : {}),
      ...(input.externalSubjectId ? { externalSubjectId: input.externalSubjectId } : {}),
      authorization: input.authorization,
      status: 'active',
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const grant = validateConnectionGrant({
      version: '1',
      grantId: this.ids.random(),
      ownerId: input.ownerId,
      connectionId,
      ...input.grant,
    });
    validateGrantOperations(plugin, grant);
    const secretName = [
      this.options.credentialNamePrefix.replace(/\/$/, ''),
      createHash('sha256').update(input.ownerId).digest('hex').slice(0, 32),
      connectionId,
    ].join('/');
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
      await this.options.vault.revoke(reference).catch(() => undefined);
      throw error;
    }
    return { connection, grant };
  }

  public async list(ownerId: string): Promise<Array<{
    connection: IntegrationConnection;
    grant?: ConnectionGrant;
  }>> {
    requiredOwner(ownerId);
    const connections = await this.options.store.listConnections(ownerId);
    return Promise.all(connections.map(async (connection) => {
      const grant = await this.options.store.getGrant(ownerId, connection.connectionId);
      return { connection, ...(grant ? { grant } : {}) };
    }));
  }

  public async replaceGrant(
    ownerId: string,
    connectionIdOrAlias: string,
    policy: Omit<ConnectionGrant, 'version' | 'grantId' | 'ownerId' | 'connectionId'>,
  ): Promise<ConnectionGrant> {
    const connection = await this.requiredConnection(ownerId, connectionIdOrAlias);
    const current = await this.options.store.getGrant(ownerId, connection.connectionId);
    const grant = validateConnectionGrant({
      version: '1',
      grantId: current?.grantId ?? this.ids.random(),
      ownerId,
      connectionId: connection.connectionId,
      ...policy,
    });
    validateGrantOperations(this.options.registry.plugin(connection.pluginId), grant);
    await this.options.store.putGrant(grant);
    return grant;
  }

  public async rotate(
    ownerId: string,
    connectionIdOrAlias: string,
    credential: IntegrationCredentialValue,
  ): Promise<void> {
    const connection = await this.requiredConnection(ownerId, connectionIdOrAlias);
    if (connection.status === 'revoked') throw new Error('revoked connections cannot be rotated');
    const binding = await this.options.store.getCredentialBinding(ownerId, connection.connectionId);
    if (!binding || binding.ownerId !== ownerId) throw new Error('connection credential is missing');
    await this.options.vault.replace(binding.reference, credential);
    await this.options.store.putCredentialBinding({
      ...binding,
      updatedAt: this.clock.now().toISOString(),
    });
  }

  public async revoke(ownerId: string, connectionIdOrAlias: string): Promise<IntegrationConnection> {
    const connection = await this.requiredConnection(ownerId, connectionIdOrAlias);
    const revoked = validateIntegrationConnection({
      ...connection,
      status: 'revoked',
      updatedAt: this.clock.now().toISOString(),
    });
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
}

function requiredOwner(value: string): void {
  if (typeof value !== 'string' || !value || value.length > 1_024) throw new Error('owner ID is invalid');
}

function safeAlias(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(value)) {
    throw new Error('connection alias must be 1-128 safe ASCII characters');
  }
}

function validateGrantOperations(
  plugin: ReturnType<IntegrationPluginRegistryLike['plugin']>,
  grant: ConnectionGrant,
): void {
  const installed = new Set(plugin.manifest.operations.map((operation) => operation.id));
  for (const operationId of [
    ...(grant.allowOperations ?? []),
    ...(grant.denyOperations ?? []),
    ...(grant.approvalOverrides ?? []).map((override) => override.operationId),
  ]) {
    if (!installed.has(operationId)) {
      throw new Error(`operation ${operationId} is not installed by plugin ${plugin.manifest.id}`);
    }
  }
}
