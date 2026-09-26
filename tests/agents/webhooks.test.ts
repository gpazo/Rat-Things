import { iamApiPrincipal } from '../../src/domain/api-permissions.js';
import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { MemoryAgentsStore } from './fixtures.js';
import { SessionEventStore, type SessionEventBatch } from '../../src/core/session-event-store.js';
import { WebhookService } from '../../src/core/webhook-service.js';
import type { WebhookSecrets } from '../../src/credentials/webhooks.js';
import { sessionWebhookTypes, webhookEndpointInput, type WebhookDelivery } from '../../src/domain/session-webhooks.js';
import { AgentService } from '../../src/core/agent-service.js';
import { SessionService } from '../../src/core/session-service.js';
import { SessionRuntimeStore } from '../../src/core/session-runtime-store.js';
import { initialSessionRuntime } from '../../src/core/session-runtime-planning.js';
import type { SessionState } from '../../src/core/session-ports.js';
import { routeAgentsRequest } from '../../src/lambdas/agents-router.js';
import { publicNetworkAddress } from '../../src/domain/network-address.js';
import { AgentsApiError, parseAgentsContract } from '../../src/domain/agents-api-validation.js';
import { agentsStreamJobs, agentsJobGroup } from '../../src/core/agents-outbox-planning.js';
import type { StoredEnvironment } from '../../src/core/environment-service.js';
import type { SessionStreamSnapshot } from '../../src/core/session-stream.js';

function fixture() {
  let now = Math.floor(Date.now() / 1000);
  let serial = 0;
  const clock = { now: () => now };
  const base = new MemoryAgentsStore();
  const store = new SessionEventStore(base, clock);
  const values = new Map<string, string>();
  const revoked: string[] = [];
  let reads = 0;
  const secrets: WebhookSecrets = {
    create: async (_owner, id, secret) => { const reference = `secret:${id}:${serial++}`; values.set(reference, secret); return reference; },
    read: async (reference) => { reads++; return values.get(reference)!; },
    revoke: async (reference) => { revoked.push(reference); values.delete(reference); },
  };
  const requests: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
  let result = 204;
  let sending: Promise<void> | undefined;
  const webhooks = new WebhookService({ store, secrets, clock, transport: { post: async (url, body, headers) => {
    requests.push({ url, body, headers }); await sending; return result;
  } } });
  const agents = new AgentService({ store, clock });
  const sessions = new SessionService({ store, agents, clock, streamIntervalMs: 1, execution: {
    prepare: async (_owner, _id, environment) => { if (environment.type !== 'none') throw new Error('fixture environment'); return environment; },
    start: async () => {}, steer: async () => {}, cancel: async () => {}, toolResult: async () => {},
    observe: async (_owner, _session, turn) => ({ turn, requiredActions: [] }), items: async () => [], artifacts: async () => [], artifactContent: async () => new ReadableStream(),
  } });
  const call = (owner: string, path: string, method = 'GET', body?: unknown) => routeAgentsRequest(new Request(`https://rat.invalid/v1/${path}`, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) }), iamApiPrincipal(owner), { agents, sessions, webhooks });
  const create = () => sessions.create('alice', { agent: { model: 'test' }, environment: { type: 'none' }, input: 'Start' });
  const endpoint = () => webhooks.create('alice', { name: 'Events', url: 'https://receiver.example/events', events: sessionWebhookTypes });
  async function fanout() {
    const batches = await store.list<SessionEventBatch>('alice', 'session_event_batches', { order: 'asc', limit: 100 });
    for (const batch of batches.data) await webhooks.fanout('alice', batch.id);
    return (await store.list<WebhookDelivery>('alice', 'webhook_deliveries', { order: 'asc', limit: 100 })).data;
  }
  return { base, store, sessions, webhooks, values, revoked, requests, clock, create, endpoint, fanout, call,
    advance: (seconds: number) => { now += seconds; }, status: (code: number) => { result = code; }, sending: (value: Promise<void>) => { sending = value; }, reads: () => reads,
  };
}

describe('standard outbound Session webhooks', () => {
  it('commits creation events with the Session, delivers SDK-verifiable bytes, and deduplicates fanout and delivery', async () => {
    const f = fixture();
    const endpoint = await f.endpoint();
    const session = await f.create();
    const deliveries = await f.fanout();
    expect(deliveries).toHaveLength(2);
    const created = deliveries.find(({ value }) => value.event.type === 'agent.session.created')!;
    await f.webhooks.deliver('alice', created.id);
    await f.fanout();
    await f.webhooks.deliver('alice', created.id);
    expect(f.requests).toHaveLength(1);
    const request = f.requests[0]!;
    const sdk = new OpenAI({ apiKey: 'fixture', webhookSecret: endpoint.signing_secret });
    expect(await sdk.webhooks.unwrap(request.body, request.headers)).toMatchObject({ object: 'event', type: 'agent.session.created', data: { id: session.id } });
    await expect(sdk.webhooks.unwrap(`${request.body} `, request.headers)).rejects.toThrow();
    expect(JSON.stringify([...f.base.resources.values()])).not.toContain(endpoint.signing_secret);
    expect(await f.webhooks.retrieve('alice', endpoint.id)).not.toHaveProperty('signing_secret');
    expect((await f.webhooks.list('alice')).data).toHaveLength(1);
    expect((await f.webhooks.list('bob')).data).toHaveLength(0);
    await expect(f.webhooks.retrieve('bob', endpoint.id)).rejects.toMatchObject({ status: 404 });
  });

  it('retains redirect and server failures for backoff, reuses delivery identity, and stops after 72 hours', async () => {
    const f = fixture(); await f.endpoint(); await f.create();
    const delivery = (await f.fanout())[0]!;
    f.status(302);
    expect(await f.webhooks.deliver('alice', delivery.id)).toEqual({ retryAfterSeconds: 5 });
    expect(await f.webhooks.deliver('alice', delivery.id)).toEqual({ retryAfterSeconds: 5 });
    expect(f.requests).toHaveLength(1);
    f.advance(5); f.status(500);
    expect(await f.webhooks.deliver('alice', delivery.id)).toEqual({ retryAfterSeconds: 10 });
    expect(f.requests[1]!.headers['webhook-id']).toBe(f.requests[0]!.headers['webhook-id']);
    expect(f.requests[1]!.body).toBe(f.requests[0]!.body);
    expect(f.requests[1]!.headers['webhook-signature']).not.toBe(f.requests[0]!.headers['webhook-signature']);
    f.advance(72 * 3600);
    expect(await f.webhooks.deliver('alice', delivery.id)).toEqual({});
    expect((await f.store.get<WebhookDelivery>('alice', 'webhook_deliveries', delivery.id))?.value.status).toBe('failed');
    expect(f.requests).toHaveLength(2);
  });

  it('leases concurrent delivery and retries an ambiguous external acceptance with the same identity', async () => {
    const f = fixture(); await f.endpoint(); await f.create();
    const delivery = (await f.fanout())[0]!;
    let release!: () => void;
    f.sending(new Promise((resolve) => { release = resolve; }));
    const first = f.webhooks.deliver('alice', delivery.id);
    while (!f.requests.length) await new Promise((resolve) => setImmediate(resolve));
    expect(await f.webhooks.deliver('alice', delivery.id)).toEqual({ retryAfterSeconds: 60 });
    const commit = f.base.commit.bind(f.base);
    f.base.commit = async (writes) => { if (writes.some(({ resource }) => resource.collection === 'webhook_deliveries' && (resource.value as WebhookDelivery).status === 'delivered')) throw new Error('lost write'); await commit(writes); };
    release();
    await expect(first).rejects.toThrow('lost write');
    f.base.commit = commit;
    f.advance(60);
    await f.webhooks.deliver('alice', delivery.id);
    expect(f.requests).toHaveLength(2);
    expect(f.requests[1]!.headers['webhook-id']).toBe(f.requests[0]!.headers['webhook-id']);
  });

  it('rotates write-only secrets and disables pending deliveries before reading a revoked credential', async () => {
    const f = fixture(); const endpoint = await f.endpoint(); await f.create();
    const delivery = (await f.fanout())[0]!;
    const rotated = await f.webhooks.rotate('alice', endpoint.id);
    expect(rotated.signing_secret).not.toBe(endpoint.signing_secret);
    expect(f.revoked).toHaveLength(1);
    await f.webhooks.delete('alice', endpoint.id);
    expect(await f.webhooks.deliver('alice', delivery.id)).toEqual({});
    expect(f.requests).toEqual([]); expect(f.reads()).toBe(0);
    expect((await f.store.get<WebhookDelivery>('alice', 'webhook_deliveries', delivery.id))?.value.status).toBe('disabled');
    expect((await f.store.get<string[]>('alice', 'webhook_registry', 'endpoints'))?.value).toEqual([]);
  });

  it('administers endpoints through authenticated transport and rejects owner injection and invalid fields', async () => {
    const f = fixture();
    expect((await f.call('', 'webhooks', 'POST', {})).status).toBe(401);
    const created = await f.call('alice', 'webhooks', 'POST', { url: 'https://receiver.example/hook', events: ['agent.session.idle'], enabled: false });
    expect(created.status).toBe(201);
    const endpoint = await created.json();
    expect(endpoint.enabled).toBe(false);
    expect((await f.call('bob', `webhooks/${endpoint.id}`, 'DELETE')).status).toBe(404);
    expect((await f.call('alice', `webhooks/${endpoint.id}`, 'POST', { ownerId: 'bob' })).status).toBe(400);
    expect((await f.call('alice', `webhooks/${endpoint.id}/rotate-secret`, 'POST')).status).toBe(200);
    for (const url of ['http://receiver.example/', 'https://user:secret@receiver.example/', 'https://receiver.example/#secret']) expect(() => webhookEndpointInput({ url, events: ['agent.session.idle'] })).toThrow();
  });

  it('keeps webhook jobs independent and never re-enqueues a delivery progress write', () => {
    const base = { ownerId: 'alice', id: 'wh_1', key: 'root', revision: 1 };
    expect(agentsStreamJobs({ ...base, collection: 'webhook_deliveries' })).toEqual([{ ownerId: 'alice', id: 'wh_1', type: 'webhook_delivery' }]);
    expect(agentsStreamJobs({ ...base, collection: 'webhook_deliveries', revision: 2 })).toEqual([]);
    expect(agentsJobGroup({ type: 'webhook_delivery', ownerId: 'alice', id: 'same' })).not.toBe(agentsJobGroup({ type: 'dispatch', ownerId: 'alice', id: 'same' }));
  });

  it('rejects private, link-local, mapped and reserved network destinations', () => {
    for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::ffff:127.0.0.1', 'fe80::1', 'fc00::1', '2001:db8::1']) expect(publicNetworkAddress(address), address).toBe(false);
    for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) expect(publicNetworkAddress(address), address).toBe(true);
  });
});

describe('committed Session transitions', () => {
  it('records connection-required before waiting and includes executor connection coordinates only on creation', async () => {
    const f = fixture(); await f.endpoint();
    const environment: StoredEnvironment = { sessionId: 'sess_external', status: 'pending', credentialReference: 'secret:env', environment: {
      id: 'env_external', type: 'self_hosted', remote_url: 'https://relay.example/agents/api', workspace_directory: '/workspace', capability_directories: [],
    } };
    await f.store.put({ ownerId: 'alice', id: 'env_external', collection: 'environments', createdAt: f.clock.now(), revision: 1, value: environment }, 0);
    const created = await f.create();
    const source = (await f.store.get<SessionState>('alice', 'sessions', created.id))!;
    const state = { ...source.value, session: { ...source.value.session, id: 'sess_external', environment: environment.environment }, turns: source.value.turns.map((binding) => ({ ...binding, turn: { ...binding.turn, session_id: 'sess_external' } })) };
    await f.store.put({ ...source, id: 'sess_external', value: state }, 0);
    const snapshot = (await f.store.get<SessionStreamSnapshot>('alice', 'session_observations', 'sess_external'))!.value;
    expect(snapshot.session).toMatchObject({ status: 'requires_action', required_actions: [{ type: 'environment_connection', environment_id: 'env_external' }] });
    const deliveries = (await f.fanout()).filter(({ value }) => value.event.data.id === 'sess_external');
    expect(deliveries.find(({ value }) => value.event.type === 'agent.session.created')?.value.event.data).toEqual({ id: 'sess_external', environment_id: 'env_external', environment_type: 'self_hosted', connect: { remote_url: 'https://relay.example/agents/api' } });
    expect(deliveries.find(({ value }) => value.event.type === 'agent.session.action_required')?.value.event.data).toEqual({ id: 'sess_external', required_action: { type: 'environment_connection' } });
    expect(deliveries.some(({ value }) => value.event.type === 'agent.session.in_progress')).toBe(false);
  });

  it('preserves function-required and completed transitions between stream polls and isolates late subscribers', async () => {
    const f = fixture(); await f.endpoint(); const session = await f.create();
    const baseline = await f.sessions.streamSnapshot('alice', session.id);
    const state = (await f.store.get<SessionState>('alice', 'sessions', session.id))!.value;
    const turn = state.turns[0]!.turn;
    const runtime = new SessionRuntimeStore(f.store);
    await runtime.claim('alice', session.id, 'run', f.clock.now());
    const active = { ...initialSessionRuntime(session.id, session.agent.id, 'root'), turns: [{ threadId: 'root', nativeTurnId: 'native', turn: { ...turn, status: 'in_progress' as const }, items: [] }] };
    await runtime.publish('alice', session.id, 'run', active);
    await runtime.publish('alice', session.id, 'run', { ...active, turns: active.turns.map((entry) => ({ ...entry, turn: { ...entry.turn, status: 'waiting' as const } })), requiredActions: [{ type: 'function_call', call_id: 'call', turn_id: turn.id, name: 'answer', arguments: {} }] });
    await runtime.publish('alice', session.id, 'run', { ...active, turns: active.turns.map((entry) => ({ ...entry, turn: { ...entry.turn, status: 'completed' as const, completed_at: f.clock.now() } })) });
    const controller = new AbortController();
    const events = [];
    for await (const event of f.sessions.stream('alice', session.id, controller.signal, false, baseline)) {
      parseAgentsContract('SessionEvent', event); events.push(event);
      if (event.type === 'agent.session.idle') controller.abort();
    }
    expect(events.map(({ type }) => type)).toContain('agent.session.requires_action');
    expect(events.map(({ type }) => type)).toContain('agent.session.turn.completed');
    const deliveries = await f.fanout();
    expect(deliveries.filter(({ value }) => value.event.type === 'agent.session.action_required').map(({ value }) => value.event.data)).toEqual([{ id: session.id, required_action: { type: 'function_call' } }]);
    const late = await f.sessions.streamSnapshot('alice', session.id);
    expect(late.eventRevision).toBeGreaterThan(baseline.eventRevision!);
    await runtime.publish('alice', session.id, 'run', active);
    const cancelled = new AbortController();
    const replay = [];
    for await (const event of f.sessions.stream('alice', session.id, cancelled.signal, false, late)) {
      replay.push(event); if (event.type === 'agent.session.in_progress') cancelled.abort();
    }
    expect(replay.map(({ type }) => type)).toEqual(['agent.session.turn.in_progress', 'agent.session.in_progress']);
  });

  it('fences a runtime writer that read the Session before its concurrent deletion', async () => {
    const f = fixture(); const session = await f.create();
    const source = (await f.store.get<SessionState>('alice', 'sessions', session.id))!;
    const before = (await f.store.list('alice', 'session_event_batches', { limit: 100 })).data;
    const commit = f.base.commit.bind(f.base);
    let entered!: () => void; let release!: () => void;
    const prepared = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    f.base.commit = async (writes) => {
      if (writes.some(({ resource }) => resource.collection === 'session_runtime')) { entered(); await blocked; }
      return commit(writes);
    };
    const writing = new SessionRuntimeStore(f.store).claim('alice', session.id, 'run', f.clock.now());
    await prepared;
    await f.store.delete(source);
    release(); await writing;
    expect(await f.store.get('alice', 'sessions', session.id)).toBeUndefined();
    expect((await f.store.list('alice', 'session_event_batches', { limit: 100 })).data).toEqual(before);
    await expect(f.sessions.streamSnapshot('alice', session.id)).rejects.toMatchObject({ status: 404 });
  });

  it('rolls back event generation with a failed source transaction and keeps its retry identity stable', async () => {
    const f = fixture(); const session = await f.create();
    const resource = (await f.store.get<SessionState>('alice', 'sessions', session.id))!;
    const before = structuredClone([...f.base.resources.values()]);
    const commit = f.base.commit.bind(f.base);
    f.base.commit = async () => { throw new AgentsApiError(409, 'source conflict', 'conflict'); };
    await expect(f.store.put({ ...resource, revision: resource.revision + 1 }, resource.revision)).rejects.toMatchObject({ code: 'conflict' });
    expect([...f.base.resources.values()]).toEqual(before);
    f.base.commit = commit;
    await f.store.put({ ...resource, revision: resource.revision + 1 }, resource.revision);
    expect((await f.store.list('alice', 'session_event_batches', { limit: 100 })).data).toHaveLength(2);
  });
});
