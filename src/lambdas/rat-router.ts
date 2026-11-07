import type { ApiPrincipal } from '../domain/api-permissions.js';
import { AgentsApiError } from '../domain/agents-api-validation.js';
import { principalActor, requireUnexpired } from '../identity/principal.js';
import type { SpaceAuthority } from '../identity/space-access.js';
import { json, requestBody, type AgentsApiServices } from './agents-router.js';
import { activityStream } from './activity-stream.js';

export async function routeRatRequest(request: Request, principal: ApiPrincipal, parts: string[], services: AgentsApiServices, authority?: SpaceAuthority, requestId?: string): Promise<Response> {
  const method = request.method;
  const [collection, id, child, childId] = parts.slice(2);
  requireUnexpired(principal);
  if (collection === 'me' && parts.length === 3 && method === 'GET') return json(200, { actor: principalActor(principal), scopes: principal.scopes, expires_at: principal.expiresAt === undefined ? null : principal.expiresAt / 1000 }, requestId);
  const access = services.access;
  if (!access) throw new AgentsApiError(503, 'Spaces are unavailable.', 'service_unavailable');
  if (collection === 'spaces' && parts.length === 3) {
    if (method === 'GET') return json(200, await access.list(principal), requestId);
    if (method === 'POST') return json(201, await access.bootstrap(principal, await requestBody(request)), requestId);
  }
  if (!authority) throw new AgentsApiError(403, 'Select an authorized space.', 'insufficient_permissions');
  if (collection === 'spaces' && id === authority.spaceId && child === 'bindings') {
    if (parts.length === 5 && method === 'GET') return json(200, await access.bindings(authority), requestId);
    if (parts.length === 5 && (method === 'POST' || method === 'PUT')) return json(200, await access.bind(authority, await requestBody(request)), requestId);
    if (parts.length === 6 && childId && method === 'DELETE') return json(200, await access.revoke(authority, childId), requestId);
  }
  if (collection === 'spaces' && id === authority.spaceId && child === 'execution-roles' && services.admission) {
    if (parts.length === 5 && method === 'GET') return json(200, await services.admission.roles(authority), requestId);
    if (parts.length === 6 && childId && (method === 'POST' || method === 'PUT')) return json(200, await services.admission.setRole(authority, childId, await requestBody(request)), requestId);
  }
  if (collection === 'agents' && id && child === 'workload' && parts.length === 5 && services.admission) {
    if (method === 'GET') return json(200, await services.admission.assignment(authority, id), requestId);
    if (method === 'POST' || method === 'PUT') return json(200, await services.admission.assign(authority, id, await requestBody(request)), requestId);
  }
  if (collection === 'sessions' && id && child === 'activity' && services.activity) {
    if (parts.length === 5 && method === 'GET') return json(200, { ...await services.activity.snapshot(authority.ownerId, id, authority) as object, role: authority.role, permissions: authority.permissions }, requestId);
    if (parts.length === 6 && childId === 'events' && method === 'GET') {
      const cursor = request.headers.get('last-event-id') ?? new URL(request.url).searchParams.get('after') ?? undefined;
      return activityStream(signal => services.activity!.follow(authority.ownerId, id, signal, { ...(cursor ? { after: cursor } : {}) }), request.signal, requestId, () => access.authorize(principal, authority.spaceId, ['read']));
    }
  }
  if (collection === 'shares' && services.shares) {
    if (parts.length === 3 && method === 'POST') return json(201, await services.shares.stage(authority.ownerId, await requestBody(request), authority), requestId);
    if (parts.length === 4 && id && method === 'GET') return json(200, await services.shares.retrieve(authority.ownerId, id), requestId);
    if (parts.length === 4 && id && method === 'DELETE') return json(200, await services.shares.abort(authority.ownerId, id, await requestBody(request), authority), requestId);
    if (parts.length === 5 && id && child === 'activate' && method === 'POST') return json(200, await services.shares.activate(authority.ownerId, id, await requestBody(request), authority), requestId);
  }
  throw new AgentsApiError(404, 'Route not found.', 'resource_not_found');
}
