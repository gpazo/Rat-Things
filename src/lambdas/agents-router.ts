import type { SpaceAccessService, SpaceAuthority } from '../identity/space-access.js';
import type { WorkloadAdmissionService } from '../identity/workload-admission.js';
import type { GuardedAgentsStore } from '../identity/guarded-agents-store.js';
import { principalActor, requireUnexpired } from '../identity/principal.js';
import { routeRatRequest, workspaceRoute } from './rat-router.js';
import { requireRoutePermission, requireInferencePermission, routeActions, type ApiPrincipal } from '../domain/api-permissions.js';
import type { AgentService } from '../core/agent-service.js';
import type { SessionService } from '../core/session-service.js';
import type { VaultService } from '../core/vault-service.js';
import type { EnvironmentTemplateService } from '../core/environment-template-service.js';
import type { EnvironmentService } from '../core/environment-service.js';
import { AgentsApiError } from '../domain/agents-api-validation.js';
import { routeUploadedFiles, routeSkills } from './agents-files-router.js';
import type { FileService } from '../core/file-service.js';
import type { SkillService } from '../core/skill-service.js';
import type { WebhookService } from '../core/webhook-service.js';
import type { ModelCatalog } from '../core/model-catalog.js';
import { routeAgentsAudit, type AgentsAuditServices } from './agents-audit-router.js';

/** The caller authenticates once and supplies its derived owner, never a body field. */
export async function routeAgentRequest(
  request: Request,
  principal: ApiPrincipal,
  agents: AgentService,
  requestId?: string,
): Promise<Response> {
  return routeAgentsRequest(request, principal, { agents }, requestId);
}

export interface AgentsApiServices extends AgentsAuditServices {
  agents: AgentService;
  access?: SpaceAccessService;
  admission?: WorkloadAdmissionService;
  guardedStore?: GuardedAgentsStore;
  activity?: {
    snapshot(ownerId: string, id: string, caller: SpaceAuthority): Promise<unknown>;
    follow(ownerId: string, id: string, signal: AbortSignal, options: { after?: string; revalidate?: () => Promise<void> }): AsyncIterable<{ event_id?: string; type?: string; activity?: unknown }>;
  };
  shares?: {
    stage(ownerId: string, raw: unknown, caller: SpaceAuthority): Promise<unknown>;
    retrieve(ownerId: string, id: string): Promise<unknown>;
    activate(ownerId: string, id: string, raw: unknown, caller: SpaceAuthority): Promise<unknown>;
    abort(ownerId: string, id: string, raw: unknown, caller: SpaceAuthority): Promise<unknown>;
  };
  sessions?: SessionService;
  vaults?: VaultService;
  templates?: EnvironmentTemplateService;
  environments?: EnvironmentService;
  files?: FileService;
  skills?: SkillService;
  webhooks?: WebhookService;
  models?: ModelCatalog | undefined;
  piModels?: ModelCatalog | undefined;
}

export async function routeAgentsRequest(request: Request, principal: ApiPrincipal, services: AgentsApiServices, requestId?: string, streaming = true): Promise<Response> {
  try {
    requireUnexpired(principal);
    const parts = pathParts(new URL(request.url).pathname);
    // Redeeming an invite creates the membership, so it cannot require a selected space.
    const noSpace = parts[1] === 'rat' && (parts.length === 3 && ['me', 'spaces'].includes(parts[2] ?? '') || parts.length === 4 && parts[2] === 'invites' && parts[3] === 'redeem');
    if (noSpace) return await routeRatRequest(request, principal, parts, services, undefined, requestId);
    if (principal.authentication !== 'oidc') return dispatchAgentsRequest(request, principal, services, requestId, streaming);
    const selector = request.headers.get('x-rat-space');
    if (!selector || !/^space_[A-Za-z0-9_-]{1,128}$/.test(selector) || !services.access || !services.guardedStore) throw new AgentsApiError(403, 'Select an authorized space.', 'insufficient_permissions');
    if (parts[1] === 'rat' && parts[2] === 'spaces' && parts[3] !== selector) throw new AgentsApiError(403, 'Space selector does not match the resource.', 'insufficient_permissions');
    const body = request.method === 'POST' && parts[1] === 'agents' && parts[2] === 'sessions' ? await requestBody(request.clone()) : undefined;
    const actions = routeActions(request.method, parts, body);
    const authority = await services.access.authorize(principal, selector, actions);
    const scoped = { ...principal, ownerId: authority.ownerId, actor: authority.actor };
    requireRoutePermission(scoped, request.method, parts);
    const dispatch = () => parts[1] === 'rat' ? routeRatRequest(request, scoped, parts, services, authority, requestId)
      : dispatchAgentsRequest(request, scoped, services, requestId, streaming, authority);
    const explicitAcceptance = request.method === 'POST' && (parts[1] === 'rat' && (parts[2] === 'shares' || parts[2] === 'sessions' && parts[4] === 'messages') || parts[1] === 'agents' && parts[2] === 'sessions' && (parts.length === 3 || parts.length === 5 && ['events', 'fork'].includes(parts[4] ?? '')));
    if (parts[1] === 'agents' && parts[2] === 'sessions' && parts[3] === 'import' && request.method === 'POST') throw new AgentsApiError(403, 'Use Share to admit a Session to a space.', 'insufficient_permissions');
    const readOnly = request.method === 'GET';
    if (!readOnly && !explicitAcceptance && parts[1] !== 'rat') await services.access.accept(authority, actions, parts.join('/'));
    const response = explicitAcceptance || !readOnly && parts[1] !== 'rat' ? await dispatch() : await services.guardedStore.run(authority, readOnly, dispatch);
    await authority.revalidate();
    // Activity owns per-frame and idle authorization, including producer cancellation.
    // Wrapping it again duplicates storage reads and obscures its terminal state.
    if (request.method === 'GET' && parts.length === 6 && parts[1] === 'rat' && parts[2] === 'sessions' && parts[4] === 'activity' && parts[5] === 'events') return response;
    return reauthorizedResponse(response, authority, request.signal);
  } catch (error) { return agentsErrorResponse(error, requestId); }
}

async function dispatchAgentsRequest(request: Request, principal: ApiPrincipal, services: AgentsApiServices, requestId?: string, streaming = true, authority?: SpaceAuthority): Promise<Response> {
  try {
    const ownerId = principal.ownerId;
    const url = new URL(request.url);
    const parts = pathParts(url.pathname);
    requireRoutePermission(principal, request.method, parts);
    if (parts[0] !== 'v1') throw new AgentsApiError(404, 'Route not found.', 'resource_not_found');
    if (principal.authentication !== 'oidc' && parts[1] === 'rat' && parts[2] === 'sessions' && parts[3] && parts[4] === 'workspace' && services.sessions) {
      requireRoutePermission(principal, request.method, ['v1', 'agents', 'sessions', parts[3], 'events']);
      if (request.method === 'POST') requireInferencePermission(principal, { input: 'message' }, 'create');
      return await workspaceRoute(request, ownerId, parts[3], parts.slice(5), services.sessions, { actor: principalActor(principal), ...(principal.expiresAt !== undefined ? { expiresAt: principal.expiresAt } : {}) }, requestId);
    }
    // Local single-player uses the same reply representation and authenticated input path.
    if (principal.authentication !== 'oidc' && parts[1] === 'rat' && parts[2] === 'sessions' && parts[3] && parts.length === 5 && services.sessions) {
      requireRoutePermission(principal, request.method, ['v1', 'agents', 'sessions', parts[3], 'events']);
      const caller = { actor: principalActor(principal), ...(principal.expiresAt !== undefined ? { expiresAt: principal.expiresAt } : {}) };
      if (request.method === 'POST' && parts[4] === 'messages') {
        requireInferencePermission(principal, { input: 'message' }, 'create');
        await services.sessions.message(ownerId, parts[3], await requestBody(request), caller, request.headers.get('idempotency-key') ?? undefined);
        return new Response(null, { status: 204 });
      }
      if (request.method === 'GET' && parts[4] === 'activity') return json(200, await services.sessions.activity(ownerId, parts[3], caller), requestId);
    }

    const audit = await routeAgentsAudit(request, ownerId, parts, services);
    if (audit !== undefined) return json(200, audit, requestId);
    if (parts[1] === 'models' || parts[1] === 'agents' && parts[2] === 'models') {
      const runtime = url.searchParams.get('runtime');
      if (runtime !== null && runtime !== 'codex' && runtime !== 'pi') throw new AgentsApiError(400, 'Runtime must be codex or pi.', 'invalid_request', 'runtime');
      return routeModels(request, parts.slice(parts[1] === 'models' ? 2 : 3), runtime === 'pi' ? services.piModels : services.models, requestId);
    }
    if (parts[1] === 'webhooks') return await routeWebhook(request, ownerId, parts.slice(2), services.webhooks, requestId);
    if (parts[1] === 'files') return await routeUploadedFiles(request, ownerId, parts.slice(2), services.files, requestId);
    if (parts[1] === 'skills') return await routeSkills(request, ownerId, parts.slice(2), services.skills, requestId);
    if (parts[1] === 'agents' && parts[2] === 'environments' && parts[3] === 'templates') return await routeTemplate(request, ownerId, parts.slice(4), services.templates, requestId);
    if (parts[1] === 'agents' && parts[2] === 'environments' && parts[3] && parts.length === 4 && request.method === 'GET') {
      if (!services.environments) throw new AgentsApiError(503, 'Environment service is unavailable.', 'service_unavailable');
      return json(200, await services.environments.retrieve(ownerId, parts[3]), requestId);
    }
    if (parts[1] === 'agents' && parts[2] === 'environments' && parts[3] && parts[4] === 'files' && parts.length === 5) {
      if (!services.environments) throw new AgentsApiError(503, 'Environment service is unavailable.', 'service_unavailable');
      if (request.method === 'GET') return json(200, await services.environments.files(ownerId, parts[3], queryParameters(url.searchParams, { nullableLimit: true })), requestId);
      if (request.method === 'POST') return json(200, await services.environments.createFile(ownerId, parts[3], await requestBody(request)), requestId);
    }
    if (parts[1] === 'vaults') return await routeVault(request, ownerId, parts.slice(2), services.vaults, requestId, principal);
    if (parts[1] === 'agents' && parts[2] === 'sessions') return await routeSession(request, principal, parts.slice(3), services.sessions, requestId, streaming, authority, services.admission);
    const route = /^\/v1\/agents(?:\/([^/]+))?$/.exec(url.pathname);
    if (!route) throw new AgentsApiError(404, 'Route not found.', 'resource_not_found');
    const id = parts[2];
    const method = request.method;
    const { agents } = services;
    if (method === 'GET' && !id) {
      return json(200, await agents.list(ownerId, queryParameters(url.searchParams, { nullableLimit: true })), requestId);
    }
    if (method === 'POST' && !id) {
      return json(200, await agents.create(ownerId, await requestBody(request), mutation(principal, requestId)), requestId);
    }
    if (method === 'GET' && id) return json(200, await agents.retrieve(ownerId, id), requestId);
    if (method === 'POST' && id) return json(200, await agents.update(ownerId, id, await requestBody(request), mutation(principal, requestId)), requestId);
    if (method === 'DELETE' && id) return json(200, await agents.delete(ownerId, id, mutation(principal, requestId)), requestId);
    throw new AgentsApiError(405, 'Method not allowed.', 'method_not_allowed');
  } catch (error) {
    return agentsErrorResponse(error, requestId);
  }
}

function routeModels(request: Request, parts: string[], models: ModelCatalog | undefined, requestId?: string): Response {
  if (parts.length > 0) throw new AgentsApiError(404, 'Route not found.', 'resource_not_found');
  if (request.method !== 'GET') throw new AgentsApiError(405, 'Method not allowed.', 'method_not_allowed');
  if (!models || models.data.length === 0) throw new AgentsApiError(503, 'Model catalog is unavailable.', 'service_unavailable');
  return json(200, models, requestId);
}

/** Endpoint administration is operator-owned; delivered events use the standard contract. */
async function routeWebhook(request: Request, owner: string, parts: string[], service: WebhookService | undefined, requestId?: string): Promise<Response> {
  if (!service) throw new AgentsApiError(503, 'Webhook service is unavailable.', 'service_unavailable');
  const [id, action] = parts;
  if (!id && request.method === 'GET') return json(200, await service.list(owner), requestId);
  if (!id && request.method === 'POST') return json(201, await service.create(owner, await requestBody(request)), requestId);
  if (id && parts.length === 1) {
    if (request.method === 'GET') return json(200, await service.retrieve(owner, id), requestId);
    if (request.method === 'POST') return json(200, await service.update(owner, id, await requestBody(request)), requestId);
    if (request.method === 'DELETE') return json(200, await service.delete(owner, id), requestId);
  }
  if (id && action === 'rotate-secret' && parts.length === 2 && request.method === 'POST') return json(200, await service.rotate(owner, id), requestId);
  throw new AgentsApiError(404, 'Route not found.', 'resource_not_found');
}

async function routeTemplate(request: Request, ownerId: string, parts: string[], templates: EnvironmentTemplateService | undefined, requestId?: string): Promise<Response> {
  if (!templates) throw new AgentsApiError(503, 'Environment template service is unavailable.', 'service_unavailable');
  const [id] = parts;
  if (parts.length > 1) throw new AgentsApiError(404, 'Route not found.', 'resource_not_found');
  if (request.method === 'GET' && !id) return json(200, await templates.list(ownerId, queryParameters(new URL(request.url).searchParams)), requestId);
  if (request.method === 'POST' && !id) return json(200, await templates.create(ownerId, await requestBody(request)), requestId);
  if (request.method === 'GET' && id) return json(200, await templates.retrieve(ownerId, id), requestId);
  if (request.method === 'POST' && id) return json(200, await templates.update(ownerId, id, await requestBody(request)), requestId);
  if (request.method === 'DELETE' && id) return json(200, await templates.delete(ownerId, id), requestId);
  throw new AgentsApiError(405, 'Method not allowed.', 'method_not_allowed');
}

async function routeVault(request: Request, ownerId: string, parts: string[], vaults: VaultService | undefined, requestId?: string, principal?: ApiPrincipal): Promise<Response> {
  if (!vaults) throw new AgentsApiError(503, 'Vault service is unavailable.', 'service_unavailable');
  const [vaultId, collection, credentialId] = parts;
  const method = request.method;
  const query = () => queryParameters(new URL(request.url).searchParams, { nullableLimit: true });
  if (!vaultId && method === 'POST') return json(200, await vaults.create(ownerId, await requestBody(request), mutation(principal ?? ownerId, requestId)), requestId);
  if (!vaultId && method === 'GET') return json(200, await vaults.list(ownerId, query()), requestId);
  if (vaultId && !collection) {
    if (method === 'GET') return json(200, await vaults.retrieve(ownerId, vaultId), requestId);
    if (method === 'DELETE') return json(200, await vaults.delete(ownerId, vaultId, mutation(principal ?? ownerId, requestId)), requestId);
  }
  if (vaultId && collection === 'credentials' && parts.length <= 3) {
    if (!credentialId && method === 'POST') return json(200, await vaults.createCredential(ownerId, vaultId, await requestBody(request), mutation(principal ?? ownerId, requestId)), requestId);
    if (!credentialId && method === 'GET') return json(200, await vaults.credentials(ownerId, vaultId, query()), requestId);
    if (credentialId && method === 'GET') return json(200, await vaults.credential(ownerId, vaultId, credentialId), requestId);
    if (credentialId && method === 'POST') return json(200, await vaults.updateCredential(ownerId, vaultId, credentialId, await requestBody(request), mutation(principal ?? ownerId, requestId)), requestId);
    if (credentialId && method === 'DELETE') return json(200, await vaults.deleteCredential(ownerId, vaultId, credentialId, mutation(principal ?? ownerId, requestId)), requestId);
  }
  throw new AgentsApiError(404, 'Route not found.', 'resource_not_found');
}

async function routeSession(request: Request, principal: ApiPrincipal, parts: string[], sessions: SessionService | undefined, requestId?: string, streaming = true, authority?: SpaceAuthority, admission?: WorkloadAdmissionService): Promise<Response> {
  const ownerId = principal.ownerId;
  if (!sessions) throw new AgentsApiError(503, 'Session service is unavailable.', 'service_unavailable');
  if (parts.length === 1 && parts[0] === 'import') {
    if (request.method === 'GET') return json(200, { version: 1, max_history_bytes: 2 * 1024 * 1024, credentials: 'destination', execution: 'on_next_message' }, requestId);
    if (request.method === 'POST') return json(200, await sessions.import(ownerId, await requestBody(request)), requestId);
  }
  const [id, collection, childId, operation] = parts;
  const method = request.method;
  const query = () => queryParameters(new URL(request.url).searchParams, { nullableLimit: collection === 'artifacts', nullableAfter: collection === 'artifacts' });
  if (!id && method === 'POST') {
    const body = await requestBody(request);
    requireInferencePermission(principal, body, 'create');
    if (isStreaming(body) && !streaming) throw new AgentsApiError(400, 'Use the Agents API streaming endpoint for this request.', 'streaming_unavailable');
    const admitted = authority ? await admission?.admit(authority, body) : undefined;
    if (authority && !admitted) throw new AgentsApiError(503, 'Workload admission is unavailable.', 'service_unavailable');
    const caller = authority && admitted ? { ...authority, observations: [...authority.observations, ...admitted.observations], admission: admitted.evidence } : undefined;
    const session = await sessions.create(ownerId, body, undefined, undefined, undefined, caller);
    return isStreaming(body) ? eventStream((signal) => sessions.stream(ownerId, session.id, signal, true, undefined, authority ? { revalidate: authority.revalidate } : undefined), request.signal, requestId) : json(200, session, requestId);
  }
  if (!id && method === 'GET') return json(200, await sessions.list(ownerId, queryParameters(new URL(request.url).searchParams, { nullableLimit: true })), requestId);
  if (id && !collection) {
    if (method === 'GET') return json(200, await sessions.retrieve(ownerId, id), requestId);
    if (method === 'POST') {
      const body = await requestBody(request);
      if (authority) {
        if (!admission) throw new AgentsApiError(503, 'Workload admission is unavailable.', 'service_unavailable');
        await admission.validateSessionUpdate(authority, id, body);
      }
      return json(200, await sessions.update(ownerId, id, body, mutation(principal, requestId)), requestId);
    }
    if (method === 'DELETE') return json(200, await sessions.delete(ownerId, id), requestId);
  }
  if (id && collection === 'fork' && parts.length === 2 && method === 'POST') {
    const body = await requestBody(request);
    requireInferencePermission(principal, body, 'create');
    const input = teamForkInput(body, authority);
    const admitted = authority ? await admission?.admitFork(authority, id) : undefined;
    if (authority && !admitted) throw new AgentsApiError(503, 'Workload admission is unavailable.', 'service_unavailable');
    const caller = authority && admitted ? { ...authority, observations: [...authority.observations, ...admitted.observations], admission: admitted.evidence } : undefined;
    return json(201, await sessions.fork(ownerId, id, input, caller), requestId);
  }
  if (id && collection === 'runtime' && parts.length === 2 && method === 'GET') return json(200, await sessions.runtime(ownerId, id), requestId);
  if (id && collection === 'lineage' && parts.length === 2 && method === 'GET') return json(200, await sessions.lineage(ownerId, id), requestId);
  if (id && collection === 'traces' && parts.length === 2 && method === 'GET') return json(200, await sessions.traces(ownerId, id, query()), requestId);
  if (id && collection === 'events' && !childId) {
    if (method === 'POST') {
      const body = await requestBody(request);
      requireInferencePermission(principal, body, 'events');
      await sessions.events(ownerId, id, body, request.headers.get('idempotency-key') ?? undefined, authority ? { caller: authority } : undefined);
      return new Response(null, { status: 204, headers: requestId ? { 'x-request-id': requestId } : {} });
    }
    if (method === 'GET') {
      if (!streaming) throw new AgentsApiError(400, 'Use the Agents API streaming endpoint for this request.', 'streaming_unavailable');
      const baseline = await sessions.streamSnapshot(ownerId, id);
      return eventStream((signal) => sessions.stream(ownerId, id, signal, false, baseline, authority ? { revalidate: authority.revalidate, ...(request.headers.get('last-event-id') ? { after: request.headers.get('last-event-id')! } : {}) } : undefined), request.signal, requestId);
    }
  }
  if (id && collection === 'subagents' && method === 'GET') {
    const turnId = parts[4];
    if (!childId && parts.length === 2) return json(200, await sessions.subagents(ownerId, id, query()), requestId);
    if (childId && parts.length === 3) return json(200, await sessions.subagent(ownerId, id, childId), requestId);
    if (childId && operation === 'items' && parts.length === 4) return json(200, await sessions.subagentItems(ownerId, id, childId, query()), requestId);
    if (childId && operation === 'turns' && !turnId && parts.length === 4) return json(200, await sessions.subagentTurns(ownerId, id, childId, query()), requestId);
    if (childId && operation === 'turns' && turnId && parts.length === 5) return json(200, await sessions.subagentTurn(ownerId, id, childId, turnId), requestId);
    if (childId && operation === 'turns' && turnId && parts[5] === 'items' && parts.length === 6) return json(200, await sessions.subagentItems(ownerId, id, childId, query(), turnId), requestId);
  }
  if (id && collection === 'turns' && method === 'GET' && !operation) return json(200, childId ? await sessions.turn(ownerId, id, childId) : await sessions.turns(ownerId, id, query()), requestId);
  if (id && collection === 'items' && method === 'GET' && !childId) return json(200, await sessions.items(ownerId, id, query()), requestId);
  if (id && collection === 'artifacts' && parts.length <= 4) {
    if (!childId && method === 'GET') return json(200, await sessions.artifacts(ownerId, id, query()), requestId);
    if (childId && !operation && method === 'GET') return json(200, await sessions.artifact(ownerId, id, childId), requestId);
    if (childId && !operation && method === 'DELETE') return json(200, await sessions.deleteArtifact(ownerId, id, childId), requestId);
    if (childId && operation === 'content' && method === 'GET') return new Response(await sessions.artifactContent(ownerId, id, childId), {
      headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', ...(requestId ? { 'x-request-id': requestId } : {}) },
    });
  }
  throw new AgentsApiError(404, 'Route not found.', 'resource_not_found');
}

function isStreaming(value: unknown): boolean { return typeof value === 'object' && value !== null && 'stream' in value && value.stream === true; }

function eventStream(events: (signal: AbortSignal) => AsyncIterable<import('../domain/agents-api.js').AgentSessionEvent>, signal: AbortSignal, requestId?: string): Response {
  const abort = new AbortController();
  const onAbort = () => abort.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) abort.abort();
  const iterator = events(abort.signal)[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  let pending: ReturnType<typeof iterator.next> | undefined;
  const cleanup = () => { abort.abort(); signal.removeEventListener('abort', onAbort); };
  return new Response(new ReadableStream({
    start(controller) { controller.enqueue(encoder.encode(': connected\n\n')); },
    async pull(controller) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        pending ??= iterator.next();
        const next = await Promise.race([pending, new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), 15_000); })]);
        if (!next) { controller.enqueue(encoder.encode(': keepalive\n\n')); return; }
        pending = undefined;
        if (next.done) { cleanup(); controller.close(); return; }
        const eventId = 'event_id' in next.value && typeof next.value.event_id === 'string' ? next.value.event_id : undefined;
        controller.enqueue(encoder.encode(`${eventId ? `id: ${eventId}\n` : ''}event: ${next.value.type}\ndata: ${JSON.stringify(next.value)}\n\n`));
      } catch (error) { cleanup(); controller.error(error); }
      finally { if (timer) clearTimeout(timer); }
    },
    async cancel() { cleanup(); await iterator.return?.(); },
  }), { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...(requestId ? { 'x-request-id': requestId } : {}) } });
}

export function agentsErrorResponse(error: unknown, requestId?: string): Response {
  const known = error instanceof AgentsApiError ? error : new AgentsApiError(500, 'Internal server error.', 'internal_error');
  const response = json(known.status, {
    error: { message: known.message, type: known.type, param: known.param, code: known.code },
  }, requestId);
  if (known.retryAfterSeconds !== undefined) response.headers.set('retry-after', String(Math.max(1, Math.ceil(known.retryAfterSeconds))));
  return response;
}

export function json(status: number, value: unknown, requestId?: string): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...(requestId ? { 'x-request-id': requestId } : {}),
    },
  });
}

export async function requestBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text) return {};
  try { return JSON.parse(text) as unknown; }
  catch { throw new AgentsApiError(400, 'Request body must be valid JSON.', 'invalid_json'); }
}

function pathParts(pathname: string): string[] {
  try { return pathname.split('/').filter(Boolean).map(decodeURIComponent); }
  catch { throw new AgentsApiError(400, 'Path must use valid percent encoding.', 'invalid_request'); }
}

export function queryParameters(params: URLSearchParams, options: { nullableLimit?: boolean; nullableAfter?: boolean } = {}): Record<string, unknown> {
  const query: Record<string, unknown> = Object.fromEntries(params);
  for (const key of params.keys()) {
    if (key.endsWith('[]')) {
      query[key.slice(0, -2)] = params.getAll(key);
      delete query[key];
    } else if (params.getAll(key).length > 1) throw new AgentsApiError(400, 'Query parameters must not be repeated.', 'invalid_request', key);
  }
  if (query.after === '' && options.nullableAfter) delete query.after;
  const limit = params.get('limit');
  if (limit !== null) {
    // The upstream SDK serializes a nullable query value as `limit=`. Normalize
    // only routes whose reference admits null, before generated type validation.
    if (limit === '' && options.nullableLimit) { delete query.limit; return query; }
    if (!/^\d+$/.test(limit)) throw new AgentsApiError(400, 'limit must be a positive integer.', 'invalid_request', 'limit');
    query.limit = Number(limit);
  }
  return query;
}

function mutation(caller: ApiPrincipal | string, requestId?: string): import('../domain/configuration-history.js').ConfigurationMutation {
  return { actor: typeof caller === 'string' || !caller.actor || caller.authentication !== 'oidc' ? { kind: 'owner', id: typeof caller === 'string' ? caller : caller.ownerId } : { kind: 'principal', id: caller.actor.id, ...(caller.actor.issuer ? { issuer: caller.actor.issuer, subject: caller.actor.subject! } : {}) }, ...(requestId ? { requestId } : {}) };
}

function teamForkInput(raw: unknown, authority?: SpaceAuthority): unknown {
  if (authority && raw && typeof raw === 'object' && Object.keys(raw).some(key => !['input', 'metadata'].includes(key))) throw new AgentsApiError(403, 'Fork cannot override the fixed execution authority.', 'insufficient_permissions');
  return raw;
}
function reauthorizedResponse(response: Response, authority: SpaceAuthority, signal: AbortSignal): Response {
  if (!response.body) return response;
  const reader = response.body.getReader();
  let closed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const cleanup = () => { closed = true; if (timer) clearInterval(timer); signal.removeEventListener('abort', abort); };
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  const abort = () => { cleanup(); cancel(); };
  signal.addEventListener('abort', abort, { once: true });
  return new Response(new ReadableStream({
    start(controller) {
      let checking = false;
      timer = setInterval(() => {
        if (checking || closed) return;
        checking = true;
        void authority.revalidate().catch(error => { if (!closed) { cleanup(); controller.error(error); cancel(); } }).finally(() => { checking = false; });
      }, 1000);
      timer.unref?.();
    },
    async pull(controller) {
      try {
        await authority.revalidate();
        const next = await reader.read();
        if (closed) return;
        await authority.revalidate();
        if (closed) return;
        if (next.done) { cleanup(); controller.close(); } else controller.enqueue(next.value);
      } catch (error) { if (!closed) { cleanup(); controller.error(error); cancel(); } }
    },
    async cancel() { cleanup(); await reader.cancel(); },
  }), { status: response.status, headers: response.headers });
}
