import { expect, it, vi } from 'vitest';
import { integrationFixture } from './integration-fixtures.js';
import { SessionEventStore } from '../../src/core/session-event-store.js';
import { SessionService } from '../../src/core/session-service.js';
import { AgentService } from '../../src/core/agent-service.js';
import type { SessionCaller } from '../../src/core/session-caller.js';
import type { SessionState } from '../../src/core/session-ports.js';
import { AgentsApiError } from '../../src/domain/agents-api-validation.js';
import { feedbackCollection } from '../../src/core/session-feedback-planning.js';

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
  expect(activity.inputs.map(receipt => receipt.actor.id).sort()).toEqual(['alice', 'alice', 'bob']);
  expect(activity.inputs.flatMap(receipt => receipt.message_ids)).toHaveLength(3);
  expect(activity.items.filter(item => item.type === 'message' && item.role === 'user')).toHaveLength(1);
  expect(activity.pending_inputs.flatMap(input => input.messages)).toHaveLength(2);
  expect(activity.session).not.toHaveProperty('actor');
  await f.sessions.dispatch('operator', f.session.id);
  expect(JSON.stringify(vi.mocked(f.execution.start).mock.calls[0]?.[2].input)).toContain('Authenticated participant');
  expect(f.execution.steer).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(vi.mocked(f.execution.steer).mock.calls[0]?.[3])).toContain('bob');
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
  expect(event.activity.pending_inputs.flatMap(input => input.messages)).toHaveLength(1);
  expect(f.execution.start).not.toHaveBeenCalled();
  removed = true;
  await expect(events.next()).rejects.toMatchObject({ status: 403 });
  const backlog = f.sessions.activityEvents('operator', f.session.id, abort.signal, { after: initial.cursor, revalidate });
  await expect(backlog.next()).rejects.toMatchObject({ status: 403 });
  const state = (await f.store.get<SessionState>('operator', 'sessions', f.session.id))!.value;
  expect(Object.values(state.receipts)).toHaveLength(1);
  expect(await f.sessions.hasPendingFeedback('operator', f.session.id)).toBe(true);
});

it('durably accepts a burst without rewriting shared Session state and preserves all contributors in one execution batch', async () => {
  const f = await fixture();
  await f.sessions.dispatch('operator', f.session.id);
  const before = (await f.store.get<SessionState>('operator', 'sessions', f.session.id))!;
  const contributors = Array.from({ length: 20 }, (_, index) => `person-${index}`);
  await Promise.all(contributors.map(id => f.sessions.events('operator', f.session.id, input(id), id, { waitForConnection: false, caller: caller(id) })));
  expect((await f.store.get('operator', 'sessions', f.session.id))!.revision).toBe(before.revision);
  const pending = await f.sessions.activity('operator', f.session.id);
  expect(pending.pending_inputs).toHaveLength(20);
  const messageIds = pending.pending_inputs.flatMap(entry => entry.messages.map(message => message.id)).sort();
  await f.sessions.dispatch('operator', f.session.id);
  await f.sessions.dispatch('operator', f.session.id);
  expect(f.execution.steer).toHaveBeenCalledTimes(1);
  expect(vi.mocked(f.execution.steer).mock.calls[0]![3]).toHaveLength(20);
  const final = await f.sessions.activity('operator', f.session.id);
  expect(final.pending_inputs).toEqual([]);
  expect(final.inputs.slice(1).flatMap(receipt => receipt.message_ids).sort()).toEqual(messageIds);
  expect(final.inputs.slice(1).map(receipt => receipt.actor.id).sort()).toEqual(contributors.sort());
  expect(final.inputs.every(receipt => receipt.status === 'dispatched')).toBe(true);
  await expect(f.sessions.events('operator', f.session.id, input('different'), 'person-0', { waitForConnection: false, caller: caller('person-0') })).rejects.toMatchObject({ code: 'idempotency_conflict' });
});

it('keeps accepted contributions visible as failed when the Session fails before dispatch', async () => {
  const f = await fixture();
  await f.sessions.dispatch('operator', f.session.id);
  await f.sessions.events('operator', f.session.id, input('Still recorded'), 'failure-race', { waitForConnection: false, caller: caller('bob') });
  const state = (await f.store.get<SessionState>('operator', 'sessions', f.session.id))!;
  await f.store.put({ ...state, revision: state.revision + 1, value: { ...state.value, session: { ...state.value.session, status: 'failed' } } }, state.revision);
  await f.sessions.dispatch('operator', f.session.id);
  const activity = await f.sessions.activity('operator', f.session.id);
  expect(activity.inputs.at(-1)?.status).toBe('failed');
  expect(activity.pending_inputs).toEqual([]);
  expect(JSON.stringify(activity.items)).toContain('Still recorded');
  expect(f.execution.steer).not.toHaveBeenCalled();
  expect(f.execution.start).toHaveBeenCalledTimes(1);
});

it('recovers materialized receipts after cleanup fails without replaying the batch', async () => {
  const f = await fixture();
  await f.sessions.dispatch('operator', f.session.id);
  await f.sessions.events('operator', f.session.id, input('Retain my ID'), 'cleanup-race', { waitForConnection: false, caller: caller('bob') });
  const remove = f.store.delete.bind(f.store);
  vi.spyOn(f.store, 'delete').mockImplementationOnce(async resource => { if (resource.collection === feedbackCollection(f.session.id)) throw new Error('lost cleanup'); return remove(resource); });
  await expect(f.sessions.dispatch('operator', f.session.id)).rejects.toThrow('lost cleanup');
  expect((await f.sessions.activity('operator', f.session.id)).inputs).toHaveLength(2);
  await f.sessions.dispatch('operator', f.session.id);
  expect(f.execution.steer).toHaveBeenCalledTimes(1);
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
