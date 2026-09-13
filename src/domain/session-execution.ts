import type { AgentSession, AgentSessionInputMessageParam, AgentSessionItem } from './agents-api.js';

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
