import type { ApiPrincipal } from '../domain/api-permissions.js';
import { AgentsApiError } from '../domain/agents-api-validation.js';
import { principalActor, requireUnexpired } from '../identity/principal.js';
import type { SpaceAuthority } from '../identity/space-access.js';
import { json, requestBody, type AgentsApiServices } from './agents-router.js';

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
      return activityStream(services.activity.follow(authority.ownerId, id, request.signal, { ...(cursor ? { after: cursor } : {}), revalidate: authority.revalidate }), request.signal, requestId, () => access.authorize(principal, authority.spaceId, ['read']));
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
function activityStream(events: AsyncIterable<{ event_id?: string; type?: string; activity?: unknown }>, signal: AbortSignal, requestId: string | undefined, authorize: () => Promise<SpaceAuthority>) {
  const iterator = events[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  let pending: ReturnType<typeof iterator.next> | undefined;
  let previousRole: string | undefined;
  return new Response(new ReadableStream({
    async pull(controller) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (signal.aborted) { controller.close(); await iterator.return?.(); return; }
        const authority = await authorize();
        pending ??= iterator.next();
        const next = await Promise.race([pending, new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 1000); })]);
        if (!next) {
          if (previousRole !== authority.role) controller.enqueue(encoder.encode(`event: rat.space.permissions\ndata: ${JSON.stringify({ type: 'rat.space.permissions', role: authority.role, permissions: authority.permissions })}\n\n`));
          else controller.enqueue(encoder.encode(': keepalive\n\n'));
          previousRole = authority.role;
          return;
        }
        pending = undefined;
        if (next.done) { controller.close(); return; }
        const current = await authorize();
        previousRole = current.role;
        const event = { ...next.value, role: current.role, permissions: current.permissions,
          ...(next.value.activity && typeof next.value.activity === 'object' ? { activity: { ...next.value.activity, role: current.role, permissions: current.permissions } } : {}) };
        controller.enqueue(encoder.encode(`${next.value.event_id ? `id: ${next.value.event_id}\n` : ''}event: ${event.type ?? 'rat.session.activity'}\ndata: ${JSON.stringify(event)}\n\n`));
      } catch (error) { controller.error(error); }
      finally { if (timer) clearTimeout(timer); }
    },
    async cancel() { await iterator.return?.(); },
  }), { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...(requestId ? { 'x-request-id': requestId } : {}) } });
}
