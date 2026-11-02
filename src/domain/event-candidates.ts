import type { SessionIntegrationInput, SessionIntegrationTarget } from './session-integrations.js';

export interface EventCandidateAudit {
  act: boolean;
  reason: string;
  model: string;
  policyDigest: string;
}

export interface EventCandidate {
  bindingId: string;
  threadKey: string;
  inputDigest: string;
  target: SessionIntegrationTarget;
  input: SessionIntegrationInput;
  policies: string[];
  policyDigest: string;
  explicitVersion: number;
  state:
    | { status: 'pending' }
    | { status: 'filtering'; leaseUntil: number }
    | { status: 'decided'; decision: EventCandidateAudit }
    | { status: 'admitted'; decision: EventCandidateAudit }
    | { status: 'discarded'; decision: EventCandidateAudit };
}

export interface EventCandidateThread { explicitVersion: number }
