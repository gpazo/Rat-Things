import {
  authorizeConnectionOperation,
  type ConnectionAccessRequest,
  type ConnectionGrant,
  type IntegrationConnection,
  type OperationAuthorizationDecision,
  type OperationDefinition,
} from '../domain/capabilities.js';
import type { JsonValue } from '../domain/contracts.js';
import type {
  DynamicIntegrationTool,
  DynamicIntegrationToolCall,
  IntegrationApprovalRequest,
  IntegrationPlugin,
  IntegrationRuntimeOptions,
  IntegrationToolSession,
  PrepareIntegrationToolsInput,
} from './integration-types.js';

const MAX_TOOL_RESULT_BYTES = 128 * 1024;

interface SelectedConnection {
  connection: IntegrationConnection;
  plugin: IntegrationPlugin;
  grants: ConnectionGrant[];
}

interface ResolvedTool {
  operation: OperationDefinition;
  connections: SelectedConnection[];
  defaultConnection?: SelectedConnection;
}

interface SelectedConnections {
  connections: SelectedConnection[];
  defaults: { [key: string]: string };
}

export class IntegrationRuntime {
  public constructor(private readonly options: IntegrationRuntimeOptions) {}

  public async prepare(input: PrepareIntegrationToolsInput): Promise<IntegrationToolSession> {
    const selection = await this.selectedConnections(input);
    const selected = selection.connections;
    const tools: DynamicIntegrationTool[] = [];
    const resolved = new Map<string, ResolvedTool>();
    const byPlugin = new Map<string, SelectedConnection[]>();
    for (const candidate of selected) {
      const pluginConnections = byPlugin.get(candidate.connection.pluginId) ?? [];
      pluginConnections.push(candidate);
      byPlugin.set(candidate.connection.pluginId, pluginConnections);
    }

    for (const [pluginId, connections] of byPlugin) {
      const plugin = this.options.registry.plugin(pluginId);
      const namespaceTools: DynamicIntegrationTool['tools'] = [];
      const names = new Set<string>();
      for (const operation of plugin.manifest.operations) {
        const allowedConnections = connections.filter(
          (candidate) => operationDecision(candidate, operation).allowed,
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
      if (!plugin.manifest.authSchemes.includes(connection.authorization.scheme)) {
        throw new Error(`integration connection ${connection.alias} uses an unsupported auth scheme`);
      }
      const grant = await this.options.store.getGrant(input.ownerId, connection.connectionId);
      if (!grant || grant.ownerId !== input.ownerId || grant.connectionId !== connection.connectionId) {
        throw new Error(`integration connection ${connection.alias} has no permission grant`);
      }
      selected.push({
        connection,
        plugin,
        grants: [
          grant,
          ...(requested && hasRequestedPolicy(requested)
            ? [requestedGrant(input.ownerId, connection.connectionId, requested)]
            : []),
          ...(input.maximumIntegrationAccess
            ? [maximumGrant(
              input.ownerId,
              connection.connectionId,
              input.maximumIntegrationAccess,
            )]
            : []),
        ],
      });
    }
    const duplicateAlias = selected.find(
      (candidate, index) => selected.findIndex(
        (other) => other.connection.alias === candidate.connection.alias,
      ) !== index,
    );
    if (duplicateAlias) throw new Error(`duplicate connection alias ${duplicateAlias.connection.alias}`);
    return { connections: selected, defaults };
  }

  private async call(
    input: PrepareIntegrationToolsInput,
    tools: Map<string, ResolvedTool>,
    call: DynamicIntegrationToolCall,
    signal?: AbortSignal,
  ): Promise<JsonValue> {
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
    const operationInput = recordValue(argumentsValue.input ?? {}, 'integration operation input');
    const decision = operationDecision(selected, resolved.operation);
    if (!decision.allowed) throw new Error(decision.reason ?? 'integration operation is not authorized');
    enforceResourceConstraints(selected.grants, operationInput);
    if (decision.requiresApproval) {
      const approval: IntegrationApprovalRequest = {
        connectionId: selected.connection.connectionId,
        connectionAlias: selected.connection.alias,
        pluginId: selected.connection.pluginId,
        operation: resolved.operation,
        approval: decision.approval,
        input: operationInput,
      };
      if (!input.approve || !(await input.approve(approval))) {
        throw new Error('integration operation was not approved');
      }
    }
    const binding = await this.options.store.getCredentialBinding(
      input.ownerId,
      selected.connection.connectionId,
    );
    if (!binding || binding.ownerId !== input.ownerId) {
      throw new Error(`credential for ${selected.connection.alias} is not configured`);
    }
    const credential = await this.options.credentials.readRecord(binding.reference);
    const result = await selected.plugin.execute(resolved.operation.id, operationInput, {
      connection: selected.connection,
      credential,
      ...(signal ? { signal } : {}),
    });
    assertBoundedJson(result, 'integration tool result');
    return result;
  }
}

function enforceResourceConstraints(
  grants: ConnectionGrant[],
  input: { [key: string]: JsonValue },
): void {
  for (const grant of grants) {
    for (const [field, allowed] of Object.entries(grant.resourceConstraints ?? {})) {
      const actual = input[field];
      const selected = typeof actual === 'string'
        ? [actual]
        : Array.isArray(actual) && actual.every((value) => typeof value === 'string')
          ? actual as string[]
          : undefined;
      if (!selected || selected.some((value) => !allowed.includes(value))) {
        throw new Error(`integration input ${field} is outside the connection resource grant`);
      }
    }
  }
}

function operationDecision(
  selected: SelectedConnection,
  operation: OperationDefinition,
): OperationAuthorizationDecision {
  const decisions = selected.grants.map((grant) => authorizeConnectionOperation({
    connection: selected.connection,
    grant,
    operation,
  }));
  const denied = decisions.find((decision) => !decision.allowed);
  if (denied) return denied;
  const approval = decisions.some((decision) => decision.approval === 'always')
    ? 'always'
    : decisions.some((decision) => decision.approval === 'on-request')
      ? 'on-request'
      : 'never';
  return {
    allowed: true,
    requiresApproval: approval !== 'never',
    approval,
    enforcement: decisions.some((decision) => decision.enforcement === 'provider-and-broker')
      ? 'provider-and-broker'
      : 'broker',
  };
}

function maximumGrant(
  ownerId: string,
  connectionId: string,
  preset: 'read-only' | 'read-write' | 'full',
): ConnectionGrant {
  return {
    version: '1',
    grantId: `profile:${connectionId}`,
    ownerId,
    connectionId,
    preset,
  };
}

function requestedGrant(
  ownerId: string,
  connectionId: string,
  requested: ConnectionAccessRequest,
): ConnectionGrant {
  return {
    version: '1',
    grantId: `request:${connectionId}`,
    ownerId,
    connectionId,
    preset: requested.preset ?? 'full',
    ...(requested.allowOperations ? { allowOperations: requested.allowOperations } : {}),
    ...(requested.denyOperations ? { denyOperations: requested.denyOperations } : {}),
  };
}

function hasRequestedPolicy(request: ConnectionAccessRequest): boolean {
  return request.preset !== undefined ||
    request.allowOperations !== undefined ||
    request.denyOperations !== undefined;
}

function toolInputSchema(
  operation: OperationDefinition,
  connections: SelectedConnection[],
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

function defaultConnectionFor(
  operation: OperationDefinition,
  connections: SelectedConnection[],
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

function toolName(operationId: string, pluginId: string): string {
  return operationId.slice(pluginId.length + 1).replace(/[.-]/g, '_');
}

function recordValue(value: JsonValue, label: string): { [key: string]: JsonValue } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function stringValue(value: JsonValue | undefined, label: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${label} is required`);
  return value;
}

function assertBoundedJson(value: JsonValue, label: string): void {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error(`${label} is not JSON`);
  }
  if (Buffer.byteLength(encoded) > MAX_TOOL_RESULT_BYTES) {
    throw new Error(`${label} exceeds ${MAX_TOOL_RESULT_BYTES} bytes`);
  }
}
