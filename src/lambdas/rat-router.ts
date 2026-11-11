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
  if (collection === 'sessions' && id && parts.length === 5 && method === 'POST' && services.sessions) {
    if (child === 'typing') {
      await services.sessions.collaboration.typing(authority.ownerId, id, await requestBody(request), authority);
      return new Response(null, { status: 204 });
    }
    if (child === 'messages') {
      await services.sessions.message(authority.ownerId, id, await requestBody(request), authority, request.headers.get('idempotency-key') ?? undefined);
      return new Response(null, { status: 204 });
    }
  }
  if (collection === 'sessions' && id && child === 'activity' && services.activity) {
    if (parts.length === 5 && method === 'GET') return json(200, { ...await services.activity.snapshot(authority.ownerId, id, authority) as object, role: authority.role, permissions: authority.permissions }, requestId);
    if (parts.length === 6 && childId === 'events' && method === 'GET') {
      const cursor = request.headers.get('last-event-id') ?? new URL(request.url).searchParams.get('after') ?? undefined;
      return activityStream(signal => services.activity!.follow(authority.ownerId, id, signal, { ...(cursor ? { after: cursor } : {}) }), request.signal, requestId, () => access.authorize(principal, authority.spaceId, ['read']));
    }
  }
  if (collection === 'sessions' && id && child === 'workspace' && services.sessions) {
    return workspaceRoute(request, authority.ownerId, id, parts.slice(5), services.sessions, authority, requestId);
  }
  if (collection === 'shares' && services.shares) {
    if (parts.length === 3 && method === 'POST') return json(201, await services.shares.stage(authority.ownerId, await requestBody(request), authority), requestId);
    if (parts.length === 4 && id && method === 'GET') return json(200, await services.shares.retrieve(authority.ownerId, id), requestId);
    if (parts.length === 4 && id && method === 'DELETE') return json(200, await services.shares.abort(authority.ownerId, id, await requestBody(request), authority), requestId);
    if (parts.length === 5 && id && child === 'activate' && method === 'POST') return json(200, await services.shares.activate(authority.ownerId, id, await requestBody(request), authority), requestId);
  }
  throw new AgentsApiError(404, 'Route not found.', 'resource_not_found');
}

export async function workspaceRoute(request: Request, owner: string, id: string, parts: string[], sessions: import('../core/session-service.js').SessionService, caller: import('../core/session-caller.js').SessionCaller, requestId?: string): Promise<Response> {
  if (parts.length === 1 && parts[0] === 'browser' && request.method === 'GET') return json(200, await sessions.browserFrame(owner, id, caller), requestId);
  if (parts.length === 3 && parts[0] === 'threads' && parts[1] && parts[2] === 'image' && request.method === 'GET') {
    const image = await sessions.workspaceThreadImage(owner, id, parts[1], caller);
    return new Response(image.bytes, { status: 200, headers: { 'content-type': image.contentType, 'cache-control': 'private, no-store' } });
  }
  if (request.method === 'POST') {
    const body = await requestBody(request);
    const key = request.headers.get('idempotency-key') ?? undefined;
    if (parts.length === 1 && parts[0] === 'feedback') { await sessions.workspaceFeedback(owner, id, body, caller, key); return new Response(null, { status: 204 }); }
    if (parts.length === 1 && parts[0] === 'browser') return json(200, await sessions.browserAction(owner, id, body, caller, key), requestId);
    if (parts.length === 2 && parts[0] === 'browser' && parts[1] === 'capture') return json(200, await sessions.captureBrowser(owner, id, body, caller), requestId);
  }
  throw new AgentsApiError(404, 'Route not found.', 'resource_not_found');
}
