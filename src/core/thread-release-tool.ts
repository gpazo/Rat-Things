import type { AgentSession } from '../domain/agents-api.js';
import { AgentsApiError } from '../domain/agents-api-validation.js';

export const THREAD_RELEASE_TOOL = {
  type: 'function' as const,
  name: 'rat_things_thread_release',
  description: 'Release this Session from its current provider thread. The current Turn can still deliver its reply. Future events start a new Session.',
  parameters: { type: 'object', properties: { reason: { type: 'string', minLength: 1, maxLength: 1024 } }, required: ['reason'], additionalProperties: false },
  strict: true,
  defer_loading: false,
};

export function withThreadReleaseTool(agent: AgentSession['agent']): AgentSession['agent'] {
  if (agent.tools.some(tool => tool.type === 'function' && tool.name === THREAD_RELEASE_TOOL.name)) throw new AgentsApiError(400, 'The Agent uses a reserved thread tool name.', 'invalid_request', 'agent.tools');
  return { ...agent, tools: [...agent.tools, THREAD_RELEASE_TOOL] };
}

export function parseThreadRelease(raw: unknown): { reason: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || Object.keys(raw).some(key => key !== 'reason') || !('reason' in raw) || typeof raw.reason !== 'string' || !raw.reason.trim() || raw.reason.length > 1024) {
    throw new AgentsApiError(400, 'A thread release requires a reason of 1–1024 characters.', 'invalid_request', 'reason');
  }
  return { reason: raw.reason };
}
