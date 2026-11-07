import { createHash } from 'node:crypto';
import type { ApiActor, ApiPrincipal } from '../domain/api-permissions.js';
import { AgentsApiError } from '../domain/agents-api-validation.js';

export function oidcActorId(issuer: string, subject: string): string {
  return `actor_${createHash('sha256').update(JSON.stringify([issuer, subject])).digest('hex')}`;
}
export function principalActor(principal: ApiPrincipal): ApiActor {
  return principal.actor ?? { id: principal.ownerId, kind: 'operator' };
}
export function requireUnexpired(principal: { expiresAt?: number }, now = Date.now()): void {
  if (principal.expiresAt !== undefined && principal.expiresAt <= now) throw new AgentsApiError(401, 'Authentication or membership expired.', 'invalid_api_key');
}
