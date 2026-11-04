import type { ConfigurationRevisionRef } from './configuration-history.js';
import type { RunActorContext, RunCredentialSubjectContext } from './contracts.js';

export interface ServiceMcpPolicy {
  serverLabel: string;
  destinationDigest: string;
  allowedTools: string[] | null;
}

export type McpCredentialEvidence =
  | { kind: 'vault'; vault: ConfigurationRevisionRef; credential: ConfigurationRevisionRef; checkedAt: number; destinationDigest: string }
  | { kind: 'inline_snapshot' }
  | { kind: 'none' }
  | { kind: 'unavailable' };

export interface McpAuthorization {
  /** Trusted transport only. Never serialize this value into an audit record. */
  authorization: string;
  evidence: McpCredentialEvidence;
}

export interface ToolExecutionIdentity {
  sessionId: string;
  agentId: string;
  runId: string;
  generation: string;
  runtimeEpoch: number;
  actor?: RunActorContext;
  credentialSubject?: RunCredentialSubjectContext;
}

/** Context is useful for investigation, but is not proof of a native tool-item match. */
export type ToolTurnContext =
  | { kind: 'single_active_turn'; turnId: string }
  | { kind: 'unresolved'; reason: 'unavailable' | 'no_active_turn' | 'multiple_active_turns' };

export type ToolDenialReason = 'tool_not_admitted' | 'invalid_call' | 'batch_denied' | 'credential_unavailable' | 'execution_inactive';

export interface ToolAuthorizationDecision {
  id: string;
  object: 'rat_things.tool_authorization';
  requestId: string;
  attempt: number;
  at: number;
  identity: ToolExecutionIdentity;
  configuration: ConfigurationRevisionRef | null;
  context: ToolTurnContext;
  policy: ServiceMcpPolicy;
  policyDigest: string;
  toolName: string;
  credential: McpCredentialEvidence;
  decision: 'allow' | 'deny';
  reason?: ToolDenialReason;
}

export type ToolDispatchOutcome =
  | { kind: 'not_dispatched'; at: number }
  | { kind: 'response_received'; at: number; httpStatus: number; toolResult: 'unobserved' | 'success' | 'error' }
  | { kind: 'unknown'; at: number; reason: 'transport_failure' | 'cancelled' | 'response_interrupted' };

export interface ToolAuthorizationReceipt extends ToolAuthorizationDecision {
  outcome: ToolDispatchOutcome | { kind: 'unknown'; reason: 'no_observation' };
}
