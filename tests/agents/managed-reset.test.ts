import { expect, it, vi } from 'vitest';
import { AgentService } from '../../src/core/agent-service.js';
import { EnvironmentService, type StoredEnvironment } from '../../src/core/environment-service.js';
import { EnvironmentTemplateService } from '../../src/core/environment-template-service.js';
import { SessionEventStore, type SessionEventBatch } from '../../src/core/session-event-store.js';
import { SessionService } from '../../src/core/session-service.js';
import type { SessionState } from '../../src/core/session-ports.js';
import type { SessionStreamSnapshot } from '../../src/core/session-stream.js';
import { MemoryAgentsStore } from './fixtures.js';

async function fixture() {
  const base = new MemoryAgentsStore();
  const clock = { now: () => 100 };
  const store = new SessionEventStore(base, clock);
  const environments = new EnvironmentService({ store, clock, templates: new EnvironmentTemplateService({ store }), managedFiles: async () => [],
    credentials: { create: async () => 'unused', read: async () => ({ harness: '', executor: '' }), revoke: async () => {} },
  });
  const sessions = new SessionService({ store, clock, agents: new AgentService({ store }), execution: {
    prepare: (owner, session, environment) => environments.prepare(owner, session, environment),
    environment: (owner, session) => session.environment.type === 'none' ? Promise.resolve(undefined) : environments.state(owner, session.environment.id),
    start: async () => {}, steer: async () => {}, cancel: async () => {}, toolResult: async () => {},
    observe: async (_owner, _session, turn) => ({ turn, requiredActions: [] }), items: async () => [], artifacts: async () => [], artifactContent: async () => new ReadableStream(),
  } });
  const session = await sessions.create('alice', { agent: { model: 'test' }, environment: { type: 'openai_hosted' }, input: 'Remember this conversation.' });
  if (session.environment.type !== 'openai_hosted') throw new Error('Missing hosted environment');
  const id = session.environment.id;
  const state = (await store.get<SessionState>('alice', 'sessions', session.id))!;
  await store.put({ ...state, revision: state.revision + 1, value: { ...state.value, turns: state.value.turns.map(binding => ({ ...binding, turn: { ...binding.turn, status: 'completed' as const } })) } }, state.revision);
  await environments.attachManaged('alice', id, 'first');
  await environments.managedReady('alice', id, 'first', { id: 'sandbox_1', replaced: false });
  const events = async () => (await store.list<SessionEventBatch>('alice', 'session_event_batches', { limit: 100, order: 'asc' })).data.flatMap(batch => batch.value.events);
  return { base, store, environments, sessions, session, id, events };
}

it('keeps history and the environment ID, commits one reset per replacement, and fences stale workers', async () => {
  const f = await fixture();
  const items = await f.sessions.items('alice', f.session.id);
  await f.environments.managedStatus('alice', f.id, 'first', 'disconnected');
  expect((await f.sessions.retrieve('alice', f.session.id)).status).toBe('idle');
  await f.environments.attachManaged('alice', f.id, 'second');
  expect(await f.environments.managedPrepared('alice', f.id, 'second')).toBe(true);
  await f.environments.managedReady('alice', f.id, 'second', { id: 'sandbox_2', replaced: true });
  await f.environments.managedReady('alice', f.id, 'second', { id: 'sandbox_2', replaced: true });
  await f.environments.attachManaged('alice', f.id, 'second');
  expect((await f.environments.retrieve('alice', f.id)).status).toBe('connected');
  expect((await f.sessions.retrieve('alice', f.session.id)).environment).toMatchObject({ id: f.id });
  expect(await f.sessions.items('alice', f.session.id)).toEqual(items);
  await expect(f.environments.managedReady('alice', f.id, 'first', { id: 'stale', replaced: true })).rejects.toThrow('authority');
  await expect(f.environments.managedStatus('alice', f.id, 'first', 'failed')).rejects.toThrow('authority');
  const resets = (await f.events()).filter(event => event.type === 'agent.session.environment.reset');
  expect(resets).toEqual([{ type: 'agent.session.environment.reset', session_id: f.session.id, environment_id: f.id, turn_id: null, reset_count: 1, event_id: expect.any(String) }]);
  expect((await f.store.get<SessionStreamSnapshot>('alice', 'session_observations', f.session.id))?.value.environmentResetCount).toBe(1);
  await expect(f.environments.retrieve('bob', f.id)).rejects.toMatchObject({ status: 404 });
});

it('does not increment again after a committed readiness response is lost', async () => {
  const f = await fixture();
  await f.environments.attachManaged('alice', f.id, 'second');
  const commit = f.base.commit.bind(f.base);
  vi.spyOn(f.base, 'commit').mockImplementationOnce(async writes => { await commit(writes); throw new Error('Lost acknowledgement'); });
  await expect(f.environments.managedReady('alice', f.id, 'second', { id: 'sandbox_2', replaced: true })).rejects.toThrow('Lost acknowledgement');
  await f.environments.managedReady('alice', f.id, 'second', { id: 'sandbox_2', replaced: true });
  await f.environments.attachManaged('alice', f.id, 'third');
  await f.environments.managedReady('alice', f.id, 'third', { id: 'sandbox_3', replaced: true });
  expect((await f.events()).flatMap(event => event.type === 'agent.session.environment.reset' ? [event.reset_count] : [])).toEqual([1, 2]);
  expect((await f.store.get<StoredEnvironment>('alice', 'environments', f.id))?.value.resetCount).toBe(2);
});

it('keeps explicit expiry and deletion terminal instead of resetting retired sandboxes', async () => {
  const f = await fixture();
  await f.environments.managedStatus('alice', f.id, 'first', 'expired');
  expect((await f.sessions.retrieve('alice', f.session.id)).status).toBe('failed');
  await expect(f.environments.attachManaged('alice', f.id, 'second')).rejects.toMatchObject({ status: 409 });
  await f.environments.retire('alice', f.id);
  await expect(f.environments.managedReady('alice', f.id, 'first', { id: 'new', replaced: true })).rejects.toThrow('authority');
  expect((await f.events()).filter(event => event.type === 'agent.session.environment.reset')).toEqual([]);
});
