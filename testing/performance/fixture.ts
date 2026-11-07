import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createAgentsHttpServer } from '../../src/adapters/agents-http-server.js';
import { AgentsApiError } from '../../src/domain/agents-api-validation.js';
import { SqliteAgentsStore } from '../../src/adapters/sqlite-agents-store.js';
import { SessionEventStore } from '../../src/core/session-event-store.js';
import { AgentService } from '../../src/core/agent-service.js';
import { SessionService } from '../../src/core/session-service.js';
import { SessionRuntimeStore } from '../../src/core/session-runtime-store.js';
import { initialSessionRuntime, type SessionRuntimeState } from '../../src/core/session-runtime-planning.js';
import { OwnerRateLimiter } from '../../src/core/owner-rate-limiter.js';
import type { SessionExecution } from '../../src/core/session-ports.js';
import type { AgentSession, AgentSessionItem, AgentSessionInputMessageParam } from '../../src/domain/agents-api.js';
import { API_SCOPES, iamApiPrincipal, type ApiPrincipal } from '../../src/domain/api-permissions.js';
import { oidcActorId } from '../../src/identity/principal.js';
import { GuardedAgentsStore } from '../../src/identity/guarded-agents-store.js';
import { SpaceAccessService, spaceOwner } from '../../src/identity/space-access.js';
import { WorkloadAdmissionService } from '../../src/identity/workload-admission.js';
import { agentsErrorResponse, routeAgentsRequest, type AgentsApiServices } from '../../src/lambdas/agents-router.js';
import { CountingStore } from './counting-store.js';
import type { PerformanceConfig } from './statistics.js';

export const issuer = 'https://performance.invalid';
export const model = 'deterministic-performance-mock';
export const outputPrefix = 'synthetic-output:';
export const messageBody = (text: string) => ({ events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text }] }] }] });
export const actorId = (subject: string) => oidcActorId(issuer, subject);
export function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : error instanceof Error ? error.name : 'UnknownError';
}

/** Real control-plane services; identity verification and execution are explicit deterministic test doubles. */
export async function createPerformanceFixture(config: PerformanceConfig, viewers: number, historyItems: number) {
  const directory = await mkdtemp(join(tmpdir(), 'rat-performance-'));
  const sqlite = new SqliteAgentsStore(directory);
  sqlite.acquireServerLease();
  const counted = new CountingStore(sqlite);
  const guardedStore = new GuardedAgentsStore(counted);
  const store = new SessionEventStore(guardedStore);
  const access = new SpaceAccessService(store);
  const admission = new WorkloadAdmissionService(store);
  const agents = new AgentService({ store });
  const runtimes = new SessionRuntimeStore(store);
  const stopping = new AbortController();
  const handlers = new Set<Promise<void>>();
  const operations = new Map<string, Promise<void>>();
  const executed = new Map<string, { count: number; emittedAt: number }>();
  const workerErrors: string[] = [];
  let native: SessionRuntimeState | undefined;
  let session: AgentSession | undefined;
  let spaceId = '';
  let busy: Promise<void> | undefined;
  let pending = false;
  const principal = (subject: string): ApiPrincipal => subject === 'operator' ? iamApiPrincipal('performance-operator') : {
    ownerId: '', authentication: 'oidc', scopes: API_SCOPES, expiresAt: Date.now() + 900_000,
    actor: { id: actorId(subject), kind: 'human', issuer, subject },
  };
  const subjects = new Set(['operator', 'manager', 'revoked-probe', ...Array.from({ length: config.writers }, (_, i) => `writer-${i}`), ...Array.from({ length: viewers }, (_, i) => `viewer-${i}`)]);
  const assistantItem = (turnId: string, id: string, text: string): AgentSessionItem => ({ id, type: 'message', role: 'assistant', phase: 'commentary', status: 'completed', turn_id: turnId, content: [{ type: 'output_text', text }] });
  const publish = async (owner: string, current: AgentSession) => {
    if (!await runtimes.publish(owner, current.id, 'synthetic-run', native!)) throw new Error('Synthetic runtime lost ownership');
  };
  const emit = async (owner: string, current: AgentSession, turnId: string, input: AgentSessionInputMessageParam[]) => {
    await delay(config.syntheticDelayMs, undefined, { signal: stopping.signal });
    const correlations = input.flatMap(message => message.content.flatMap(part => part.type === 'input_text' ? part.text.match(/perf-msg:[a-z0-9-]+/g) ?? [] : []));
    const items = correlations.map(correlation => assistantItem(turnId, `mock_${correlation}`, `${outputPrefix}${correlation}`));
    native = { ...native!, turns: native!.turns.map(binding => binding.turn.id === turnId ? { ...binding, items: [...binding.items, ...items] } : binding) };
    await publish(owner, current);
    for (const correlation of correlations) executed.set(correlation, { count: (executed.get(correlation)?.count ?? 0) + 1, emittedAt: performance.now() });
  };
  const onceOperation = (key: string, work: () => Promise<void>) => {
    const previous = operations.get(key); if (previous) return previous;
    const promise = work(); operations.set(key, promise); return promise;
  };
  const execution: SessionExecution = {
    prepare: async (_owner, _id, environment) => { if (environment.type !== 'none') throw new Error('Performance fixture requires no environment'); return environment; },
    start: (owner, current, binding) => onceOperation(`start:${binding.turn.id}`, async () => {
      if (!native) { native = initialSessionRuntime(current.id, current.agent.id, 'synthetic-thread'); await runtimes.claim(owner, current.id, 'synthetic-run', Math.floor(Date.now() / 1000)); }
      native = { ...native, turns: [...native.turns, { threadId: 'synthetic-thread', nativeTurnId: binding.turn.id,
        turn: { ...binding.turn, status: 'in_progress', started_at: Math.floor(Date.now() / 1000) },
        items: Array.from({ length: historyItems }, (_, index) => assistantItem(binding.turn.id, `seed_${index}`, `Synthetic history ${index}: ${'x'.repeat(128)}`)) }] };
      await emit(owner, current, binding.turn.id, binding.input);
    }),
    steer: (owner, current, turnId, input, operationId) => onceOperation(`steer:${operationId}`, () => emit(owner, current, turnId, input)),
    cancel: async () => {}, toolResult: async () => { throw new Error('No synthetic tool requests'); },
    observe: async (_owner, _session, turn) => ({ turn: native?.turns.find(binding => binding.turn.id === turn.id)?.turn ?? turn, requiredActions: [] }),
    items: async (_owner, _session, turnId) => native?.turns.find(binding => binding.turn.id === turnId)?.items ?? [],
    artifacts: async () => [], artifactContent: async () => { throw new Error('No synthetic artifacts'); },
  };
  const sessions = new SessionService({ store, agents, execution, streamIntervalMs: config.streamIntervalMs, rateLimit: new OwnerRateLimiter(store) });
  const services: AgentsApiServices = { agents, sessions, access, admission, guardedStore,
    activity: { snapshot: (owner, id, caller) => sessions.activity(owner, id, caller), follow: (owner, id, signal, options) => sessions.activityEvents(owner, id, signal, options) } };
  const kick = () => {
    pending = true;
    if (busy || stopping.signal.aborted || !session) return;
    busy = (async () => {
      while (pending && !stopping.signal.aborted) {
        pending = false;
        try { await sqlite.runWhileServerLeaseHeld(() => sessions.dispatch(spaceOwner(spaceId), session!.id)); }
        catch (error) { if (stopping.signal.aborted) break; workerErrors.push(errorCode(error)); pending = true; await delay(25, undefined, { signal: stopping.signal }); }
      }
    })().catch(error => { if (!stopping.signal.aborted) workerErrors.push(errorCode(error)); }).finally(() => { busy = undefined; });
  };
  const server = createAgentsHttpServer({ baseURL: 'http://127.0.0.1/v1', issuerURL: 'https://performance.invalid/fixture-only',
    authenticate: async authorization => {
      const subject = authorization?.replace(/^Bearer /, '');
      if (!subject || !subjects.has(subject)) throw new AgentsApiError(401, 'Unknown performance fixture identity', 'invalid_api_key');
      return principal(subject);
    },
    route: (request, caller, requestId) => {
      const work = routeAgentsRequest(request, caller, services, requestId).then(response => {
        if (request.method === 'POST' && request.url.endsWith('/events') && response.status === 204) kick();
        return response;
      });
      const pending = work.then(() => {}, () => {}); handlers.add(pending); void pending.finally(() => handlers.delete(pending));
      return work;
    }, error: agentsErrorResponse,
  });
  const close = async () => {
    stopping.abort();
    const closed = new Promise<void>(resolve => server.close(() => resolve())); server.closeAllConnections();
    const deadline = new AbortController();
    try { await Promise.race([Promise.allSettled([closed, busy, ...handlers]), delay(3000, undefined, { signal: deadline.signal }).then(() => { throw new Error('Performance fixture cleanup exceeded 3s'); })]); }
    finally {
      deadline.abort();
      await sqlite.drainServerLease(); sqlite.close(true); await rm(directory, { recursive: true, force: true });
    }
  };
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No loopback listener');
    const baseURL = `http://127.0.0.1:${address.port}`;
    const request = (path: string, subject: string, options: { body?: unknown; method?: string; key?: string; signal?: AbortSignal; cursor?: string } = {}) => fetch(`${baseURL}${path}`, {
      method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      headers: { authorization: `Bearer ${subject}`, ...(spaceId ? { 'x-rat-space': spaceId } : {}), ...(options.key ? { 'idempotency-key': options.key } : {}),
        ...(options.cursor ? { 'last-event-id': options.cursor } : {}), ...(options.body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: options.signal ?? AbortSignal.any([stopping.signal, AbortSignal.timeout(config.timeoutMs)]),
    });
    const json = async <T>(path: string, subject: string, body?: unknown): Promise<T> => {
      const response = await request(path, subject, body === undefined ? {} : { body });
      if (!response.ok) throw new Error(`Fixture setup HTTP ${response.status}: ${await response.text()}`);
      return response.json() as Promise<T>;
    };
    spaceId = (await json<{ id: string }>('/v1/rat/spaces', 'operator', { name: 'Local performance fixture', manager: { issuer, subject: 'manager' } })).id;
    for (const subject of subjects) if (!['operator', 'manager'].includes(subject)) await json(`/v1/rat/spaces/${spaceId}/bindings`, 'manager', { issuer, subject, role: subject.startsWith('viewer') ? 'viewer' : 'collaborator' });
    await json(`/v1/rat/spaces/${spaceId}/execution-roles/mock`, 'manager', { name: 'Deterministic mock only', models: [model], tools: [], environments: [{ type: 'none' }], vault_ids: [], capability_profile_ids: [], connection_grant_ids: [] });
    const agent = await json<{ id: string }>('/v1/agents', 'manager', { model });
    await json(`/v1/rat/agents/${agent.id}/workload`, 'manager', { execution_role_id: 'mock' });
    session = await json<AgentSession>('/v1/agents/sessions', 'manager', { agent_id: agent.id, environment: { type: 'none' }, input: 'Synthetic performance setup' });
    await sessions.dispatch(spaceOwner(spaceId), session.id);
    return { directory, baseURL, spaceId, sessionId: session.id, request, counted, executed, workerErrors, close,
      async settled() { while (busy) await busy; },
    };
  } catch (error) { await close(); throw error; }
}
export type PerformanceFixture = Awaited<ReturnType<typeof createPerformanceFixture>>;
