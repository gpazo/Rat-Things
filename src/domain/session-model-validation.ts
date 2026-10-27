import type { AgentSession } from './agents-api.js';
import { invalid } from './agents-api-validation.js';
import capabilities from '../../runtime/codex/model-capabilities.json' with { type: 'json' };

/** Provider aliases do not change the capability envelope of a known model. */
export function canonicalModelName(model: string): string { return model.replace(/^openai\./, ''); }

export type NativeServiceTier = 'default' | 'priority' | 'flex';

/** An explicit standard tier clears a prior per-thread tier in the official protocol. */
export function nativeServiceTier(tier: string | undefined): NativeServiceTier {
  if (tier === undefined || tier === 'auto' || tier === 'default') return 'default';
  if (tier === 'fast' || tier === 'priority') return 'priority';
  if (tier === 'flex') return 'flex';
  return invalid('The selected service tier is not supported by Codex', 'agent.service_tier');
}

/** Admit explicit tiers using the running provider's model/list, never another provider's catalog. */
export function admitNativeServiceTier(tier: string | undefined, capability: {
  model: string | undefined;
  provider: string;
  models: unknown;
}): NativeServiceTier {
  const resolved = nativeServiceTier(tier);
  if (resolved === 'default') return resolved;
  const model = typeof capability.model === 'string' && capability.model.length > 0 && Array.isArray(capability.models) ? capability.models.find((entry: unknown) => record(entry)
    && (entry.model === capability.model || entry.id === capability.model)) : undefined;
  if (!record(model) || !Array.isArray(model.serviceTiers)) {
    return invalid('The selected model has no verified service-tier capabilities', 'agent.service_tier');
  }
  // Stock Codex accepts flex for catalog models on Responses providers. Bedrock
  // additionally requires the tier to be advertised by its provider catalog.
  if (resolved === 'flex' && capability.provider !== 'amazon-bedrock') return resolved;
  if (model.serviceTiers.some((entry: unknown) => record(entry) && entry.id === resolved)) return resolved;
  return invalid('The selected model and provider do not support this service tier', 'agent.service_tier');
}

export function validateSessionModelSettings(agent: AgentSession['agent']): void {
  const models: Record<string, { reasoning: string[] }> = capabilities.models;
  const model = models[canonicalModelName(agent.model)];
  if (!model) invalid('Model capabilities are not configured for Session updates', 'agent.model');
  if (agent.reasoning.effort !== null && !model.reasoning.includes(agent.reasoning.effort)) {
    invalid('The selected model does not support the resulting reasoning effort', 'agent.reasoning.effort');
  }
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
