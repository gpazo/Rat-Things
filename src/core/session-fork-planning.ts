import type { AgentSession } from '../domain/agents-api.js';
import { AgentsApiError, invalid, parseAgentsContract, validateAgentMetadata } from '../domain/agents-api-validation.js';
import { resolveHostedEnvironment } from '../domain/environment-planning.js';
import type { SessionState } from './session-ports.js';

export function requireSessionMutable(state: SessionState, now: number): void {
  if (state.closing || state.forkLock && state.forkLock.expiresAt > now) throw new AgentsApiError(409, 'Session preparation is in progress. Retry shortly.', 'session_busy');
}

export function planSessionFork(source: AgentSession, raw: unknown) {
  const input = parseAgentsContract('SessionFork', raw);
  if (source.environment.type !== 'openai_hosted') invalid('Forks require a managed environment', 'environment');
  if (source.status !== 'idle' || source.required_actions.length) throw new AgentsApiError(409, 'Only idle Sessions can be forked.', 'session_busy');
  validateAgentMetadata(input.metadata);
  const vaultIds = [...new Set(input.vault_ids ?? source.vault_ids)];
  if (vaultIds.some(id => !source.vault_ids.includes(id))) invalid('Fork vaults must be a subset of the source vaults', 'vault_ids');
  const configuration = resolveHostedEnvironment({ network: source.environment.network }, input.environment?.network ? { network: input.environment.network } : {});
  const network = configuration.network ?? source.environment.network;
  return { input: input.input, metadata: input.metadata ?? {}, vaultIds, network: { access: network.access, allowed_domains: network.allowed_domains ?? [] } };
}
