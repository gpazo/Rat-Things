import type {
  AgentDriverName,
  AgentInput,
  ExecutionBackend,
  ExecutionInput,
  JsonValue,
  RepositoryInput,
  RepositoryProvider,
  RunRequest,
  RunSource,
  SandboxMode,
} from './contracts.js';
import {
  AGENT_PERSONALITIES,
  COMPUTER_USE_MODES,
  INTEGRATION_PERMISSION_PRESETS,
  REASONING_SUMMARIES,
  WEB_SEARCH_MODES,
} from './capabilities.js';
import type {
  AgentCapabilityRequest,
  ConnectionAccessRequest,
  IntegrationAccessRequest,
} from './capabilities.js';

const MAX_PROMPT_BYTES = 100_000;
const MAX_METADATA_BYTES = 32_000;
const MAX_OUTPUT_SCHEMA_BYTES = 32_000;
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/@+-]{0,254}$/;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/;
const ARN_PATTERN = /^arn:[a-z0-9-]+:secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]+$/;

export class ValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export interface ValidationOptions {
  allowedRepositoryHosts?: string[];
  allowedSandboxModes?: SandboxMode[];
}

export function parseRunRequest(value: unknown, options: ValidationOptions = {}): RunRequest {
  const input = requiredRecord(value, 'request');
  rejectUnknown(input, [
    'version',
    'prompt',
    'repository',
    'agent',
    'integrations',
    'execution',
    'source',
    'destinations',
    'metadata',
    'parentRunId',
  ]);

  if (input.version !== '1') {
    throw new ValidationError('version must be "1"');
  }
  const prompt = requiredString(input.prompt, 'prompt', MAX_PROMPT_BYTES);
  if (!prompt.trim()) {
    throw new ValidationError('prompt cannot be empty');
  }

  const result: RunRequest = { version: '1', prompt };
  if (input.repository !== undefined) {
    result.repository = parseRepository(input.repository, options.allowedRepositoryHosts);
  }
  if (input.agent !== undefined) {
    result.agent = parseAgent(input.agent, options.allowedSandboxModes);
  }
  if (input.integrations !== undefined) {
    result.integrations = parseIntegrations(input.integrations);
  }
  if (input.execution !== undefined) {
    result.execution = parseExecution(input.execution);
  }
  if (input.source !== undefined) {
    result.source = parseSource(input.source);
  }
  if (input.destinations !== undefined) {
    if (!Array.isArray(input.destinations) || input.destinations.length > 8) {
      throw new ValidationError('destinations must be an array with at most 8 entries');
    }
    result.destinations = input.destinations.map((destination, index) => {
      const item = requiredRecord(destination, `destinations[${index}]`);
      rejectUnknown(item, ['kind', 'route']);
      if (!['source', 'teams', 'slack', 'none'].includes(String(item.kind))) {
        throw new ValidationError(`destinations[${index}].kind is invalid`);
      }
      const output: NonNullable<RunRequest['destinations']>[number] = {
        kind: item.kind as NonNullable<RunRequest['destinations']>[number]['kind'],
      };
      if (item.route !== undefined) {
        output.route = requiredString(item.route, `destinations[${index}].route`, 128);
      }
      return output;
    });
  }
  if (input.metadata !== undefined) {
    const metadata = requiredRecord(input.metadata, 'metadata') as { [key: string]: JsonValue };
    assertJsonValue(metadata, 'metadata');
    assertJsonSize(metadata, 'metadata', MAX_METADATA_BYTES);
    result.metadata = metadata;
  }
  if (input.parentRunId !== undefined) {
    result.parentRunId = requiredString(input.parentRunId, 'parentRunId', 128);
  }
  return result;
}

function parseRepository(value: unknown, allowedHosts?: string[]): RepositoryInput {
  const input = requiredRecord(value, 'repository');
  rejectUnknown(input, [
    'provider',
    'url',
    'ref',
    'baseRef',
    'installationId',
    'credentialSecretArn',
  ]);
  if (!['github', 'gitlab', 'generic'].includes(String(input.provider))) {
    throw new ValidationError('repository.provider must be github, gitlab, or generic');
  }
  const provider = input.provider as RepositoryProvider;
  const rawUrl = requiredString(input.url, 'repository.url', 2_048);
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ValidationError('repository.url must be a valid HTTPS URL');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.hostname
  ) {
    throw new ValidationError('repository.url must be credential-free HTTPS without query or fragment');
  }
  const hosts = (allowedHosts ?? ['github.com', 'gitlab.com']).map((host) => host.toLowerCase());
  if (!hosts.includes(url.hostname.toLowerCase())) {
    throw new ValidationError(`repository host ${url.hostname} is not allowed`);
  }

  const result: RepositoryInput = { provider, url: url.toString() };
  for (const key of ['ref', 'baseRef'] as const) {
    const raw = input[key];
    if (raw !== undefined) {
      const ref = requiredString(raw, `repository.${key}`, 255);
      if (!REF_PATTERN.test(ref) || ref.includes('..') || ref.endsWith('/') || ref.includes('@{')) {
        throw new ValidationError(`repository.${key} is not a safe Git ref`);
      }
      result[key] = ref;
    }
  }
  if (input.installationId !== undefined) {
    result.installationId = requiredString(input.installationId, 'repository.installationId', 64);
  }
  if (input.credentialSecretArn !== undefined) {
    const arn = requiredString(input.credentialSecretArn, 'repository.credentialSecretArn', 2_048);
    if (!ARN_PATTERN.test(arn)) {
      throw new ValidationError('repository.credentialSecretArn must be a Secrets Manager ARN');
    }
    result.credentialSecretArn = arn;
  }
  return result;
}

function parseAgent(value: unknown, allowedSandboxModes?: SandboxMode[]): AgentInput {
  const input = requiredRecord(value, 'agent');
  rejectUnknown(input, [
    'driver',
    'model',
    'sandbox',
    'reasoningEffort',
    'reasoningSummary',
    'personality',
    'capabilities',
    'outputSchema',
  ]);
  const result: AgentInput = {};
  if (input.driver !== undefined) {
    if (!['codex', 'mock'].includes(String(input.driver))) {
      throw new ValidationError('agent.driver must be codex or mock');
    }
    result.driver = input.driver as AgentDriverName;
  }
  if (input.model !== undefined) {
    const model = requiredString(input.model, 'agent.model', 255);
    if (!MODEL_PATTERN.test(model)) {
      throw new ValidationError('agent.model contains unsupported characters');
    }
    result.model = model;
  }
  if (input.sandbox !== undefined) {
    if (!['read-only', 'workspace-write', 'danger-full-access'].includes(String(input.sandbox))) {
      throw new ValidationError('agent.sandbox is invalid');
    }
    const sandbox = input.sandbox as SandboxMode;
    if (allowedSandboxModes && !allowedSandboxModes.includes(sandbox)) {
      throw new ValidationError(`agent.sandbox ${sandbox} is disabled by runtime policy`);
    }
    result.sandbox = sandbox;
  }
  if (input.reasoningEffort !== undefined) {
    if (!['low', 'medium', 'high', 'xhigh', 'ultra'].includes(String(input.reasoningEffort))) {
      throw new ValidationError('agent.reasoningEffort is invalid');
    }
    result.reasoningEffort = input.reasoningEffort as NonNullable<AgentInput['reasoningEffort']>;
  }
  if (input.reasoningSummary !== undefined) {
    if (!REASONING_SUMMARIES.includes(input.reasoningSummary as never)) {
      throw new ValidationError('agent.reasoningSummary is invalid');
    }
    result.reasoningSummary = input.reasoningSummary as NonNullable<AgentInput['reasoningSummary']>;
  }
  if (input.personality !== undefined) {
    if (!AGENT_PERSONALITIES.includes(input.personality as never)) {
      throw new ValidationError('agent.personality is invalid');
    }
    result.personality = input.personality as NonNullable<AgentInput['personality']>;
  }
  if (input.capabilities !== undefined) {
    result.capabilities = parseAgentCapabilities(input.capabilities);
  }
  if (input.outputSchema !== undefined) {
    const schema = requiredRecord(input.outputSchema, 'agent.outputSchema') as {
      [key: string]: JsonValue;
    };
    assertJsonValue(schema, 'agent.outputSchema');
    assertJsonSize(schema, 'agent.outputSchema', MAX_OUTPUT_SCHEMA_BYTES);
    result.outputSchema = schema;
  }
  return result;
}

function parseAgentCapabilities(value: unknown): AgentCapabilityRequest {
  const input = requiredRecord(value, 'agent.capabilities');
  rejectUnknown(input, [
    'profile',
    'networkAccess',
    'webSearch',
    'computerUse',
    'skills',
    'apps',
    'mcpServers',
  ]);
  const result: AgentCapabilityRequest = {};
  if (input.profile !== undefined) {
    result.profile = safeIdentifier(input.profile, 'agent.capabilities.profile');
  }
  if (input.networkAccess !== undefined) {
    if (typeof input.networkAccess !== 'boolean') {
      throw new ValidationError('agent.capabilities.networkAccess must be boolean');
    }
    result.networkAccess = input.networkAccess;
  }
  if (input.webSearch !== undefined) {
    if (!WEB_SEARCH_MODES.includes(input.webSearch as never)) {
      throw new ValidationError('agent.capabilities.webSearch is invalid');
    }
    result.webSearch = input.webSearch as NonNullable<AgentCapabilityRequest['webSearch']>;
  }
  if (input.computerUse !== undefined) {
    if (!COMPUTER_USE_MODES.includes(input.computerUse as never)) {
      throw new ValidationError('agent.capabilities.computerUse is invalid');
    }
    result.computerUse = input.computerUse as NonNullable<AgentCapabilityRequest['computerUse']>;
  }
  for (const key of ['skills', 'apps', 'mcpServers'] as const) {
    if (input[key] !== undefined) {
      result[key] = identifierList(input[key], `agent.capabilities.${key}`, 64);
    }
  }
  if (result.computerUse === 'browser' && result.networkAccess === false) {
    throw new ValidationError('agent.capabilities.computerUse browser requires networkAccess');
  }
  return result;
}

function parseIntegrations(value: unknown): IntegrationAccessRequest {
  const input = requiredRecord(value, 'integrations');
  rejectUnknown(input, ['connectionSet', 'connections']);
  const result: IntegrationAccessRequest = {};
  if (input.connectionSet !== undefined) {
    result.connectionSet = safeIdentifier(input.connectionSet, 'integrations.connectionSet');
  }
  if (input.connections !== undefined) {
    if (!Array.isArray(input.connections) || input.connections.length > 32) {
      throw new ValidationError('integrations.connections must be an array with at most 32 entries');
    }
    const connections = input.connections.map((candidate, index): ConnectionAccessRequest => {
      const item = requiredRecord(candidate, `integrations.connections[${index}]`);
      rejectUnknown(item, ['connection', 'preset', 'allowOperations', 'denyOperations']);
      const connection: ConnectionAccessRequest = {
        connection: safeIdentifier(item.connection, `integrations.connections[${index}].connection`),
      };
      if (item.preset !== undefined) {
        if (!INTEGRATION_PERMISSION_PRESETS.includes(item.preset as never)) {
          throw new ValidationError(`integrations.connections[${index}].preset is invalid`);
        }
        connection.preset = item.preset as NonNullable<ConnectionAccessRequest['preset']>;
      }
      if (item.allowOperations !== undefined) {
        connection.allowOperations = operationList(
          item.allowOperations,
          `integrations.connections[${index}].allowOperations`,
        );
      }
      if (item.denyOperations !== undefined) {
        connection.denyOperations = operationList(
          item.denyOperations,
          `integrations.connections[${index}].denyOperations`,
        );
      }
      const overlap = connection.allowOperations?.find((operation) => (
        connection.denyOperations?.includes(operation)
      ));
      if (overlap) {
        throw new ValidationError(`integration operation ${overlap} is both allowed and denied`);
      }
      if (connection.preset === 'custom' && !connection.allowOperations?.length) {
        throw new ValidationError('custom integration access requires allowOperations');
      }
      return connection;
    });
    const ids = new Set<string>();
    for (const connection of connections) {
      if (ids.has(connection.connection)) {
        throw new ValidationError(`duplicate integration connection ${connection.connection}`);
      }
      ids.add(connection.connection);
    }
    result.connections = connections;
  }
  if (!result.connectionSet && !result.connections?.length) {
    throw new ValidationError('integrations requires connectionSet or connections');
  }
  return result;
}

function parseExecution(value: unknown): ExecutionInput {
  const input = requiredRecord(value, 'execution');
  rejectUnknown(input, ['backend', 'timeoutSeconds']);
  const result: ExecutionInput = {};
  if (input.backend !== undefined) {
    if (input.backend !== 'microvm') {
      throw new ValidationError('execution.backend must be microvm');
    }
    result.backend = input.backend as ExecutionBackend;
  }
  if (input.timeoutSeconds !== undefined) {
    if (
      typeof input.timeoutSeconds !== 'number' ||
      !Number.isInteger(input.timeoutSeconds) ||
      input.timeoutSeconds < 30 ||
      input.timeoutSeconds > 28_000
    ) {
      throw new ValidationError('execution.timeoutSeconds must be an integer from 30 to 28000');
    }
    result.timeoutSeconds = input.timeoutSeconds;
  }
  return result;
}

function parseSource(value: unknown): RunSource {
  const input = requiredRecord(value, 'source');
  const kind = requiredString(input.kind, 'source.kind', 32);
  switch (kind) {
    case 'api':
      rejectUnknown(input, ['kind', 'requestId']);
      return input.requestId === undefined
        ? { kind: 'api' }
        : { kind: 'api', requestId: requiredString(input.requestId, 'source.requestId', 128) };
    case 'github': {
      rejectUnknown(input, [
        'kind',
        'deliveryId',
        'event',
        'repository',
        'issueNumber',
        'installationId',
      ]);
      const source: Extract<RunSource, { kind: 'github' }> = {
        kind,
        deliveryId: requiredString(input.deliveryId, 'source.deliveryId', 128),
        event: requiredString(input.event, 'source.event', 128),
        repository: requiredString(input.repository, 'source.repository', 512),
      };
      if (input.issueNumber !== undefined) source.issueNumber = positiveInteger(input.issueNumber, 'source.issueNumber');
      if (input.installationId !== undefined) source.installationId = requiredString(input.installationId, 'source.installationId', 64);
      return source;
    }
    case 'gitlab': {
      rejectUnknown(input, ['kind', 'event', 'projectId', 'mergeRequestIid']);
      const source: Extract<RunSource, { kind: 'gitlab' }> = {
        kind,
        event: requiredString(input.event, 'source.event', 128),
        projectId: requiredString(input.projectId, 'source.projectId', 128),
      };
      if (input.mergeRequestIid !== undefined) source.mergeRequestIid = positiveInteger(input.mergeRequestIid, 'source.mergeRequestIid');
      return source;
    }
    case 'teams': {
      rejectUnknown(input, ['kind', 'tenantId', 'teamId', 'channelId', 'conversationId', 'activityId', 'senderId']);
      const source: Extract<RunSource, { kind: 'teams' }> = {
        kind,
        conversationId: requiredString(input.conversationId, 'source.conversationId', 512),
        activityId: requiredString(input.activityId, 'source.activityId', 512),
      };
      for (const key of ['tenantId', 'teamId', 'channelId', 'senderId'] as const) {
        if (input[key] !== undefined) source[key] = requiredString(input[key], `source.${key}`, 512);
      }
      return source;
    }
    case 'slack': {
      rejectUnknown(input, ['kind', 'teamId', 'channelId', 'threadTs', 'eventId', 'userId']);
      const source: Extract<RunSource, { kind: 'slack' }> = {
        kind,
        channelId: requiredString(input.channelId, 'source.channelId', 128),
        eventId: requiredString(input.eventId, 'source.eventId', 128),
      };
      for (const key of ['teamId', 'threadTs', 'userId'] as const) {
        if (input[key] !== undefined) source[key] = requiredString(input[key], `source.${key}`, 128);
      }
      return source;
    }
    default:
      throw new ValidationError('source.kind is invalid');
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ValidationError(`${label} must be an object`);
  return value;
}

export function requiredString(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`${label} must be a non-empty string`);
  }
  if (Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new ValidationError(`${label} exceeds ${maxBytes} bytes`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new ValidationError(`${label} must be a positive integer`);
  }
  return value;
}

function safeIdentifier(value: unknown, label: string): string {
  const result = requiredString(value, label, 256);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(result)) {
    throw new ValidationError(`${label} is invalid`);
  }
  return result;
}

function identifierList(value: unknown, label: string, maximum: number): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum) {
    throw new ValidationError(`${label} must be an array with 1-${maximum} entries`);
  }
  const result = value.map((item, index) => safeIdentifier(item, `${label}[${index}]`));
  const duplicate = result.find((item, index) => result.indexOf(item) !== index);
  if (duplicate) throw new ValidationError(`${label} contains duplicate ${duplicate}`);
  return result;
}

function operationList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 128) {
    throw new ValidationError(`${label} must be an array with at most 128 entries`);
  }
  const result = value.map((item, index) => {
    const operation = requiredString(item, `${label}[${index}]`, 256);
    if (!/^[a-z][a-z0-9-]{0,63}(?:\.[a-z][a-zA-Z0-9-]{0,63})+$/.test(operation)) {
      throw new ValidationError(`${label}[${index}] is invalid`);
    }
    return operation;
  });
  const duplicate = result.find((item, index) => result.indexOf(item) !== index);
  if (duplicate) throw new ValidationError(`${label} contains duplicate ${duplicate}`);
  return result;
}

function rejectUnknown(input: Record<string, unknown>, allowed: string[]): void {
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new ValidationError(`unknown field: ${unknown[0]}`);
}

function assertJsonSize(value: unknown, label: string, maxBytes: number): void {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new ValidationError(`${label} must be JSON serializable`);
  }
  if (Buffer.byteLength(encoded, 'utf8') > maxBytes) {
    throw new ValidationError(`${label} exceeds ${maxBytes} bytes`);
  }
}

function assertJsonValue(value: unknown, label: string, seen = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ValidationError(`${label} contains a non-finite number`);
    return;
  }
  if (typeof value !== 'object') throw new ValidationError(`${label} must contain only JSON values`);
  if (seen.has(value)) throw new ValidationError(`${label} cannot contain a cycle`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${label}[${index}]`, seen));
  } else {
    for (const [key, item] of Object.entries(value)) {
      assertJsonValue(item, `${label}.${key}`, seen);
    }
  }
  seen.delete(value);
}
