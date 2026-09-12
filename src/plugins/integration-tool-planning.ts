import type { ConnectionAccessRequest, ConnectionGrant, IntegrationConnection, OperationDefinition } from '../domain/capabilities.js';
import type { JsonValue } from '../domain/contracts.js';
import type { DynamicIntegrationToolCall, IntegrationPlugin, PrepareIntegrationToolsInput } from './integration-types.js';
import { operationInputValue, recordValue, stringValue } from './integration-tool-validation.js';

export interface SelectedConnection {
  connection: IntegrationConnection;
  plugin: IntegrationPlugin;
  grant: ConnectionGrant;
  requested?: ConnectionAccessRequest;
  maximumIntegrationAccess?: NonNullable<PrepareIntegrationToolsInput['maximumIntegrationAccess']>;
}

export interface ResolvedTool {
  operation: OperationDefinition;
  connections: readonly SelectedConnection[];
  defaultConnection?: SelectedConnection;
}

/** Group into fresh arrays while retaining first appearance and account selection order. */
export function connectionsByPlugin(selected: readonly SelectedConnection[]): Map<string, SelectedConnection[]> {
  const byPlugin = new Map<string, SelectedConnection[]>();
  for (const candidate of selected) {
    const pluginConnections = byPlugin.get(candidate.connection.pluginId) ?? [];
    pluginConnections.push(candidate);
    byPlugin.set(candidate.connection.pluginId, pluginConnections);
  }
  return byPlugin;
}

export function assertUniqueConnectionAliases(selected: readonly SelectedConnection[]): void {
  const duplicateAlias = selected.find(
    (candidate, index) => selected.findIndex(
      (other) => other.connection.alias === candidate.connection.alias,
    ) !== index,
  );
  if (duplicateAlias) throw new Error(`duplicate connection alias ${duplicateAlias.connection.alias}`);
}

export interface ResolvedIntegrationCall {
  selected: SelectedConnection;
  operation: OperationDefinition;
  operationInput: { [key: string]: JsonValue };
}

/** Resolve values only; authorization is checked by the runtime before any credential read. */
export function resolveToolCall(
  tools: ReadonlyMap<string, ResolvedTool>,
  call: DynamicIntegrationToolCall,
): ResolvedIntegrationCall {
  if (!call.namespace) throw new Error('integration tool namespace is required');
  const resolved = tools.get(`${call.namespace}:${call.tool}`);
  if (!resolved) throw new Error(`integration tool ${call.namespace}.${call.tool} is not available`);
  const argumentsValue = recordValue(call.arguments, 'integration tool arguments');
  const account = argumentsValue.account === undefined && resolved.defaultConnection
    ? resolved.defaultConnection.connection.alias
    : stringValue(argumentsValue.account, 'integration account');
  const selected = resolved.connections.find(
    (candidate) => candidate.connection.alias === account || candidate.connection.connectionId === account,
  );
  if (!selected) throw new Error(`account ${account} is not authorized for this operation`);
  const operationInput = operationInputValue(argumentsValue, resolved.operation);
  return { selected, operation: resolved.operation, operationInput };
}

export function toolInputSchema(
  operation: OperationDefinition,
  connections: readonly SelectedConnection[],
  defaultConnection?: SelectedConnection,
): { [key: string]: JsonValue } {
  const defaultAlias = defaultConnection?.connection.alias;
  return {
    type: 'object',
    properties: {
      account: {
        type: 'string',
        description: defaultAlias
          ? `The connected account alias to use. Defaults to ${defaultAlias}.`
          : 'The connected account alias to use.',
        enum: connections.map((candidate) => candidate.connection.alias),
        ...(defaultAlias ? { default: defaultAlias } : {}),
      },
      input: operation.inputSchema ?? { type: 'object', additionalProperties: true },
    },
    required: defaultAlias ? ['input'] : ['account', 'input'],
    additionalProperties: false,
  };
}

export function defaultConnectionFor(
  operation: OperationDefinition,
  connections: readonly SelectedConnection[],
  defaults: { [key: string]: string },
): SelectedConnection | undefined {
  const pluginId = operation.id.split('.')[0] as string;
  for (const key of [operation.id, pluginId]) {
    const configured = defaults[key];
    if (configured) {
      return connections.find((candidate) => candidate.connection.connectionId === configured);
    }
  }
  const configuredForPlugin = connections.filter((candidate) => (
    Object.values(defaults).includes(candidate.connection.connectionId)
  ));
  if (configuredForPlugin.length === 1) return configuredForPlugin[0];
  return connections.length === 1 ? connections[0] : undefined;
}

export function toolName(operationId: string, pluginId: string): string {
  return operationId.slice(pluginId.length + 1).replace(/[.-]/g, '_');
}
