import { canonicalModelName } from './session-model-validation.js';
import type {
  Agent, AgentCreateParams, AgentUpdateParams, PersistedAgentTool,
  PersistedAgentToolParam,
} from './agents-api.js';
import { invalid, validateAgentMetadata } from './agents-api-validation.js';
import nativeModelDefaults from '../../runtime/codex/model-defaults.json' with { type: 'json' };

export type AgentConfigurationDefaults = Pick<Agent, 'reasoning' | 'multi_agent' | 'text' | 'service_tier'>;

export const DEFAULT_AGENT_CONFIGURATION: AgentConfigurationDefaults = {
  reasoning: { effort: null, summary: null },
  multi_agent: { enabled: false, max_concurrent_subagents: null },
  text: { format: { type: 'text' }, verbosity: 'medium' },
  service_tier: 'auto',
};

/** An explicitly supplied object replaces the field. It never deep-merges. */
export function resolveAgentConfiguration(
  input: AgentCreateParams | AgentUpdateParams,
  identity: Pick<Agent, 'id' | 'created_at' | 'updated_at'>,
  previous?: Agent,
  defaults: AgentConfigurationDefaults = DEFAULT_AGENT_CONFIGURATION,
): Agent {
  const model = input.model ?? previous?.model;
  if (!model?.trim()) invalid('model is required', 'model');
  if (exceedsCharacterLimit(model, 1_048_576)) invalid('model is too long', 'model');
  if (input.instructions && exceedsCharacterLimit(input.instructions, 1_048_576)) invalid('instructions is too long', 'instructions');
  if (input.name && [...input.name].length > 128) invalid('name is too long', 'name');
  validateAgentMetadata(input.metadata);
  if (input.multi_agent?.max_concurrent_subagents !== undefined &&
    (!Number.isInteger(input.multi_agent.max_concurrent_subagents) || input.multi_agent.max_concurrent_subagents < 1)) {
    invalid('max_concurrent_subagents must be a positive integer', 'multi_agent.max_concurrent_subagents');
  }
  const tools = input.tools === undefined && previous ? previous.tools : (input.tools ?? []).map(resolvePersistedAgentTool);
  const names = tools.flatMap((tool) => tool.type === 'function' ? [`function:${tool.name}`] : tool.type === 'mcp' ? [`mcp:${tool.server_label}`] : [tool.type]);
  if (new Set(names).size !== names.length) invalid('Tool names and MCP server labels must be unique', 'tools');
  const multiAgentEnabled = input.multi_agent?.enabled ?? defaults.multi_agent.enabled;
  return {
    ...identity,
    object: 'agent',
    model,
    name: field(input.name, previous?.name, null),
    instructions: field(input.instructions, previous?.instructions, null),
    metadata: field(input.metadata, previous?.metadata, {}),
    reasoning: input.reasoning === undefined && previous ? previous.reasoning : {
      effort: input.reasoning?.effort ?? defaults.reasoning.effort ?? modelReasoningDefault(model),
      summary: input.reasoning?.summary ?? defaults.reasoning.summary,
    },
    multi_agent: input.multi_agent === undefined && previous ? previous.multi_agent : {
      enabled: multiAgentEnabled,
      max_concurrent_subagents: multiAgentEnabled
        ? input.multi_agent?.max_concurrent_subagents ?? defaults.multi_agent.max_concurrent_subagents ?? 6
        : null,
    },
    text: input.text === undefined && previous ? previous.text : {
      format: input.text?.format ?? defaults.text.format,
      verbosity: input.text?.verbosity ?? defaults.text.verbosity,
    },
    service_tier: field(input.service_tier, previous?.service_tier, defaults.service_tier),
    tools,
  };
}

/** JSON Schema string limits count Unicode code points, not UTF-16 units. */
function exceedsCharacterLimit(value: string, maximum: number): boolean {
  if (value.length <= maximum) return false;
  let characters = 0;
  for (const _character of value) {
    if (++characters > maximum) return true;
  }
  return false;
}

/** Resolve known defaults from the same pinned model catalogue as the harness. */
export function modelReasoningDefault(model: string): Agent['reasoning']['effort'] {
  const effort = (nativeModelDefaults.defaults as Record<string, unknown>)[canonicalModelName(model)];
  switch (effort) {
    case 'none': case 'minimal': case 'low': case 'medium': case 'high': case 'xhigh': case 'max': return effort;
    default: return null;
  }
}

function field<T>(input: T | null | undefined, previous: T | undefined, fallback: T): T {
  return input === undefined ? previous ?? fallback : input ?? fallback;
}

export function resolvePersistedAgentTool(tool: PersistedAgentToolParam): PersistedAgentTool {
  switch (tool.type) {
    case 'function': return { ...tool, defer_loading: tool.defer_loading ?? false };
    case 'tool_search': return { type: 'tool_search' };
    case 'programmatic_tool_calling': return { ...tool, enabled: tool.enabled ?? true };
    case 'web_search': return {
      type: 'web_search',
      mode: tool.mode ?? 'live',
      allowed_domains: tool.allowed_domains ?? null,
      context_size: tool.context_size ?? 'medium',
      location: tool.location ? {
        city: tool.location.city ?? null,
        country: tool.location.country ?? null,
        region: tool.location.region ?? null,
        timezone: tool.location.timezone ?? null,
      } : null,
    };
    case 'mcp': {
      const transport = tool.transport;
      if (!tool.server_label || !/^[A-Za-z0-9_-]+$/.test(tool.server_label) || ['__proto__', 'prototype', 'constructor'].includes(tool.server_label)) invalid('Invalid MCP server label', 'tools.server_label');
      if (transport.type === 'stdio' && (!transport.command || transport.command.includes('\0') || !transport.cwd.startsWith('/') || transport.cwd.includes('\0'))) invalid('Stdio MCP requires a command and absolute working directory', 'tools.transport');
      if (transport.type === 'http') {
        let url: URL;
        try { url = new URL(transport.server_url); } catch { invalid('Invalid MCP server URL', 'tools.transport.server_url'); }
        if ((url.protocol !== 'https:' && !(tool.connection_origin === 'environment' && url.protocol === 'http:')) || url.username || url.password || url.hash) {
          invalid('Service MCP URLs must use HTTPS; URLs cannot contain credentials or fragments', 'tools.transport.server_url');
        }
        if (Object.keys(transport.headers ?? {}).some((name) => /authorization|cookie|api[-_]?key|token|secret/i.test(name))) {
          invalid('Reusable agents cannot store authentication headers; use a vault credential', 'tools.transport.headers');
        }
      }
      return {
        type: 'mcp',
        server_label: tool.server_label,
        allowed_tools: tool.allowed_tools ?? null,
        connection_origin: tool.connection_origin ?? (transport.type === 'stdio' ? 'environment' : 'service'),
        credential_id: tool.credential_id ?? null,
        request_metadata: tool.request_metadata ?? {},
        required: tool.required ?? false,
        transport: transport.type === 'http' ? {
          type: 'http', server_url: transport.server_url, headers: transport.headers ?? {},
        } : {
          type: 'stdio', command: transport.command, cwd: transport.cwd,
          args: transport.args ?? [], env_vars: transport.env_vars ?? [],
        },
      };
    }
  }
}
