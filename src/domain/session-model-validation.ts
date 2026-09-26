import type { AgentSession } from './agents-api.js';
import { invalid } from './agents-api-validation.js';
import capabilities from '../../runtime/codex/model-capabilities.json' with { type: 'json' };

/** Provider aliases do not change the capability envelope of a known model. */
export function canonicalModelName(model: string): string { return model.replace(/^openai\./, ''); }

export function validateSessionModelSettings(agent: AgentSession['agent']): void {
  const models: Record<string, { reasoning: string[] }> = capabilities.models;
  const model = models[canonicalModelName(agent.model)];
  if (!model) invalid('Model capabilities are not configured for Session updates', 'agent.model');
  if (agent.reasoning.effort !== null && !model.reasoning.includes(agent.reasoning.effort)) {
    invalid('The selected model does not support the resulting reasoning effort', 'agent.reasoning.effort');
  }
}
