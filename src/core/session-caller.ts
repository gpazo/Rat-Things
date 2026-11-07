import type { AgentObservation } from './agents-ports.js';
import { AgentsApiError } from '../domain/agents-api-validation.js';

export interface SessionActor {
  id: string;
  kind: 'human' | 'workload' | 'operator' | 'local';
  issuer?: string;
  subject?: string;
  label?: string;
}
export interface SessionCaller {
  actor: SessionActor;
  readonly admission?: unknown;
  observations?: AgentObservation[];
  expiresAt?: number;
  revalidate?: () => Promise<void>;
  permissions?: string[];
}
export async function validateSessionCaller(caller?: SessionCaller): Promise<void> {
  await caller?.revalidate?.();
  if (caller?.expiresAt !== undefined && caller.expiresAt <= Date.now()) throw new AgentsApiError(401, 'Authentication expired.', 'unauthorized');
}
