import {
  authorizeConnectionOperation,
  type ConnectionAccessRequest,
  type ConnectionGrant,
  type IntegrationConnection,
  type OperationAuthorizationDecision,
  type OperationDefinition,
} from '../domain/capabilities.js';
import type {
  ResolvedThingConnection,
  ResolvedThingOperation,
  ThingDiagnostic,
  ThingExplanation,
} from '../domain/things.js';
import {
  resolveAgentProfile,
  type CapabilityProfileRegistry,
} from '../plugins/capability-profiles.js';
import type { ConnectionService } from '../plugins/connection-service.js';
import type { IntegrationPluginRegistry } from '../plugins/integration-registry.js';

export interface ThingExplanationEnvironment {
  profiles: CapabilityProfileRegistry;
  connections: Pick<ConnectionService, 'list' | 'listSets'>;
  plugins: IntegrationPluginRegistry;
}

/**
 * Resolves deployment-owned profiles, connections, grants, and plugin
 * operations without ever reading credential values.
 */
export async function explainThingEnvironment(
  ownerId: string,
  explanation: ThingExplanation,
  environment: ThingExplanationEnvironment,
): Promise<ThingExplanation> {
  const diagnostics = [...explanation.diagnostics];
  const selectedSpec = explanation.target === 'draft'
    ? explanation.thing.draft.spec
    : explanation.thing.active?.spec;
  if (!selectedSpec) throw new Error('Thing explanation target is unavailable');
  let effectiveRun = explanation.compiledRun;
  let maximumAccess: 'read-only' | 'read-write' | 'full' | undefined;
  try {
    const resolved = resolveAgentProfile(selectedSpec.agent, environment.profiles);
    maximumAccess = resolved.maximumIntegrationAccess;
    effectiveRun = {
      ...explanation.compiledRun,
      ...(resolved.agent ? { agent: resolved.agent } : {}),
    };
    diagnostics.push({
      id: 'profile',
      status: 'pass',
      message: selectedSpec.agent?.capabilities?.profile
        ? `Capability profile ${selectedSpec.agent.capabilities.profile} is installed and resolved.`
        : 'The Thing uses deployment defaults because it selects no capability profile.',
    });
  } catch (error) {
    diagnostics.push({
      id: 'profile',
      status: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const resolvedConnections: ResolvedThingConnection[] = [];
  const requestedConnections = selectedSpec.connections;
  if (requestedConnections) {
    const [bundles, sets] = await Promise.all([
      environment.connections.list(ownerId),
      environment.connections.listSets(ownerId),
    ]);
    const selected = new Map<string, {
      bundle: (typeof bundles)[number];
      selectedBy: Set<'connection-set' | 'account'>;
      requested?: ConnectionAccessRequest;
      defaultFor: Set<string>;
    }>();

    if (requestedConnections.set) {
      const set = sets.find((candidate) => (
        candidate.connectionSetId === requestedConnections.set ||
        candidate.name === requestedConnections.set
      ));
      if (!set) {
        diagnostics.push({
          id: 'connection-set',
          status: 'error',
          message: `Connection set ${requestedConnections.set} was not found for this owner.`,
        });
      } else {
        diagnostics.push({
          id: 'connection-set',
          status: 'pass',
          message: `Connection set ${set.name} resolves to ${set.connectionIds.length} account${set.connectionIds.length === 1 ? '' : 's'}.`,
        });
        for (const connectionId of set.connectionIds) {
          const bundle = bundles.find((candidate) => candidate.connection.connectionId === connectionId);
          if (!bundle) {
            diagnostics.push({
              id: `connection.${connectionId}`,
              status: 'error',
              message: `Connection set ${set.name} contains missing connection ${connectionId}.`,
            });
            continue;
          }
          selected.set(connectionId, {
            bundle,
            selectedBy: new Set(['connection-set']),
            defaultFor: new Set(Object.entries(set.defaults ?? {})
              .filter(([, value]) => value === connectionId)
              .map(([key]) => key)),
          });
        }
      }
    }

    for (const requested of requestedConnections.accounts ?? []) {
      const bundle = bundles.find((candidate) => (
        candidate.connection.connectionId === requested.account ||
        candidate.connection.alias === requested.account
      ));
      if (!bundle) {
        diagnostics.push({
          id: `connection.${requested.account}`,
          status: 'error',
          message: `Integration account ${requested.account} was not found for this owner.`,
        });
        continue;
      }
      const current = selected.get(bundle.connection.connectionId);
      selected.set(bundle.connection.connectionId, {
        bundle,
        selectedBy: new Set([...(current?.selectedBy ?? []), 'account']),
        requested: {
          connection: requested.account,
          ...(requested.access ? { preset: requested.access } : {}),
          ...(requested.allowOperations ? { allowOperations: requested.allowOperations } : {}),
          ...(requested.denyOperations ? { denyOperations: requested.denyOperations } : {}),
        },
        defaultFor: current?.defaultFor ?? new Set(),
      });
    }

    for (const candidate of selected.values()) {
      const resolved = resolveConnection(candidate, maximumAccess, environment.plugins, diagnostics);
      if (resolved) resolvedConnections.push(resolved);
    }
  }

  const environmentErrors = diagnostics.some((diagnostic) => diagnostic.status === 'error');
  return {
    ...explanation,
    effectiveRun,
    ...(resolvedConnections.length > 0 ? { resolvedConnections } : {}),
    runnable: explanation.runnable && !environmentErrors,
    diagnostics,
  };
}

function resolveConnection(
  selected: {
    bundle: Awaited<ReturnType<ConnectionService['list']>>[number];
    selectedBy: Set<'connection-set' | 'account'>;
    requested?: ConnectionAccessRequest;
    defaultFor: Set<string>;
  },
  maximumAccess: 'read-only' | 'read-write' | 'full' | undefined,
  plugins: IntegrationPluginRegistry,
  diagnostics: ThingDiagnostic[],
): ResolvedThingConnection | undefined {
  const { connection } = selected.bundle;
  if (connection.status !== 'active') {
    diagnostics.push({
      id: `connection.${connection.alias}`,
      status: 'error',
      message: `Integration account ${connection.alias} is ${connection.status}.`,
    });
  }
  if (!selected.bundle.grant) {
    diagnostics.push({
      id: `connection.${connection.alias}`,
      status: 'error',
      message: `Integration account ${connection.alias} has no Rat permission grant.`,
    });
  }
  let operations: OperationDefinition[];
  try {
    operations = plugins.plugin(connection.pluginId).manifest.operations;
  } catch (error) {
    diagnostics.push({
      id: `connection.${connection.alias}`,
      status: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
  const installed = new Set(operations.map((operation) => operation.id));
  for (const operationId of [
    ...(selected.requested?.allowOperations ?? []),
    ...(selected.requested?.denyOperations ?? []),
  ]) {
    if (!installed.has(operationId)) {
      diagnostics.push({
        id: `connection.${connection.alias}.${operationId}`,
        status: 'error',
        message: `Operation ${operationId} is not installed by plugin ${connection.pluginId}.`,
      });
    }
  }
  const resolvedOperations = selected.bundle.grant
    ? operations.map((operation) => resolveOperation(
      connection,
      selected.bundle.grant as ConnectionGrant,
      selected.requested,
      maximumAccess,
      operation,
    ))
    : [];
  const allowedCount = resolvedOperations.filter((operation) => operation.allowed).length;
  diagnostics.push({
    id: `connection.${connection.alias}`,
    status: connection.status === 'active' && selected.bundle.grant && allowedCount > 0
      ? 'pass'
      : 'error',
    message: `${connection.pluginId} account ${connection.alias} exposes ${allowedCount} of ${operations.length} installed operations after provider, grant, Thing, and profile limits.`,
  });
  return {
    connectionId: connection.connectionId,
    alias: connection.alias,
    pluginId: connection.pluginId,
    selectedBy: [...selected.selectedBy],
    ...(selected.defaultFor.size > 0 ? { defaultFor: [...selected.defaultFor] } : {}),
    status: connection.status,
    providerAuthorization: connection.authorization,
    ...(selected.bundle.grant ? {
      grant: {
        preset: selected.bundle.grant.preset,
        ...(selected.bundle.grant.expiresAt ? { expiresAt: selected.bundle.grant.expiresAt } : {}),
        ...(selected.bundle.grant.resourceConstraints
          ? { resourceConstraints: selected.bundle.grant.resourceConstraints }
          : {}),
      },
    } : {}),
    ...(selected.requested?.preset ? { requestedAccess: selected.requested.preset } : {}),
    operations: resolvedOperations,
  };
}

function resolveOperation(
  connection: IntegrationConnection,
  grant: ConnectionGrant,
  requested: ConnectionAccessRequest | undefined,
  maximumAccess: 'read-only' | 'read-write' | 'full' | undefined,
  operation: OperationDefinition,
): ResolvedThingOperation {
  const grants = [
    grant,
    ...(requested && hasPolicy(requested) ? [requestedGrant(connection, requested)] : []),
    ...(maximumAccess ? [profileGrant(connection, maximumAccess)] : []),
  ];
  const decisions = grants.map((candidate) => authorizeConnectionOperation({
    connection,
    grant: candidate,
    operation,
  }));
  const denied = decisions.find((decision) => !decision.allowed);
  const decision = denied ?? combinedDecision(decisions);
  return {
    id: operation.id,
    access: operation.access,
    allowed: decision.allowed,
    enforcement: decision.enforcement,
    ...(decision.reason ? { reason: decision.reason } : {}),
  };
}

function combinedDecision(decisions: OperationAuthorizationDecision[]): OperationAuthorizationDecision {
  return {
    allowed: true,
    enforcement: decisions.some((decision) => decision.enforcement === 'provider-and-broker')
      ? 'provider-and-broker'
      : 'broker',
  };
}

function requestedGrant(
  connection: IntegrationConnection,
  requested: ConnectionAccessRequest,
): ConnectionGrant {
  return {
    version: '1',
    grantId: `Thing:${connection.connectionId}`,
    ownerId: connection.ownerId,
    connectionId: connection.connectionId,
    preset: requested.preset ?? 'full',
    ...(requested.allowOperations ? { allowOperations: requested.allowOperations } : {}),
    ...(requested.denyOperations ? { denyOperations: requested.denyOperations } : {}),
  };
}

function profileGrant(
  connection: IntegrationConnection,
  preset: 'read-only' | 'read-write' | 'full',
): ConnectionGrant {
  return {
    version: '1',
    grantId: `profile:${connection.connectionId}`,
    ownerId: connection.ownerId,
    connectionId: connection.connectionId,
    preset,
  };
}

function hasPolicy(requested: ConnectionAccessRequest): boolean {
  return requested.preset !== undefined ||
    requested.allowOperations !== undefined ||
    requested.denyOperations !== undefined;
}
