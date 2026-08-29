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
    const connection = validateIntegrationConnection({
      version: '1',
      connectionId,
      ownerId: input.ownerId,
      pluginId: input.pluginId,
      alias,
      label: verified.label,
      ...(verified.externalTenantId ? { externalTenantId: verified.externalTenantId } : {}),
      ...(verified.externalSubjectId ? { externalSubjectId: verified.externalSubjectId } : {}),
      authorization: verified.authorization,
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
    if (
      verified.authorization.scheme !== connection.authorization.scheme ||
      (connection.externalTenantId ?? '') !== (verified.externalTenantId ?? '') ||
      (connection.externalSubjectId ?? '') !== (verified.externalSubjectId ?? '')
    ) {
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
    await this.options.store.putConnection(validateIntegrationConnection({
      ...connection,
      label: verified.label,
      authorization: verified.authorization,
      updatedAt: timestamp,
    }));
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

  private async requestedAlias(ownerId: string, alias: string): Promise<string> {
    const existing = await this.options.store.getConnection(ownerId, alias);
    if (existing) throw new ValidationError(`connection alias ${alias} already exists`);
    return alias;
  }

  private async availableAlias(ownerId: string, base: string): Promise<string> {
    for (let suffix = 1; suffix <= 1_000; suffix += 1) {
      const ending = suffix === 1 ? '' : `-${suffix}`;
      const candidate = `${base.slice(0, 128 - ending.length)}${ending}`;
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

function requiredOwner(value: string): void {
  if (typeof value !== 'string' || !value || value.length > 1_024) throw new Error('owner ID is invalid');
}

function safeAlias(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(value)) {
    throw new ValidationError('connection alias must be 1-128 safe ASCII characters');
  }
}

function defaultAlias(pluginId: string, label: string): string {
  const account = label
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
  return `${pluginId}${account ? `-${account}` : ''}`.slice(0, 128);
}

function validateCredentialFields(
  credential: IntegrationCredentialValue,
  fields: Array<{ key: string; computed?: boolean; required?: boolean }>,
): void {
  const expected = new Set(fields.map((field) => field.key));
  for (const field of fields) {
    if (field.required !== false && !field.computed && !credential[field.key]) {
      throw new ValidationError(`integration credential requires ${field.key}`);
    }
  }
  for (const field of Object.keys(credential)) {
    if (!expected.has(field)) {
      throw new ValidationError(`integration credential field ${field} is not accepted`);
    }
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
  ]) {
    if (!installed.has(operationId)) {
      throw new ValidationError(`operation ${operationId} is not installed by plugin ${plugin.manifest.id}`);
    }
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
