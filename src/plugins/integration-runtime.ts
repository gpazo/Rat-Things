import {
  authorizeConnectionOperation,
  type ConnectionAccessRequest,
} from '../domain/capabilities.js';
import type { JsonValue } from '../domain/contracts.js';
import type {
  DynamicIntegrationTool,
  DynamicIntegrationToolCall,
  IntegrationRuntimeOptions,
  IntegrationToolSession,
  PrepareIntegrationToolsInput,
} from './integration-types.js';
import {
  assertUniqueConnectionAliases,
  connectionsByPlugin,
  defaultConnectionFor,
  resolveToolCall,
  toolInputSchema,
  toolName,
  type ResolvedTool,
  type SelectedConnection,
} from './integration-tool-planning.js';
import { assertBoundedJson, enforceResourceConstraints } from './integration-tool-validation.js';

interface SelectedConnections {
  connections: SelectedConnection[];
  defaults: { [key: string]: string };
}

export class IntegrationRuntime {
  public constructor(private readonly options: IntegrationRuntimeOptions) {}

  public async prepare(input: PrepareIntegrationToolsInput): Promise<IntegrationToolSession> {
    const selection = await this.selectedConnections(input);
    const tools: DynamicIntegrationTool[] = [];
    const resolved = new Map<string, ResolvedTool>();
    const byPlugin = connectionsByPlugin(selection.connections);

    for (const [pluginId, connections] of byPlugin) {
      const plugin = this.options.registry.plugin(pluginId);
      const namespaceTools: DynamicIntegrationTool['tools'] = [];
      const names = new Set<string>();
      for (const operation of plugin.manifest.operations) {
        const allowedConnections = connections.filter(
          (candidate) => authorizeConnectionOperation({ ...candidate, operation }).allowed,
        );
        if (allowedConnections.length === 0) continue;
        const defaultConnection = defaultConnectionFor(
          operation,
          allowedConnections,
          selection.defaults,
        );
        const name = toolName(operation.id, pluginId);
        if (names.has(name)) throw new Error(`integration tool name collision ${pluginId}.${name}`);
        names.add(name);
        namespaceTools.push({
          type: 'function',
          name,
          description: `${operation.title}. Account access: ${operation.access}; risk: ${operation.risk}.`,
          inputSchema: toolInputSchema(operation, allowedConnections, defaultConnection),
        });
        resolved.set(`${pluginId}:${name}`, {
          operation,
          connections: allowedConnections,
          ...(defaultConnection ? { defaultConnection } : {}),
        });
      }
      if (namespaceTools.length > 0) {
        tools.push({
          type: 'namespace',
          name: pluginId,
          description: plugin.manifest.description,
          tools: namespaceTools,
        });
      }
    }

    return {
      tools,
      call: (call, signal) => this.call(input, resolved, call, signal),
    };
  }

  private async selectedConnections(
    input: PrepareIntegrationToolsInput,
  ): Promise<SelectedConnections> {
    const selectors = new Map<string, ConnectionAccessRequest | undefined>();
    let defaults: { [key: string]: string } = {};
    if (input.request.connectionSet) {
      const set = await this.options.store.getConnectionSet(input.ownerId, input.request.connectionSet);
      if (!set || set.ownerId !== input.ownerId) {
        throw new Error(`connection set ${input.request.connectionSet} was not found`);
      }
      for (const connectionId of set.connectionIds) selectors.set(connectionId, undefined);
      defaults = { ...set.defaults };
    }
    for (const requested of input.request.connections ?? []) {
      const connection = await this.options.store.getConnection(input.ownerId, requested.connection);
      if (!connection || connection.ownerId !== input.ownerId) {
        throw new Error(`integration connection ${requested.connection} was not found`);
      }
      selectors.set(connection.connectionId, requested);
    }

    const selected: SelectedConnection[] = [];
    for (const [connectionId, requested] of selectors) {
      const connection = await this.options.store.getConnection(input.ownerId, connectionId);
      if (!connection || connection.ownerId !== input.ownerId) {
        throw new Error(`integration connection ${connectionId} was not found`);
      }
      if (connection.status !== 'active') {
        throw new Error(`integration connection ${connection.alias} is ${connection.status}`);
      }
      const plugin = this.options.registry.plugin(connection.pluginId);
      if (!plugin.manifest.authentication.some(
        (authentication) => authentication.scheme === connection.authorization.scheme,
      )) {
        throw new Error(`integration connection ${connection.alias} uses an unsupported auth scheme`);
      }
      const grant = await this.options.store.getGrant(input.ownerId, connection.connectionId);
      if (!grant || grant.ownerId !== input.ownerId || grant.connectionId !== connection.connectionId) {
        throw new Error(`integration connection ${connection.alias} has no permission grant`);
      }
      selected.push({
        connection,
        plugin,
        grant,
        ...(requested ? { requested: { ...requested } } : {}),
        ...(input.maximumIntegrationAccess ? { maximumIntegrationAccess: input.maximumIntegrationAccess } : {}),
      });
    }
    assertUniqueConnectionAliases(selected);
    return { connections: selected, defaults };
  }

  private async call(
    input: PrepareIntegrationToolsInput,
    tools: Map<string, ResolvedTool>,
    call: DynamicIntegrationToolCall,
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    const { selected, operation, operationInput } = resolveToolCall(tools, call);
    const decision = authorizeConnectionOperation({ ...selected, operation });
    if (!decision.allowed) throw new Error(decision.reason ?? 'integration operation is not authorized');
    enforceResourceConstraints(selected.grant, operationInput);
    const binding = await this.options.store.getCredentialBinding(
      input.ownerId,
      selected.connection.connectionId,
    );
    if (!binding || binding.ownerId !== input.ownerId) {
      throw new Error(`credential for ${selected.connection.alias} is not configured`);
    }
    const credential = await this.options.credentials.readRecord(
      binding.reference,
      selected.connection,
      signal,
    );
    const result = await selected.plugin.execute(operation.id, operationInput, {
      connection: selected.connection,
      credential,
      ...(signal ? { signal } : {}),
    });
    assertBoundedJson(result, 'integration tool result');
    return result;
  }
}
