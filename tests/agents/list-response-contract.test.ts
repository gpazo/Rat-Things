import OpenAI from 'openai';
import { describe, expect, it, vi } from 'vitest';
import { AgentService } from '../../src/core/agent-service.js';
import { SessionService } from '../../src/core/session-service.js';
import type { SessionExecution } from '../../src/core/session-ports.js';
import { routeAgentsRequest } from '../../src/lambdas/agents-router.js';
import { MemoryAgentsStore } from './fixtures.js';

function fixture() {
  const store = new MemoryAgentsStore();
  let sequence = 0;
  const ids = { next: (prefix: string) => `${prefix}_${String(++sequence).padStart(6, '0')}` };
  const clock = { now: () => sequence };
  const agents = new AgentService({ store, ids, clock });
  const execution: SessionExecution = {
    prepare: async (_owner, _id, environment) => {
      if (environment.type !== 'none') throw new Error('The list fixture has no environment backend.');
      return environment;
    },
    start: async () => {}, steer: async () => {}, cancel: async () => {}, toolResult: async () => {},
    observe: async (_owner, _session, turn) => ({ turn, requiredActions: [] }),
    items: async () => [], artifacts: async () => [],
    artifactContent: async () => new ReadableStream({ start(controller) { controller.close(); } }),
  };
  const sessions = new SessionService({ store, agents, execution, ids, clock });
  const request = (path: string, init?: RequestInit, owner = 'alice') =>
    routeAgentsRequest(new Request(`https://rat.invalid/v1/${path}`, init), owner, { agents, sessions });
  const client = new OpenAI({ apiKey: 'test', baseURL: 'https://rat.invalid/v1', maxRetries: 0,
    fetch: (input, init) => routeAgentsRequest(new Request(input, init), 'alice', { agents, sessions }),
  });
  // Inspect the wire body: the SDK's CursorPage wrapper does not expose these fields.
  const list = async (path: string, owner = 'alice') => {
    const response = await routeAgentsRequest(new Request(`https://rat.invalid/v1/${path}`), owner, { agents, sessions });
    expect(response.status).toBe(200);
    return response.json() as Promise<{ object: string; data: Array<{ id: string }>; has_more: boolean; first_id: string | null; last_id: string | null }>;
  };
  return { agents, sessions, list, request, client, store };
}

describe('Agents HTTP query and path contracts', () => {
  it.each(['agents', 'sessions'] as const)('accepts the SDK encoding of a nullable %s list limit', async resource => {
    const f = fixture();
    const agent = await f.agents.create('alice', { model: 'test' });
    if (resource === 'sessions') await f.sessions.create('alice', { agent_id: agent.id, environment: { type: 'none' }, input: 'Queued' });
    const api = resource === 'agents' ? f.client.beta.agents : f.client.beta.agents.sessions;
    // RequestOptions can express the documented null even though this SDK's
    // inherited CursorPageParams omits null from its TypeScript limit type.
    const page = await api.list({}, { query: { limit: null } });
    expect(page.data).toEqual((await api.list()).data);
    expect(page.data).toHaveLength(1);
  });

  it.each(['0', '-1', '1.5', 'null', 'NaN', '%20', '+', '1&limit=2'])('rejects invalid or repeated limit %j before listing', async limit => {
    const f = fixture();
    const list = vi.spyOn(f.store, 'list');
    const response = await f.request(`agents?limit=${limit}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { type: 'invalid_request_error', param: 'limit' } });
    expect(list).not.toHaveBeenCalled();
  });

  it('decodes Agent resource IDs once for read, update and deletion without changing ownership', async () => {
    const f = fixture();
    const agent = await f.agents.create('alice', { model: 'test' });
    const path = `agents/%61${agent.id.slice(1)}`;
    expect(await (await f.request(path)).json()).toEqual(agent);
    expect((await f.request(path, undefined, 'bob')).status).toBe(404);
    expect((await f.request(`agents/%2561${agent.id.slice(1)}`)).status).toBe(404);
    const updated = await f.request(path, { method: 'POST', body: JSON.stringify({ name: 'Updated' }) });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ id: agent.id, name: 'Updated' });
    expect((await f.request(path, { method: 'DELETE' })).status).toBe(200);
    await expect(f.agents.retrieve('alice', agent.id)).rejects.toMatchObject({ status: 404 });
  });

  it.each(['%', '%FF', '%E2%82'])('rejects malformed path encoding %s before accessing storage', async path => {
    const f = fixture();
    const get = vi.spyOn(f.store, 'get');
    const response = await f.request(`agents/${path}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { type: 'invalid_request_error', code: 'invalid_request' } });
    expect(get).not.toHaveBeenCalled();
  });
});

describe('list response alignment with the documented HTTP examples', () => {
  it.each(['asc', 'desc'] as const)('returns Agent boundary IDs for %s pages and null for an empty page', async order => {
    const f = fixture();
    const first = await f.agents.create('alice', { model: 'test' });
    const second = await f.agents.create('alice', { model: 'test' });
    const expected = order === 'asc' ? [first.id, second.id] : [second.id, first.id];
    const page = await f.list(`agents?order=${order}&limit=1`);
    expect(page).toMatchObject({ object: 'list', data: [{ id: expected[0] }], has_more: true, first_id: expected[0], last_id: expected[0] });
    const next = await f.list(`agents?order=${order}&limit=1&after=${page.last_id}`);
    expect(next).toMatchObject({ data: [{ id: expected[1] }], has_more: false, first_id: expected[1], last_id: expected[1] });
    expect(await f.list(`agents?order=${order}&after=${next.last_id}`)).toEqual({ object: 'list', data: [], has_more: false, first_id: null, last_id: null });
    expect(await f.list('agents', 'bob')).toEqual({ object: 'list', data: [], has_more: false, first_id: null, last_id: null });
  });

  it.each(['asc', 'desc'] as const)('returns filtered Session boundary IDs in %s order across sparse storage pages', async order => {
    const f = fixture();
    const selected = await f.agents.create('alice', { model: 'test' });
    const other = await f.agents.create('alice', { model: 'test' });
    const create = (agentId: string) => f.sessions.create('alice', { agent_id: agentId, environment: { type: 'none' }, input: 'Queued fixture input' });
    const first = await create(selected.id);
    for (let index = 0; index < 101; index++) await create(other.id);
    const second = await create(selected.id);
    const expected = order === 'asc' ? [first.id, second.id] : [second.id, first.id];
    const query = `agents/sessions?agent_id=${selected.id}&order=${order}&limit=1`;
    const page = await f.list(query);
    expect(page).toMatchObject({ object: 'list', data: [{ id: expected[0] }], has_more: true, first_id: expected[0], last_id: expected[0] });
    const next = await f.list(`${query}&after=${page.last_id}`);
    expect(next).toMatchObject({ data: [{ id: expected[1] }], has_more: false, first_id: expected[1], last_id: expected[1] });
    expect(await f.list(`${query}&after=${next.last_id}`)).toEqual({ object: 'list', data: [], has_more: false, first_id: null, last_id: null });
    expect(await f.list(query, 'bob')).toEqual({ object: 'list', data: [], has_more: false, first_id: null, last_id: null });
  });
});
