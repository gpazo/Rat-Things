import { expect, it, vi } from 'vitest';
import { integrationFixture } from './integration-fixtures.js';
import { SessionEventStore } from '../../src/core/session-event-store.js';
import { SessionService } from '../../src/core/session-service.js';
import { AgentService } from '../../src/core/agent-service.js';
import type { SessionCaller } from '../../src/core/session-caller.js';
import type { SessionState } from '../../src/core/session-ports.js';
import { AgentsApiError } from '../../src/domain/agents-api-validation.js';

const input = (text: string) => ({ events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text }] }] }] });
const caller = (id: string): SessionCaller => ({ actor: { id, kind: 'human', issuer: 'https://identity.example', subject: id } });
async function fixture() {
  const fixture = await integrationFixture();
  const store = new SessionEventStore(fixture.store);
  const sessions = new SessionService({ store, agents: new AgentService({ store }), execution: fixture.execution, streamIntervalMs: 5 });
  const session = await sessions.create('operator', { agent_id: fixture.agent.id, environment: { type: 'none' }, input: 'Goal' }, undefined, undefined, undefined, caller('alice'));
  return { ...fixture, store, sessions, session };
}

it('accepts concurrent participant inputs in one order with actor-scoped retry receipts and trusted native attribution', async () => {
  const f = await fixture();
  await Promise.all([
    f.sessions.events('operator', f.session.id, input('I disagree.'), 'same-key', { waitForConnection: false, caller: caller('alice') }),
    f.sessions.events('operator', f.session.id, input('Try the other direction.'), 'same-key', { waitForConnection: false, caller: caller('bob') }),
  ]);
  await f.sessions.events('operator', f.session.id, input('I disagree.'), 'same-key', { waitForConnection: false, caller: caller('alice') });
  const activity = await f.sessions.activity('operator', f.session.id);
  expect(activity.inputs.map(receipt => receipt.sequence)).toEqual([1, 2, 3]);
  expect(activity.inputs.map(receipt => receipt.actor.id)).toEqual(['alice', 'alice', 'bob']);
  expect(activity.inputs.flatMap(receipt => receipt.message_ids)).toHaveLength(3);
  expect(activity.items.filter(item => item.type === 'message' && item.role === 'user')).toHaveLength(3);
  expect(activity.session).not.toHaveProperty('actor');
  await f.sessions.dispatch('operator', f.session.id);
  expect(JSON.stringify(vi.mocked(f.execution.start).mock.calls[0]?.[2].input)).toContain('Authenticated participant');
  expect(JSON.stringify(vi.mocked(f.execution.steer).mock.calls[1]?.[3])).toContain('bob');
  expect((await f.sessions.activity('operator', f.session.id)).inputs.every(receipt => receipt.status === 'dispatched')).toBe(true);
});

it('rejects membership removal before acceptance but keeps already accepted work after removal', async () => {
  const f = await fixture();
  await f.store.put({ ownerId: 'operator', collection: 'bindings', id: 'alice', revision: 1, createdAt: 1, value: {} }, 0);
  const authority: SessionCaller = { ...caller('alice'), observations: [{ ownerId: 'operator', collection: 'bindings', id: 'alice', revision: 1 }] };
  await f.sessions.events('operator', f.session.id, input('Accepted first'), 'first', { waitForConnection: false, caller: authority });
  await f.store.put({ ownerId: 'operator', collection: 'bindings', id: 'alice', revision: 2, createdAt: 1, value: { removed: true } }, 1);
  await expect(f.sessions.events('operator', f.session.id, input('Removed first'), 'second', { waitForConnection: false, caller: authority })).rejects.toMatchObject({ code: 'conflict' });
  await f.sessions.dispatch('operator', f.session.id);
  const snapshot = await f.sessions.activity('operator', f.session.id);
  expect(snapshot.inputs).toHaveLength(2);
  expect(snapshot.inputs.every(receipt => receipt.status === 'dispatched')).toBe(true);
  await expect(f.sessions.events('operator', f.session.id, input('Expired'), 'third', { waitForConnection: false, caller: { ...caller('alice'), expiresAt: Date.now() - 1 } })).rejects.toMatchObject({ status: 401 });
});

it('replays a coherent snapshot and cursor without model calls, and revokes visibility before backlog and while idle', async () => {
  const f = await fixture();
  const initial = await f.sessions.activity('operator', f.session.id);
  await f.sessions.events('operator', f.session.id, input('Later'), 'later', { waitForConnection: false, caller: caller('bob') });
  const abort = new AbortController();
  let removed = false;
  const revalidate = vi.fn(async () => { if (removed) throw new AgentsApiError(403, 'Access removed.', 'forbidden'); });
  const events = f.sessions.activityEvents('operator', f.session.id, abort.signal, { after: initial.cursor, revalidate });
  const event = (await events.next()).value!;
  expect(event.activity.cursor).toBe(event.event_id);
  expect(event.activity.inputs).toHaveLength(2);
  expect(event.activity.items.filter(item => item.type === 'message' && item.role === 'user')).toHaveLength(2);
  expect(f.execution.start).not.toHaveBeenCalled();
  removed = true;
  await expect(events.next()).rejects.toMatchObject({ status: 403 });
  const backlog = f.sessions.activityEvents('operator', f.session.id, abort.signal, { after: initial.cursor, revalidate });
  await expect(backlog.next()).rejects.toMatchObject({ status: 403 });
  const state = (await f.store.get<SessionState>('operator', 'sessions', f.session.id))!.value;
  expect(Object.values(state.receipts)).toHaveLength(2);
});

it('resumes standard events after the exact durable event ID and checks access before replay', async () => {
  const f = await fixture();
  const batches = await f.store.list<import('../../src/core/session-event-store.js').SessionEventBatch>('operator', 'session_event_batches', { order: 'asc' });
  const events = batches.data[0]!.value.events;
  expect(events.length).toBeGreaterThan(1);
  const abort = new AbortController();
  const stream = f.sessions.stream('operator', f.session.id, abort.signal, false, undefined, { after: events[0]!.event_id });
  expect((await stream.next()).value?.event_id).toBe(events[1]!.event_id);
  abort.abort();
  await stream.return();
  const denied = f.sessions.stream('operator', f.session.id, new AbortController().signal, false, undefined, {
    after: events[0]!.event_id, revalidate: async () => { throw new AgentsApiError(403, 'Removed', 'forbidden'); },
  });
  await expect(denied.next()).rejects.toMatchObject({ status: 403 });
});
