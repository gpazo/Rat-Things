import { describe, expect, it, vi } from 'vitest';
import { acceptIntegrationInput } from '../../src/core/session-integration-planning.js';
import type { SessionState } from '../../src/core/session-ports.js';
import { integrationFixture } from './integration-fixtures.js';
import { SessionDeliveryService } from '../../src/delivery/session-delivery.js';

describe('provider Sessions', () => {
  it('accepts concurrent duplicate occurrences once and rejects changed payloads', async () => {
    const f = await integrationFixture();
    const accept = () => f.integrations.accept('operator', 'binding', 'thread', f.target, f.input);
    const [one, two] = await Promise.all([accept(), accept()]);
    expect(two).toEqual(one);
    await f.integrations.submitPending('operator', one.sessionId);
    await f.integrations.submitPending('operator', one.sessionId);
    await f.sessions.dispatch('operator', one.sessionId);
    expect(f.execution.start).toHaveBeenCalledTimes(1);
    expect((await f.sessions.turns('operator', one.sessionId)).data).toHaveLength(1);
    await expect(f.integrations.accept('operator', 'binding', 'thread', f.target, { ...f.input, text: 'Changed' })).rejects.toMatchObject({ code: 'idempotency_conflict' });
    await expect(f.sessions.retrieve('another-owner', one.sessionId)).rejects.toMatchObject({ status: 404 });
  });
  it('recovers after creating a Session but losing the integration acknowledgement', async () => {
    const f = await integrationFixture();
    const { sessionId } = await f.integrations.accept('operator', 'binding', 'thread', f.target, f.input);
    const put = f.store.put.bind(f.store);
    let failed = false;
    vi.spyOn(f.store, 'put').mockImplementation(async (resource, revision) => {
      if (resource.collection === 'session_integrations' && revision === 1 && !failed) { failed = true; throw new Error('Lost acknowledgement'); }
      return put(resource, revision);
    });
    await expect(f.integrations.submitPending('operator', sessionId)).rejects.toThrow('Lost acknowledgement');
    await f.integrations.submitPending('operator', sessionId);
    expect((await f.sessions.items('operator', sessionId)).data.filter((item) => item.type === 'message' && item.role === 'user')).toHaveLength(1);
    expect((await f.sessions.list('operator')).data).toHaveLength(1);
  });
  it('steers a live root Turn and starts a new Turn after completion', async () => {
    const f = await integrationFixture();
    const { sessionId } = await f.integrations.accept('operator', 'binding', 'thread', f.target, f.input);
    await f.integrations.submitPending('operator', sessionId);
    await f.sessions.dispatch('operator', sessionId);
    await f.integrations.accept('operator', 'binding', 'thread', f.target, { ...f.input, id: 'event-2', text: 'Also check this' });
    await f.integrations.submitPending('operator', sessionId);
    await f.sessions.dispatch('operator', sessionId);
    expect(f.execution.steer).toHaveBeenCalledTimes(1);
    const turn = (await f.sessions.turns('operator', sessionId)).data[0]!;
    f.observations.set(turn.id, { turn: { ...turn, status: 'completed', completed_at: 2 }, requiredActions: [] });
    await f.sessions.completeReadyTurns('operator', sessionId);
    await f.integrations.deliverReady('operator', sessionId);
    expect(f.delivery.deliver).toHaveBeenCalledWith(expect.objectContaining({ sessionId, turn: expect.objectContaining({ status: 'completed' }) }));
    await f.integrations.accept('operator', 'binding', 'thread', f.target, { ...f.input, id: 'event-3', text: 'Next question' });
    await f.integrations.submitPending('operator', sessionId);
    expect((await f.sessions.turns('operator', sessionId)).data).toHaveLength(2);
  });
  it('does not resurrect a deleted Session after losing the first input acknowledgement', async () => {
    const f = await integrationFixture();
    const { sessionId } = await f.integrations.accept('operator', 'binding', 'thread', f.target, f.input);
    const put = f.store.put.bind(f.store);
    vi.spyOn(f.store, 'put').mockImplementation(async (resource, revision) => {
      if (resource.collection === 'session_integrations' && revision === 1) throw new Error('Lost acknowledgement');
      return put(resource, revision);
    });
    await expect(f.integrations.submitPending('operator', sessionId)).rejects.toThrow('Lost acknowledgement');
    await f.sessions.dispatch('operator', sessionId);
    await f.sessions.delete('operator', sessionId);
    await expect(f.integrations.submitPending('operator', sessionId)).rejects.toMatchObject({ status: 404 });
    expect((await f.sessions.list('operator')).data).toEqual([]);
    expect(f.execution.start).toHaveBeenCalledTimes(1);
  });
  it('delivers cancellation at the Turn boundary', async () => {
    const f = await integrationFixture();
    const { sessionId } = await f.integrations.accept('operator', 'binding', 'thread', f.target, f.input);
    await f.integrations.submitPending('operator', sessionId);
    await f.sessions.dispatch('operator', sessionId);
    await f.sessions.events('operator', sessionId, { events: [{ type: 'agent.session.input.cancel' }] });
    await f.sessions.dispatch('operator', sessionId);
    await f.sessions.completeReadyTurns('operator', sessionId);
    await f.integrations.deliverReady('operator', sessionId);
    expect(f.delivery.deliver).toHaveBeenCalledWith(expect.objectContaining({ turn: expect.objectContaining({ status: 'cancelled' }) }));
    await f.integrations.deliverReady('operator', sessionId);
    expect(f.delivery.deliver).toHaveBeenCalledTimes(1);
  });
  it('keeps the source plan immutable and preserves empty destinations', async () => {
    const f = await integrationFixture();
    const target = { ...f.target, destinations: [] };
    const before = structuredClone({ target, input: f.input });
    const state = acceptIntegrationInput(undefined, target, f.input);
    expect({ target, input: f.input }).toEqual(before);
    expect(state.target.destinations).toEqual([]);
    expect(acceptIntegrationInput(state, f.target, f.input)).toBe(state);
  });
  it('formats saved root output with Session and Turn identities', async () => {
    const f = await integrationFixture();
    const { sessionId } = await f.integrations.accept('operator', 'binding', 'thread', f.target, f.input);
    await f.integrations.submitPending('operator', sessionId);
    const state = (await f.store.get<SessionState>('operator', 'sessions', sessionId))!.value;
    const turn = state.turns[0]!.turn;
    const deliver = vi.fn(async () => {});
    await new SessionDeliveryService({ deliver }).deliver({ ownerId: 'operator', sessionId, source: f.input.source, turn: { ...turn, status: 'completed' }, items: await f.execution.items('operator', state.session, turn.id) });
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ body: 'The answer', execution: expect.objectContaining({ id: turn.id, sessionId, credentialOwnerId: 'operator' }) }));
  });
});
