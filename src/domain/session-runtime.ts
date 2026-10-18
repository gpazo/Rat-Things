import { createHash } from 'node:crypto';
import type { Agent, AgentSession, AgentSessionInputMessageParam, EnvironmentParam } from './agents-api.js';
import { invalid } from './agents-api-validation.js';
import { canonicalJson } from './json.js';

export type SessionRuntime = 'codex' | 'pi';
export interface PiModelDescriptor {
  id: string;
  name: string;
  provider: 'amazon-bedrock';
  api: 'bedrock-converse-stream';
  region: string;
  input: readonly ('text' | 'image')[];
  contextWindow: number;
  maxTokens: number;
  reasoning: readonly string[];
}
export type RuntimePin = { kind: 'codex' } | {
  kind: 'pi'; engine: '1.3.0'; schema: 1; registryDigest: string;
  catalogDigest: string; catalog: readonly PiModelDescriptor[];
};
export const CODEX_RUNTIME: RuntimePin = { kind: 'codex' };
export const PI_REGISTRY = 'rat-pi-1';

export function runtimeSelector(metadata: Agent['metadata'] | undefined | null): SessionRuntime | undefined {
  const value = metadata?.rat_things_runtime;
  if (value === undefined) return undefined;
  if (value !== 'codex' && value !== 'pi') invalid('Runtime must be codex or pi', 'metadata.rat_things_runtime');
  return value;
}

export function resolveRuntime(metadata: Agent['metadata'] | undefined | null, saved: Agent['metadata'] | undefined | null, catalog: readonly PiModelDescriptor[]): RuntimePin {
  if ((runtimeSelector(metadata) ?? runtimeSelector(saved) ?? 'codex') === 'codex') return CODEX_RUNTIME;
  if (!catalog.length) invalid('Pi Bedrock models are not configured for this deployment', 'metadata.rat_things_runtime');
  return { kind: 'pi', engine: '1.3.0', schema: 1, registryDigest: PI_REGISTRY,
    catalogDigest: createHash('sha256').update(canonicalJson(catalog)).digest('hex'), catalog: structuredClone(catalog) };
}

export function assertRuntimeUnchanged(pin: RuntimePin, metadata: Agent['metadata'] | undefined | null): void {
  const selected = runtimeSelector(metadata);
  if (selected && selected !== pin.kind) invalid('Session runtime is fixed. Create a new Session to change runtime', 'metadata.rat_things_runtime');
}

export function piModel(pin: Extract<RuntimePin, { kind: 'pi' }>, model: string): PiModelDescriptor {
  const descriptor = pin.catalog.find(entry => entry.id === model);
  if (!descriptor) invalid('Model is not in this Session’s approved Pi Bedrock catalog', 'agent.model');
  return descriptor;
}

export function validateRuntimeAgent(pin: RuntimePin, agent: AgentSession['agent'], environment?: Pick<EnvironmentParam, 'type'>): void {
  if (pin.kind === 'codex') return;
  const model = piModel(pin, agent.model);
  if (environment?.type === 'self_hosted') invalid('Pi does not support self-hosted environments', 'environment.type');
  if (agent.reasoning.effort !== null && !model.reasoning.includes(agent.reasoning.effort)) invalid('Pi model does not support this reasoning effort', 'agent.reasoning.effort');
  if (agent.reasoning.summary !== null) invalid('Pi does not support reasoning summaries', 'agent.reasoning.summary');
  if (agent.service_tier !== 'auto') invalid('Pi supports only the auto service tier', 'agent.service_tier');
  if (agent.text.verbosity !== 'medium') invalid('Pi supports only medium verbosity', 'agent.text.verbosity');
  if (agent.text.format.type !== 'text') invalid('Pi does not support JSON-schema output', 'agent.text.format');
  const names = new Set(['spawn_agent', 'send_input', 'wait_agent', 'close_agent', ...(environment?.type === 'openai_hosted' ? ['exec_command', 'read_file', 'write_file', 'list_files'] : [])]);
  for (const tool of agent.tools) {
    if (tool.type === 'function') {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(tool.name) || names.has(tool.name) || tool.name.startsWith('rat_mcp_')) invalid('Pi function names must be unique Bedrock tool identifiers and must not use reserved tool names', 'agent.tools.name');
      names.add(tool.name);
    }
    if (tool.type === 'programmatic_tool_calling' && !tool.enabled) continue;
    if (tool.type !== 'function' && tool.type !== 'mcp') invalid('Pi supports function and MCP tools', 'agent.tools');
    if (tool.type === 'function' && tool.defer_loading) invalid('Pi does not support deferred function loading', 'agent.tools.defer_loading');
  }
}

export function validateRuntimeInput(pin: RuntimePin, agent: AgentSession['agent'], input: readonly AgentSessionInputMessageParam[]): void {
  if (pin.kind !== 'pi') return;
  const model = piModel(pin, agent.model);
  for (const message of input) for (const part of message.content) {
    if (part.type === 'input_text') continue;
    if (!model.input.includes('image')) invalid('The selected Pi model does not accept images', 'input');
    if (!/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(part.image_url)) invalid('Pi images require a base64 PNG, JPEG, WebP, or GIF data URL', 'input');
  }
}
