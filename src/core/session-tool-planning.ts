import type { AgentSession, AgentToolParam } from '../domain/agents-api.js';
import { invalid } from '../domain/agents-api-validation.js';
import { canonicalJson } from '../domain/json.js';
import type { SessionEnvironmentCredentialBinding, SessionMcpBinding } from '../domain/session-execution.js';

/** Validate and separate confidential transports before any credential access. */
export function planSessionToolTransports(agent: AgentSession['agent'], tools: AgentToolParam[]) {
  return tools.flatMap((tool) => {
    if (tool.type !== 'mcp') return [];
    const resolved = agent.tools.find((candidate) => candidate.type === 'mcp' && candidate.server_label === tool.server_label);
    if (!resolved || resolved.type !== 'mcp') throw new Error('MCP configuration does not match the session');
    const headers = tool.transport.type === 'http' ? { ...tool.transport.headers, ...(tool.transport.authorization != null ? { Authorization: tool.transport.authorization } : {}) } : {};
    const env = tool.transport.type === 'stdio' ? { ...tool.transport.env } : {};
    if (Object.keys(headers).filter((name) => name.toLowerCase() === 'authorization').length > 1) invalid('MCP authorization must have exactly one source', 'agent.tools.transport');
    if (Buffer.byteLength(JSON.stringify({ headers, env })) > 60_000) invalid('MCP credentials exceed the secret size limit', 'agent.tools.transport');
    if (tool.transport.type === 'stdio' && resolved.connection_origin !== 'environment') invalid('Stdio MCP servers require an execution environment', 'agent.tools.connection_origin');
    return [{ serverLabel: tool.server_label, resolved, headers, env }];
  });
}

/** A committed winner fences later creates; revoke only this attempt's unadopted refs. */
export function planSessionToolCommitRecovery(attempt: SessionMcpBinding[], committed: SessionMcpBinding[], attemptEnvironment?: SessionEnvironmentCredentialBinding, committedEnvironment?: SessionEnvironmentCredentialBinding) {
  const retained = new Set([...committed.flatMap((binding) => binding.inlineReference ? [binding.inlineReference] : []), ...committedEnvironment?.references ?? []]);
  const references = [...attempt.flatMap(binding => binding.inlineReference ? [binding.inlineReference] : []), ...attemptEnvironment?.references ?? []];
  return {
    adopted: canonicalJson([attempt, attemptEnvironment ?? null]) === canonicalJson([committed, committedEnvironment ?? null]),
    revoke: [...new Set(references.filter(reference => !retained.has(reference)))],
  };
}

/** The attempt revision fences adoption against cleanup, independently of time. */
export interface SessionToolAttempt {
  sessionId: string;
  bindings: SessionMcpBinding[];
  environment?: SessionEnvironmentCredentialBinding;
  status: 'pending' | 'adopted' | 'cleanup';
  deadline: number;
}

export function planSessionToolReconciliation(attempt: SessionToolAttempt, now: number, abandon: boolean) {
  if (attempt.status === 'adopted') return { type: 'adopted' as const };
  if (attempt.status === 'pending' && !abandon && now < attempt.deadline) return { type: 'wait' as const, retryAfterSeconds: attempt.deadline - now };
  return { type: 'cleanup' as const };
}
