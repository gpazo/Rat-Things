import type { EnvironmentParam, Turn, AgentSessionItem } from './agents-api.js';
import type { RunRequest, RunSource, RunDestination, RunActorContext, RunCredentialSubjectContext } from './contracts.js';

/** Application integration settings reference the canonical reusable resources. */
export interface SessionIntegrationTarget {
  agentId: string;
  environment: EnvironmentParam;
  vaultIds?: string[];
  destinations?: RunDestination[];
  /** Delivery credentials only. Agent tools are declared on the Agent. */
  connectionSetId?: string;
}
export interface SessionIntegrationInput {
  id: string;
  text: string;
  source: RunSource;
  actor: RunActorContext;
  credentialSubject: RunCredentialSubjectContext;
  repository?: RunRequest['repository'];
}
export interface SessionIntegrationReceipt extends SessionIntegrationInput {
  digest: string;
  turnId?: string;
  deliveryProcessed?: boolean;
}
export interface SessionIntegrationState {
  target: SessionIntegrationTarget;
  inputs: SessionIntegrationReceipt[];
}
export interface SessionDelivery {
  ownerId: string;
  sessionId: string;
  turn: Turn;
  items: AgentSessionItem[];
  source: RunSource;
  destinations?: RunDestination[];
  connectionSetId?: string;
}
