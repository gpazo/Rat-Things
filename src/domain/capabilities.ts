import type { JsonValue, RunSource, SandboxMode } from './contracts.js';

export const WEB_SEARCH_MODES = ['disabled', 'cached', 'indexed', 'live'] as const;
export type WebSearchMode = (typeof WEB_SEARCH_MODES)[number];

export const COMPUTER_USE_MODES = ['disabled', 'browser'] as const;
export type ComputerUseMode = (typeof COMPUTER_USE_MODES)[number];

export const REASONING_SUMMARIES = ['auto', 'concise', 'detailed', 'none'] as const;
export type ReasoningSummary = (typeof REASONING_SUMMARIES)[number];

export const AGENT_PERSONALITIES = ['none', 'friendly', 'pragmatic'] as const;
export type AgentPersonality = (typeof AGENT_PERSONALITIES)[number];

/**
 * Caller-requested capabilities. Deployment policy and source bindings remain
 * authoritative ceilings; this object can only select or narrow capabilities.
 */
export interface AgentCapabilityRequest {
  profile?: string;
  networkAccess?: boolean;
  webSearch?: WebSearchMode;
  computerUse?: ComputerUseMode;
  skills?: string[];
  apps?: string[];
  mcpServers?: string[];
}

export interface CapabilityProfileDefinition {
  id: string;
  sandbox: SandboxMode;
  networkAccess: boolean;
  webSearch: WebSearchMode;
  computerUse: ComputerUseMode;
  allowedSkills?: string[];
  allowedApps?: string[];
  allowedMcpServers?: string[];
  maximumIntegrationAccess: Exclude<IntegrationPermissionPreset, 'custom'>;
}

export const INTEGRATION_PERMISSION_PRESETS = [
  'read-only',
  'read-write',
  'full',
  'custom',
] as const;
export type IntegrationPermissionPreset = (typeof INTEGRATION_PERMISSION_PRESETS)[number];

export const INTEGRATION_ACCESS_LEVELS = ['read', 'write', 'full'] as const;
export type IntegrationAccessLevel = (typeof INTEGRATION_ACCESS_LEVELS)[number];

export const OPERATION_KINDS = ['trigger', 'search', 'action', 'tool'] as const;
export type OperationKind = (typeof OPERATION_KINDS)[number];

export const OPERATION_RISKS = [
  'routine',
  'consequential',
  'destructive',
  'privileged',
] as const;
export type OperationRisk = (typeof OPERATION_RISKS)[number];

export const CONNECTION_STATUSES = ['active', 'expired', 'revoked'] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export const CONNECTION_HEALTH_STATUSES = [
  'unknown',
  'healthy',
  'degraded',
  'reauth-required',
] as const;
export type ConnectionHealthStatus = (typeof CONNECTION_HEALTH_STATUSES)[number];

export const CONNECTION_HEALTH_CODES = [
  'not-tested',
  'verified',
  'provider-unavailable',
  'credential-rejected',
  'identity-mismatch',
  'credential-missing',
] as const;
export type ConnectionHealthCode = (typeof CONNECTION_HEALTH_CODES)[number];

export const AUTH_SCHEMES = ['oauth2', 'api-key', 'session', 'basic'] as const;
export type IntegrationAuthScheme = (typeof AUTH_SCHEMES)[number];

export const PROVIDER_SCOPE_MODELS = ['granular', 'coarse', 'unknown'] as const;
export type ProviderScopeModel = (typeof PROVIDER_SCOPE_MODELS)[number];

export interface ProviderAuthorization {
  scheme: IntegrationAuthScheme;
  access: IntegrationAccessLevel;
  scopeModel: ProviderScopeModel;
  scopes: string[];
}

/** Metadata only. The credential reference and value live in src/credentials. */
export interface IntegrationConnection {
  version: '1';
  connectionId: string;
  ownerId: string;
  pluginId: string;
  alias: string;
  /** Mutable presentation label. Stable API/Thing references continue to use the alias or ID. */
  displayName?: string;
  label: string;
  externalTenantId?: string;
  externalSubjectId?: string;
  authorization: ProviderAuthorization;
  status: ConnectionStatus;
  createdAt: string;
  updatedAt: string;
}

/** Safe operational metadata only. Provider response bodies and credentials never enter this record. */
export interface ConnectionHealth {
  version: '1';
  ownerId: string;
  connectionId: string;
  status: ConnectionHealthStatus;
  code: ConnectionHealthCode;
  checkedAt?: string;
  lastHealthyAt?: string;
  lastFailureAt?: string;
}

export interface OperationDefinition {
  id: string;
  title: string;
  kind: OperationKind;
  access: IntegrationAccessLevel;
  risk: OperationRisk;
  requiredProviderScopes?: string[];
  inputSchema?: { [key: string]: JsonValue };
}

/**
 * A Rat-side grant. This remains independent from provider authorization so a
 * full-access API key can still be exposed as read-only to a particular run.
 */
export interface ConnectionGrant {
  version: '1';
  grantId: string;
  ownerId: string;
  connectionId: string;
  preset: IntegrationPermissionPreset;
  allowOperations?: string[];
  denyOperations?: string[];
  resourceConstraints?: { [key: string]: string[] };
  expiresAt?: string;
}

export interface ConnectionSet {
  version: '1';
  connectionSetId: string;
  ownerId: string;
  name: string;
  connectionIds: string[];
  /** Maps a plugin or capability name to its default connection ID. */
  defaults?: { [key: string]: string };
}

export interface SourceCapabilityBinding {
  version: '1';
  bindingId: string;
  ownerId: string;
  sourceKind: RunSource['kind'];
  /** Exact source fields such as repository, teamId, or channelId. */
  selector: { [key: string]: string };
  capabilityProfile?: string;
  connectionSetId?: string;
}

/** Owner-scoped selectors only; credential references are never accepted here. */
export interface IntegrationAccessRequest {
  connectionSet?: string;
  connections?: ConnectionAccessRequest[];
}

export interface ConnectionAccessRequest {
  connection: string;
  preset?: IntegrationPermissionPreset;
  allowOperations?: string[];
  denyOperations?: string[];
}

export interface OperationAuthorizationDecision {
  allowed: boolean;
  enforcement: 'provider-and-broker' | 'broker';
  reason?: string;
}

export function authorizeConnectionOperation(input: {
  connection: IntegrationConnection;
  grant: ConnectionGrant;
  operation: OperationDefinition;
  now?: Date;
}): OperationAuthorizationDecision {
  const { connection, grant, operation } = input;
  const enforcement = operationEnforcement(connection, operation);
  const denied = (reason: string): OperationAuthorizationDecision => ({
    allowed: false,
    enforcement,
    reason,
  });

  if (connection.ownerId !== grant.ownerId) return denied('connection and grant owners do not match');
  if (connection.connectionId !== grant.connectionId) return denied('grant targets another connection');
  if (connection.status !== 'active') return denied(`connection is ${connection.status}`);
  if (grant.expiresAt && Date.parse(grant.expiresAt) <= (input.now ?? new Date()).getTime()) {
    return denied('grant has expired');
  }
  if (grant.denyOperations?.includes(operation.id)) return denied('operation is explicitly denied');
  if (grant.allowOperations && !grant.allowOperations.includes(operation.id)) {
    return denied('operation is outside the grant allowlist');
  }
  if (grant.preset === 'custom' && !grant.allowOperations?.includes(operation.id)) {
    return denied('custom grants require an explicit operation allowlist');
  }
  if (grant.preset !== 'custom' && !accessIncludes(presetAccess(grant.preset), operation.access)) {
    return denied(`operation requires ${operation.access} access`);
  }
  if (!accessIncludes(connection.authorization.access, operation.access)) {
    return denied(`provider authorization does not include ${operation.access} access`);
  }
  if (
    connection.authorization.scopeModel === 'granular' &&
    operation.requiredProviderScopes?.some(
      (scope) => !connection.authorization.scopes.includes(scope),
    )
  ) return denied('provider authorization is missing a required scope');

  return {
    allowed: true,
    enforcement,
  };
}

export function sourceBindingMatches(
  binding: SourceCapabilityBinding,
  source: RunSource,
): boolean {
  if (binding.sourceKind !== source.kind) return false;
  const sourceFields = source as unknown as Record<string, unknown>;
  return Object.entries(binding.selector).every(([key, expected]) => {
    const actual = sourceFields[key];
    return typeof actual === 'string' || typeof actual === 'number'
      ? String(actual) === expected
      : false;
  });
}

export function validateIntegrationConnection(value: IntegrationConnection): IntegrationConnection {
  requireVersion(value.version);
  requireId(value.connectionId, 'connection ID');
  requireIdentity(value.ownerId, 'connection owner');
  requireId(value.pluginId, 'plugin ID');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(value.alias)) {
    throw new Error('connection alias is invalid');
  }
  if (value.displayName !== undefined) requireLabel(value.displayName, 'connection display name', 256);
  requireLabel(value.label, 'connection label', 256);
  if (value.externalTenantId !== undefined) requireLabel(value.externalTenantId, 'external tenant ID', 512);
  if (value.externalSubjectId !== undefined) requireLabel(value.externalSubjectId, 'external subject ID', 512);
  if (!AUTH_SCHEMES.includes(value.authorization.scheme)) throw new Error('connection auth scheme is invalid');
  if (!INTEGRATION_ACCESS_LEVELS.includes(value.authorization.access)) throw new Error('connection access is invalid');
  if (!PROVIDER_SCOPE_MODELS.includes(value.authorization.scopeModel)) throw new Error('connection scope model is invalid');
  validateIdList(value.authorization.scopes, 'provider scopes', 256);
  if (!CONNECTION_STATUSES.includes(value.status)) throw new Error('connection status is invalid');
  requireTimestamp(value.createdAt, 'connection createdAt');
  requireTimestamp(value.updatedAt, 'connection updatedAt');
  return structuredClone(value);
}

export function validateConnectionHealth(value: ConnectionHealth): ConnectionHealth {
  requireVersion(value.version);
  requireIdentity(value.ownerId, 'connection health owner');
  requireId(value.connectionId, 'connection health connection ID');
  if (!CONNECTION_HEALTH_STATUSES.includes(value.status)) throw new Error('connection health status is invalid');
  if (!CONNECTION_HEALTH_CODES.includes(value.code)) throw new Error('connection health code is invalid');
  if (value.checkedAt) requireTimestamp(value.checkedAt, 'connection health checkedAt');
  if (value.lastHealthyAt) requireTimestamp(value.lastHealthyAt, 'connection health lastHealthyAt');
  if (value.lastFailureAt) requireTimestamp(value.lastFailureAt, 'connection health lastFailureAt');
  if (value.status === 'healthy' && !value.checkedAt) throw new Error('healthy connection requires checkedAt');
  return structuredClone(value);
}

export function validateOperationDefinition(value: OperationDefinition): OperationDefinition {
  requireOperationId(value.id, 'operation ID');
  requireLabel(value.title, 'operation title', 256);
  if (!OPERATION_KINDS.includes(value.kind)) throw new Error('operation kind is invalid');
  if (!INTEGRATION_ACCESS_LEVELS.includes(value.access)) throw new Error('operation access is invalid');
  if (!OPERATION_RISKS.includes(value.risk)) throw new Error('operation risk is invalid');
  if (value.requiredProviderScopes) validateIdList(value.requiredProviderScopes, 'required provider scopes', 64);
  if (value.inputSchema) assertJson(value.inputSchema, 'operation input schema');
  return structuredClone(value);
}

export function validateConnectionGrant(value: ConnectionGrant): ConnectionGrant {
  requireVersion(value.version);
  requireId(value.grantId, 'grant ID');
  requireIdentity(value.ownerId, 'grant owner');
  requireId(value.connectionId, 'grant connection ID');
  if (!INTEGRATION_PERMISSION_PRESETS.includes(value.preset)) throw new Error('grant preset is invalid');
  if (value.allowOperations) validateOperationList(value.allowOperations, 'allowed operations');
  if (value.denyOperations) validateOperationList(value.denyOperations, 'denied operations');
  const overlap = value.allowOperations?.find((operation) => value.denyOperations?.includes(operation));
  if (overlap) throw new Error(`operation ${overlap} is both allowed and denied`);
  if (value.preset === 'custom' && !value.allowOperations?.length) {
    throw new Error('custom grant requires allowed operations');
  }
  if (value.resourceConstraints) {
    if (Object.keys(value.resourceConstraints).length > 64) throw new Error('grant has too many resource constraints');
    for (const [resource, ids] of Object.entries(value.resourceConstraints)) {
      requireId(resource, 'resource constraint');
      validateIdList(ids, `resource constraint ${resource}`, 256);
    }
  }
  if (value.expiresAt) requireTimestamp(value.expiresAt, 'grant expiresAt');
  return structuredClone(value);
}

export function validateConnectionSet(value: ConnectionSet): ConnectionSet {
  requireVersion(value.version);
  requireId(value.connectionSetId, 'connection set ID');
  requireIdentity(value.ownerId, 'connection set owner');
  requireLabel(value.name, 'connection set name', 128);
  validateIdList(value.connectionIds, 'connection set connections', 128);
  if (value.connectionIds.length === 0) throw new Error('connection set requires at least one connection');
  for (const [capability, connectionId] of Object.entries(value.defaults ?? {})) {
    requireId(capability, 'connection default capability');
    requireId(connectionId, 'connection default');
    if (!value.connectionIds.includes(connectionId)) {
      throw new Error(`default connection ${connectionId} is not in the connection set`);
    }
  }
  return structuredClone(value);
}

export function validateSourceCapabilityBinding(
  value: SourceCapabilityBinding,
): SourceCapabilityBinding {
  requireVersion(value.version);
  requireId(value.bindingId, 'source binding ID');
  requireIdentity(value.ownerId, 'source binding owner');
  if (!['api', 'github', 'gitlab', 'teams', 'slack'].includes(value.sourceKind)) {
    throw new Error('source binding kind is invalid');
  }
  if (Object.keys(value.selector).length === 0) throw new Error('source binding selector is required');
  if (Object.keys(value.selector).length > 32) throw new Error('source binding selector is too large');
  for (const [key, selected] of Object.entries(value.selector)) {
    requireId(key, 'source selector field');
    requireLabel(selected, `source selector ${key}`, 512);
  }
  if (value.capabilityProfile) requireId(value.capabilityProfile, 'capability profile');
  if (value.connectionSetId) requireId(value.connectionSetId, 'connection set ID');
  return structuredClone(value);
}

function operationEnforcement(
  connection: IntegrationConnection,
  operation: OperationDefinition,
): OperationAuthorizationDecision['enforcement'] {
  return connection.authorization.scopeModel === 'granular' &&
    (operation.requiredProviderScopes?.length ?? 0) > 0
    ? 'provider-and-broker'
    : 'broker';
}

function presetAccess(
  preset: Exclude<IntegrationPermissionPreset, 'custom'>,
): IntegrationAccessLevel {
  switch (preset) {
    case 'read-only': return 'read';
    case 'read-write': return 'write';
    case 'full': return 'full';
  }
}

function accessIncludes(granted: IntegrationAccessLevel, required: IntegrationAccessLevel): boolean {
  return INTEGRATION_ACCESS_LEVELS.indexOf(granted) >= INTEGRATION_ACCESS_LEVELS.indexOf(required);
}

function requireVersion(value: unknown): asserts value is '1' {
  if (value !== '1') throw new Error('version must be 1');
}

function requireId(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(value)) throw new Error(`${label} is invalid`);
}

function requireOperationId(value: string, label: string): void {
  if (!/^[a-z][a-z0-9-]{0,63}(?:\.[a-z][a-zA-Z0-9-]{0,63})+$/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
}

function requireIdentity(value: string, label: string): void {
  requireLabel(value, label, 1_024);
}

function requireLabel(value: string, label: string, maximum: number): void {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > maximum) {
    throw new Error(`${label} is invalid`);
  }
}

function requireTimestamp(value: string, label: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} is invalid`);
  }
}

function validateIdList(values: string[], label: string, maximum: number): void {
  if (!Array.isArray(values) || values.length > maximum) throw new Error(`${label} is invalid`);
  const seen = new Set<string>();
  for (const value of values) {
    requireId(value, label);
    if (seen.has(value)) throw new Error(`${label} contains duplicate ${value}`);
    seen.add(value);
  }
}

function validateOperationList(values: string[], label: string): void {
  if (!Array.isArray(values) || values.length > 128) throw new Error(`${label} is invalid`);
  const seen = new Set<string>();
  for (const value of values) {
    requireOperationId(value, label);
    if (seen.has(value)) throw new Error(`${label} contains duplicate ${value}`);
    seen.add(value);
  }
}

function assertJson(value: unknown, label: string, seen = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number`);
    return;
  }
  if (typeof value !== 'object') throw new Error(`${label} must contain only JSON values`);
  if (seen.has(value)) throw new Error(`${label} cannot contain a cycle`);
  seen.add(value);
  for (const item of Array.isArray(value) ? value : Object.values(value)) assertJson(item, label, seen);
  seen.delete(value);
}
