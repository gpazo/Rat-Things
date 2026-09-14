import { describe, expect, it } from 'vitest';
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
  // Inspect the wire body: the SDK's CursorPage wrapper does not expose these fields.
  const list = async (path: string, owner = 'alice') => {
    const response = await routeAgentsRequest(new Request(`https://rat.invalid/v1/${path}`), owner, { agents, sessions });
    expect(response.status).toBe(200);
    return response.json() as Promise<{ object: string; data: Array<{ id: string }>; has_more: boolean; first_id: string | null; last_id: string | null }>;
  };
  return { agents, sessions, list };
}

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
