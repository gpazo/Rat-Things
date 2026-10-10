import type { AgentSession, AgentSessionInputMessageParam } from '../domain/agents-api.js';
import type { ExecutionBackend, RunRequest } from '../domain/contracts.js';
import type { SessionIntegrationInput } from '../domain/session-integrations.js';

export function planSessionRun(session: AgentSession, placement: ExecutionBackend, input: readonly AgentSessionInputMessageParam[], origin?: SessionIntegrationInput): RunRequest {
  const environment = session.environment;
  const networkAccess = environment.type !== 'none' && (environment.type !== 'openai_hosted' || environment.network.access === 'enabled');
  const sandbox = environment.type === 'none' ? 'read-only' : networkAccess ? 'danger-full-access' : 'workspace-write';
  return {
    version: '1', prompt: sessionMessageText(input), source: origin?.source ?? { kind: 'api' }, destinations: [{ kind: 'none' }],
    ...(origin?.repository && environment.type === 'openai_hosted' ? { repository: origin.repository } : {}),
    execution: { backend: placement, timeoutSeconds: 28_000 },
    agent: {
      driver: 'codex', sandbox,
      capabilities: { networkAccess, webSearch: session.agent.tools.find((tool) => tool.type === 'web_search')?.mode ?? 'disabled', computerUse: 'disabled' },
    },
  };
}

export function sessionMessageText(input: readonly AgentSessionInputMessageParam[]): string {
  return input.flatMap((message) => message.content.map((part) => part.type === 'input_text' ? part.text : '[Attached image]')).join('\n\n') || '[Empty user input]';
}
