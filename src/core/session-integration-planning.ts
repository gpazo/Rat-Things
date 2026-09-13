import { createHash } from 'node:crypto';
import { canonicalJson } from '../domain/json.js';
import { AgentsApiError } from '../domain/agents-api-validation.js';
import type { SessionIntegrationInput, SessionIntegrationState, SessionIntegrationTarget } from '../domain/session-integrations.js';

export const integrationDigest = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex');
export const integrationSessionId = (bindingId: string, threadId: string): string => `sess_${integrationDigest([bindingId, threadId]).slice(0, 32)}`;

/** Arrival order is persisted by the caller's conditional write, never by queue arrival order. */
export function acceptIntegrationInput(previous: SessionIntegrationState | undefined, target: SessionIntegrationTarget, input: SessionIntegrationInput): SessionIntegrationState {
  const digest = integrationDigest(input);
  const receipt = previous?.inputs.find((entry) => entry.id === input.id);
  if (receipt) {
    if (receipt.digest !== digest) throw new AgentsApiError(409, 'This provider occurrence was already accepted with different input.', 'idempotency_conflict');
    return previous!;
  }
  return { target: previous?.target ?? structuredClone(target), inputs: [...previous?.inputs ?? [], { ...structuredClone(input), digest }] };
}
