import type { CredentialBroker } from '../credentials/broker.js';
import type {
  IntegrationCredentialBinding,
  IntegrationCredentialValue,
} from '../credentials/types.js';
import type {
  ConnectionGrant,
  ConnectionSet,
  IntegrationAccessRequest,
  IntegrationAuthScheme,
  IntegrationConnection,
  OperationDefinition,
  ProviderAuthorization,
  SourceCapabilityBinding,
} from '../domain/capabilities.js';
import type { JsonValue } from '../domain/contracts.js';

export class IntegrationProviderUnavailableError extends Error {
  public constructor(pluginTitle: string) {
    super(`${pluginTitle} credential verification is temporarily unavailable`);
    this.name = 'IntegrationProviderUnavailableError';
  }
}

export interface IntegrationCredentialField {
  key: string;
  label: string;
  secret: boolean;
}

export interface IntegrationAuthenticationDefinition {
  scheme: IntegrationAuthScheme;
  title: string;
  fields: IntegrationCredentialField[];
}

export interface IntegrationPluginManifest {
  id: string;
  version: '1';
  title: string;
  description: string;
  authentication: IntegrationAuthenticationDefinition[];
  operations: OperationDefinition[];
}

export interface VerifiedIntegrationCredential {
  label: string;
  authorization: ProviderAuthorization;
  externalTenantId?: string;
  externalSubjectId?: string;
}

export interface IntegrationOperationContext {
  connection: IntegrationConnection;
  credential: IntegrationCredentialValue;
  signal?: AbortSignal;
}

export interface IntegrationPlugin {
  manifest: IntegrationPluginManifest;
  verifyCredential(
    scheme: IntegrationAuthScheme,
    credential: IntegrationCredentialValue,
    signal?: AbortSignal,
  ): Promise<VerifiedIntegrationCredential>;
  execute(
    operationId: string,
    input: { [key: string]: JsonValue },
    context: IntegrationOperationContext,
  ): Promise<JsonValue>;
}

export interface IntegrationStore {
  listConnections(ownerId: string): Promise<IntegrationConnection[]>;
  getConnection(ownerId: string, connectionIdOrAlias: string): Promise<IntegrationConnection | undefined>;
  putConnection(connection: IntegrationConnection): Promise<void>;
  putConnectionBundle(
    connection: IntegrationConnection,
    binding: IntegrationCredentialBinding,
    grant: ConnectionGrant,
  ): Promise<void>;
  putCredentialBinding(binding: IntegrationCredentialBinding): Promise<void>;
  getCredentialBinding(
    ownerId: string,
    connectionId: string,
  ): Promise<IntegrationCredentialBinding | undefined>;
  putGrant(grant: ConnectionGrant): Promise<void>;
  getGrant(ownerId: string, connectionId: string): Promise<ConnectionGrant | undefined>;
  putConnectionSet(connectionSet: ConnectionSet): Promise<void>;
  getConnectionSet(ownerId: string, idOrName: string): Promise<ConnectionSet | undefined>;
  listConnectionSets(ownerId: string): Promise<ConnectionSet[]>;
  putSourceBinding(binding: SourceCapabilityBinding): Promise<void>;
  listSourceBindings(ownerId: string): Promise<SourceCapabilityBinding[]>;
  matchingSourceBindings(sourceKind: SourceCapabilityBinding['sourceKind']): Promise<SourceCapabilityBinding[]>;
}

export interface DynamicIntegrationTool {
  type: 'namespace';
  name: string;
  description: string;
  tools: Array<{
    type: 'function';
    name: string;
    description: string;
    inputSchema: { [key: string]: JsonValue };
  }>;
}

export interface DynamicIntegrationToolCall {
  namespace: string | null;
  tool: string;
  arguments: JsonValue;
}

export interface IntegrationToolSession {
  tools: DynamicIntegrationTool[];
  call(call: DynamicIntegrationToolCall, signal?: AbortSignal): Promise<JsonValue>;
}

export interface IntegrationRuntimeOptions {
  registry: IntegrationPluginRegistryLike;
  store: IntegrationStore;
  credentials: CredentialBroker;
}

export interface IntegrationPluginRegistryLike {
  plugin(id: string): IntegrationPlugin;
  list(): IntegrationPlugin[];
}

export interface PrepareIntegrationToolsInput {
  ownerId: string;
  request: IntegrationAccessRequest;
  maximumIntegrationAccess?: 'read-only' | 'read-write' | 'full';
}
