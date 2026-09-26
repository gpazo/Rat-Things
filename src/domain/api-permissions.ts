import { AgentsApiError, invalid } from './agents-api-validation.js';

export const API_SCOPES = [
  'api.agents.read', 'api.agents.write', 'api.responses.write',
  'api.vaults.read', 'api.vaults.write', 'api.traces.read',
] as const;
export type ApiScope = typeof API_SCOPES[number];
export interface ApiPrincipal { readonly ownerId: string; readonly scopes: readonly ApiScope[] }

export function iamApiPrincipal(ownerId: string): ApiPrincipal { return { ownerId, scopes: [...API_SCOPES] }; }

export function parseTokenScopes(input: unknown): ApiScope[] {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) invalid('Expected a token request object');
  if (Object.keys(input).some(key => key !== 'scopes')) invalid('Only scopes may be supplied when issuing a token');
  const scopes: unknown = (input as { scopes?: unknown }).scopes;
  if (scopes === undefined) return [...API_SCOPES];
  if (!Array.isArray(scopes) || scopes.some(scope => !API_SCOPES.includes(scope))) invalid('Unknown API scope', 'scopes');
  return [...new Set(scopes)] as ApiScope[];
}

/** The caller supplies the same decoded path segments used by dispatch. */
export function requireRoutePermission(principal: ApiPrincipal, method: string, parts: string[]): void {
  if (!principal.ownerId) throw new AgentsApiError(401, 'Authentication required.', 'invalid_api_key');
  if (parts[0] !== 'v1') return;
  if (method === 'GET' && parts[1] === 'agents' && parts[2] === 'sessions' && parts[4] === 'traces' && parts.length === 5) {
    requireAnyScope(principal, ['api.traces.read', 'api.agents.read']);
    return;
  }
  if (!['agents', 'vaults', 'files', 'skills', 'webhooks'].includes(parts[1] ?? '')) return;
  const resource = parts[1] === 'vaults' ? 'vaults' : 'agents';
  requireAnyScope(principal, [`api.${resource}.${method === 'GET' ? 'read' : 'write'}`]);
}

export function requireInferencePermission(principal: ApiPrincipal, input: unknown, operation: 'create' | 'events'): void {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return;
  const body = input as { input?: unknown; events?: unknown };
  const inference = operation === 'create'
    ? typeof body.input === 'string' || Array.isArray(body.input) && body.input.length > 0
    : Array.isArray(body.events) && body.events.some(event => event?.type === 'agent.session.input.message' || event?.type === 'agent.session.input.tool_result');
  if (inference) requireAnyScope(principal, ['api.responses.write']);
}

function requireAnyScope(principal: ApiPrincipal, scopes: readonly ApiScope[]): void {
  if (!scopes.some(scope => principal.scopes.includes(scope))) {
    throw new AgentsApiError(403, `Requires ${scopes.join(' or ')}.`, 'insufficient_permissions');
  }
}
