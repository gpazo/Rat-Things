import type { AgentSession, AgentSessionInputMessageParam, AgentSessionItem } from './agents-api.js';
import { parseAgentsContract } from './agents-api-validation.js';

/** Settings captured when a Turn is accepted, unaffected by later Session updates. */
export type SessionModelSettings = Pick<AgentSession['agent'], 'model' | 'service_tier'> & {
  reasoning: Pick<AgentSession['agent']['reasoning'], 'effort'>;
};

export function parseSessionModelSettings(value: unknown): SessionModelSettings {
  const settings = parseAgentsContract('SessionUpdate', { agent: value }).agent;
  const model = settings?.model;
  const tier = settings?.service_tier;
  const effort = settings?.reasoning?.effort;
  if (!model?.trim() || tier == null || effort === undefined) throw new Error('Complete Session model settings are required');
  return { model, service_tier: tier, reasoning: { effort } };
}

/** Immutable, confidential execution input in the owner's encrypted artifact namespace. */
export interface SessionLaunch {
  sessionId: string;
  turnId: string;
  turn?: import('./agents-api.js').Turn;
  agent: AgentSession['agent'];
  environment: AgentSession['environment'];
  input: AgentSessionInputMessageParam[];
  /** A Secrets Manager reference, never the connection key itself. */
  environmentCredential?: string;
  history?: AgentSessionItem[];
  mcp?: SessionMcpBinding[];
  hostedConfiguration?: import('./environment-planning.js').HostedEnvironmentConfiguration;
  hostedFiles?: Array<{ path: string; content: import('./contracts.js').ArtifactReference }>;
  hostedSkills?: Array<{ name: string; description: string; content: import('./contracts.js').ArtifactReference }>;
}

export interface SessionMcpBinding {
  serverLabel: string;
  inlineReference?: string;
  vaultReference?: string;
  vaultId?: string;
  credentialId?: string;
}
