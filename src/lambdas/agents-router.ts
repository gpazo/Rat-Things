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

/** The caller authenticates once and supplies its derived owner, never a body field. */
export async function routeAgentRequest(
  request: Request,
  ownerId: string,
  agents: AgentService,
  requestId?: string,
): Promise<Response> {
  return routeAgentsRequest(request, ownerId, { agents }, requestId);
}

export interface AgentsApiServices {
  agents: AgentService;
  sessions?: SessionService;
  vaults?: VaultService;
  templates?: EnvironmentTemplateService;
  environments?: EnvironmentService;
  files?: FileService;
  skills?: SkillService;
  webhooks?: WebhookService;
}

export async function routeAgentsRequest(request: Request, ownerId: string, services: AgentsApiServices, requestId?: string, streaming = true): Promise<Response> {
  try {
    if (!ownerId) throw new AgentsApiError(401, 'Authentication required.', 'invalid_api_key');
    const url = new URL(request.url);
    const parts = pathParts(url.pathname);
    if (parts[0] !== 'v1') throw new AgentsApiError(404, 'Route not found.', 'resource_not_found');
    if (parts[1] === 'webhooks') return await routeWebhook(request, ownerId, parts.slice(2), services.webhooks, requestId);
    if (parts[1] === 'files') return await routeUploadedFiles(request, ownerId, parts.slice(2), services.files, requestId);
    if (parts[1] === 'skills') return await routeSkills(request, ownerId, parts.slice(2), services.skills, requestId);
    if (parts[1] === 'agents' && parts[2] === 'environments' && parts[3] === 'templates') return await routeTemplate(request, ownerId, parts.slice(4), services.templates, requestId);
    if (parts[1] === 'agents' && parts[2] === 'environments' && parts[3] && parts.length === 4 && request.method === 'GET') {
      if (!services.environments) throw new AgentsApiError(503, 'Environment service is unavailable.', 'service_unavailable');
      return json(200, await services.environments.retrieve(ownerId, parts[3]), requestId);
    }
    if (parts[1] === 'agents' && parts[2] === 'environments' && parts[3] && parts[4] === 'connection' && parts.length === 5 && request.method === 'POST') {
      if (!services.environments) throw new AgentsApiError(503, 'Environment service is unavailable.', 'service_unavailable');
      return json(200, await services.environments.executorConnection(ownerId, parts[3]), requestId);
    }
    if (parts[1] === 'agents' && parts[2] === 'environments' && parts[3] && parts[4] === 'files' && parts.length === 5) {
      if (!services.environments) throw new AgentsApiError(503, 'Environment service is unavailable.', 'service_unavailable');
      if (request.method === 'GET') return json(200, await services.environments.files(ownerId, parts[3], queryParameters(url.searchParams, { nullableLimit: true })), requestId);
      if (request.method === 'POST') return json(200, await services.environments.createFile(ownerId, parts[3], await requestBody(request)), requestId);
    }
    if (parts[1] === 'vaults') return await routeVault(request, ownerId, parts.slice(2), services.vaults, requestId);
    if (parts[1] === 'agents' && parts[2] === 'sessions') return await routeSession(request, ownerId, parts.slice(3), services.sessions, requestId, streaming);
    const route = /^\/v1\/agents(?:\/([^/]+))?$/.exec(url.pathname);
    if (!route) throw new AgentsApiError(404, 'Route not found.', 'resource_not_found');
    const id = parts[2];
    const method = request.method;
    const { agents } = services;
    if (method === 'GET' && !id) {
      return json(200, await agents.list(ownerId, queryParameters(url.searchParams, { nullableLimit: true })), requestId);
    }
    if (method === 'POST' && !id) {
      return json(200, await agents.create(ownerId, await requestBody(request)), requestId);
    }
    if (method === 'GET' && id) return json(200, await agents.retrieve(ownerId, id), requestId);
    if (method === 'POST' && id) return json(200, await agents.update(ownerId, id, await requestBody(request)), requestId);
    if (method === 'DELETE' && id) return json(200, await agents.delete(ownerId, id), requestId);
    throw new AgentsApiError(405, 'Method not allowed.', 'method_not_allowed');
  } catch (error) {
    return agentsErrorResponse(error, requestId);
  }
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

async function routeVault(request: Request, ownerId: string, parts: string[], vaults: VaultService | undefined, requestId?: string): Promise<Response> {
  if (!vaults) throw new AgentsApiError(503, 'Vault service is unavailable.', 'service_unavailable');
  const [vaultId, collection, credentialId] = parts;
  const method = request.method;
  const query = () => queryParameters(new URL(request.url).searchParams, { nullableLimit: true });
  if (!vaultId && method === 'POST') return json(200, await vaults.create(ownerId, await requestBody(request)), requestId);
  if (!vaultId && method === 'GET') return json(200, await vaults.list(ownerId, query()), requestId);
  if (vaultId && !collection) {
    if (method === 'GET') return json(200, await vaults.retrieve(ownerId, vaultId), requestId);
    if (method === 'DELETE') return json(200, await vaults.delete(ownerId, vaultId), requestId);
  }
  if (vaultId && collection === 'credentials' && parts.length <= 3) {
    if (!credentialId && method === 'POST') return json(200, await vaults.createCredential(ownerId, vaultId, await requestBody(request)), requestId);
    if (!credentialId && method === 'GET') return json(200, await vaults.credentials(ownerId, vaultId, query()), requestId);
    if (credentialId && method === 'GET') return json(200, await vaults.credential(ownerId, vaultId, credentialId), requestId);
    if (credentialId && method === 'POST') return json(200, await vaults.updateCredential(ownerId, vaultId, credentialId, await requestBody(request)), requestId);
    if (credentialId && method === 'DELETE') return json(200, await vaults.deleteCredential(ownerId, vaultId, credentialId), requestId);
  }
  throw new AgentsApiError(404, 'Route not found.', 'resource_not_found');
}

async function routeSession(request: Request, ownerId: string, parts: string[], sessions: SessionService | undefined, requestId?: string, streaming = true): Promise<Response> {
  if (!sessions) throw new AgentsApiError(503, 'Session service is unavailable.', 'service_unavailable');
  const [id, collection, childId, operation] = parts;
  const method = request.method;
  const query = () => queryParameters(new URL(request.url).searchParams, { nullableLimit: collection === 'artifacts', nullableAfter: collection === 'artifacts' });
  if (!id && method === 'POST') {
    const body = await requestBody(request);
    if (isStreaming(body) && !streaming) throw new AgentsApiError(400, 'Use the Agents API streaming endpoint for this request.', 'streaming_unavailable');
    const session = await sessions.create(ownerId, body);
    return isStreaming(body) ? eventStream((signal) => sessions.stream(ownerId, session.id, signal, true), request.signal, requestId) : json(200, session, requestId);
  }
  if (!id && method === 'GET') return json(200, await sessions.list(ownerId, queryParameters(new URL(request.url).searchParams, { nullableLimit: true })), requestId);
  if (id && !collection) {
    if (method === 'GET') return json(200, await sessions.retrieve(ownerId, id), requestId);
    if (method === 'POST') return json(200, await sessions.update(ownerId, id, await requestBody(request)), requestId);
    if (method === 'DELETE') return json(200, await sessions.delete(ownerId, id), requestId);
  }
  if (id && collection === 'events' && !childId) {
    if (method === 'POST') {
      await sessions.events(ownerId, id, await requestBody(request), request.headers.get('idempotency-key') ?? undefined, { waitForConnection: true, signal: request.signal });
      return new Response(null, { status: 204, headers: requestId ? { 'x-request-id': requestId } : {} });
    }
    if (method === 'GET') {
      if (!streaming) throw new AgentsApiError(400, 'Use the Agents API streaming endpoint for this request.', 'streaming_unavailable');
      const baseline = await sessions.streamSnapshot(ownerId, id);
      return eventStream((signal) => sessions.stream(ownerId, id, signal, false, baseline), request.signal, requestId);
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
        controller.enqueue(encoder.encode(`event: ${next.value.type}\ndata: ${JSON.stringify(next.value)}\n\n`));
      } catch (error) { cleanup(); controller.error(error); }
      finally { if (timer) clearTimeout(timer); }
    },
    async cancel() { cleanup(); await iterator.return?.(); },
  }), { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...(requestId ? { 'x-request-id': requestId } : {}) } });
}

export function agentsErrorResponse(error: unknown, requestId?: string): Response {
  const known = error instanceof AgentsApiError ? error : new AgentsApiError(500, 'Internal server error.', 'internal_error');
  return json(known.status, {
    error: { message: known.message, type: known.type, param: known.param, code: known.code },
  }, requestId);
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
