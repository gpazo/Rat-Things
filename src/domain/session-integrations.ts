import type { EnvironmentParam, Turn, AgentSessionItem } from './agents-api.js';
import type { RunRequest, RunSource, RunDestination, RunActorContext, RunCredentialSubjectContext } from './contracts.js';

/** Application integration settings reference the canonical reusable resources. */
export interface SessionIntegrationTarget {
  runtime?: import('./session-runtime.js').SessionRuntime;
  runtimePin?: import('./session-runtime.js').RuntimePin;
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
  repositoryHeadChanged?: boolean;
}
export interface SessionIntegrationReceipt extends SessionIntegrationInput {
  digest: string;
  turnId?: string;
  deliveryProcessed?: boolean;
}
export interface SessionIntegrationState {
  target: SessionIntegrationTarget;
  threadSubscriptionId?: string;
  threadKey?: string;
  epoch?: number;
  previousSessionId?: string;
  supersededBy?: string;
  threadReleased?: { reason: string };
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

export interface ThreadSubscription {
  bindingId: string;
  threadKey: string;
  epoch: number;
  subscribers: Array<{ sessionId: string; state: 'active' | 'released'; reason?: string }>;
}

export interface IntegrationOccurrence {
  digest: string;
  sessionId: string;
  epoch: number;
}
