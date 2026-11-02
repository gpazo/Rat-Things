import { describe, expect, it, vi } from 'vitest';
import { acceptIntegrationInput } from '../../src/core/session-integration-planning.js';
import type { SessionState } from '../../src/core/session-ports.js';
import { integrationFixture } from './integration-fixtures.js';
import { SessionDeliveryService } from '../../src/delivery/session-delivery.js';
import type { SessionDelivery, SessionIntegrationState } from '../../src/domain/session-integrations.js';

describe('provider Sessions', () => {
  it('silences empty candidate completions and replies to explicit requests', async () => {
    const f = await integrationFixture();
    const { sessionId } = await f.integrations.accept('operator', 'binding', 'thread', f.target, { ...f.input, admission: 'candidate' });
    await f.integrations.submitPending('operator', sessionId);
    const turn = (await f.sessions.turns('operator', sessionId)).data[0]!;
    const deliver = vi.fn(async () => {});
    const delivery = new SessionDeliveryService({ deliver });
    const request = { ownerId: 'operator', sessionId, source: f.input.source, turn: { ...turn, status: 'completed' as const }, items: [] };
    await delivery.deliver({ ...request, silentIfEmpty: true });
    expect(deliver).not.toHaveBeenCalled();
    await delivery.deliver(request);
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ body: 'Turn completed.' }));
  });
  it('delivers a mixed candidate and explicit Turn once and keeps its reply mandatory', async () => {
    const f = await integrationFixture();
    const { sessionId } = await f.integrations.accept('operator', 'binding', 'thread', f.target, { ...f.input, admission: 'candidate' });
    await f.integrations.submitPending('operator', sessionId);
    await f.sessions.dispatch('operator', sessionId);
    await f.integrations.accept('operator', 'binding', 'thread', f.target, { ...f.input, id: 'explicit', text: 'Please answer' });
    await f.integrations.submitPending('operator', sessionId);
    await f.sessions.dispatch('operator', sessionId);
    const turn = (await f.sessions.turns('operator', sessionId)).data[0]!;
    f.observations.set(turn.id, { turn: { ...turn, status: 'completed', completed_at: 2 }, requiredActions: [] });
    await f.sessions.completeReadyTurns('operator', sessionId);
    await f.integrations.deliverReady('operator', sessionId);
    expect(f.delivery.deliver).toHaveBeenCalledTimes(1);
    expect(f.delivery.deliver).toHaveBeenCalledWith(expect.objectContaining({ silentIfEmpty: false }));
  });
  it('keeps an empty explicit reply pending when promotion races a quiet delivery acknowledgement', async () => {
    const f = await integrationFixture();
    f.execution.items = async () => [];
    const { sessionId } = await f.integrations.accept('operator', 'binding', 'thread', f.target, { ...f.input, admission: 'candidate' });
    await f.integrations.submitPending('operator', sessionId);
    await f.sessions.dispatch('operator', sessionId);
    const turn = (await f.sessions.turns('operator', sessionId)).data[0]!;
    f.observations.set(turn.id, { turn: { ...turn, status: 'completed', completed_at: 2 }, requiredActions: [] });
    await f.sessions.completeReadyTurns('operator', sessionId);
    let enter!: () => void;
    let resume!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { resume = resolve; });
    deliveryMock(f).mockImplementationOnce(async input => {
      expect(input).toMatchObject({ silentIfEmpty: true, items: [] });
      enter();
      await gate;
    });

    const delivering = f.integrations.deliverReady('operator', sessionId);
    await entered;
    await f.integrations.accept('operator', 'binding', 'thread', f.target, f.input);
    resume();
    await delivering;

    let state = await f.store.get<SessionIntegrationState>('operator', 'session_integrations', sessionId);
    expect(state!.value.inputs[0]).toMatchObject({ admission: 'explicit' });
    expect(state!.value.inputs[0]!.deliveryProcessed).not.toBe(true);
    await f.integrations.deliverReady('operator', sessionId);
    expect(f.delivery.deliver).toHaveBeenCalledTimes(2);
    expect(f.delivery.deliver).toHaveBeenLastCalledWith(expect.objectContaining({ silentIfEmpty: false, items: [] }));
    state = await f.store.get<SessionIntegrationState>('operator', 'session_integrations', sessionId);
    expect(state!.value.inputs[0]).toMatchObject({ admission: 'explicit', deliveryProcessed: true });
    expect((await f.sessions.turns('operator', sessionId)).data).toHaveLength(1);
  });
  it('preserves a same-Turn explicit receipt appended during visible delivery without redelivery', async () => {
    const f = await integrationFixture();
    const { sessionId } = await f.integrations.accept('operator', 'binding', 'thread', f.target, { ...f.input, admission: 'candidate' });
    await f.integrations.submitPending('operator', sessionId);
    await f.sessions.dispatch('operator', sessionId);
    const turn = (await f.sessions.turns('operator', sessionId)).data[0]!;
    f.observations.set(turn.id, { turn: { ...turn, status: 'completed', completed_at: 2 }, requiredActions: [] });
    await f.sessions.completeReadyTurns('operator', sessionId);
    let enter!: () => void;
    let resume!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { resume = resolve; });
    deliveryMock(f).mockImplementationOnce(async input => {
      expect(input).toMatchObject({ silentIfEmpty: true, items: expect.arrayContaining([expect.objectContaining({ role: 'assistant' })]) });
      enter();
      await gate;
    });

    const delivering = f.integrations.deliverReady('operator', sessionId);
    await entered;
    await f.integrations.accept('operator', 'binding', 'thread', f.target, { ...f.input, id: 'explicit-later', text: 'Please answer' });
    const integration = await f.store.get<SessionIntegrationState>('operator', 'session_integrations', sessionId);
    const appended = { ...integration!, revision: integration!.revision + 1, value: { ...integration!.value, inputs: integration!.value.inputs.map(input => input.id === 'explicit-later' ? { ...input, turnId: turn.id } : input) } };
    await f.store.put(appended, integration!.revision);
    const originalPut = f.store.put.bind(f.store);
    let appendedDuringAck = false;
    vi.spyOn(f.store, 'put').mockImplementation(async (resource, revision) => {
      const value = resource.value as SessionIntegrationState;
      if (!appendedDuringAck && resource.collection === 'session_integrations' && value.inputs.some(input => input.turnId === turn.id && input.deliveryProcessed === true)) {
        appendedDuringAck = true;
        await f.integrations.accept('operator', 'binding', 'thread', f.target, { ...f.input, id: 'concurrent-later', text: 'A concurrent request' });
      }
      return originalPut(resource, revision);
    });
    resume();
    await delivering;

    const state = await f.store.get<SessionIntegrationState>('operator', 'session_integrations', sessionId);
    expect(appendedDuringAck).toBe(true);
    expect(state!.value.inputs).toHaveLength(3);
    expect(state!.value.inputs.slice(0, 2).every(input => input.turnId === turn.id && input.deliveryProcessed === true)).toBe(true);
    expect(state!.value.inputs[2]).toMatchObject({ id: 'concurrent-later', text: 'A concurrent request' });
    await f.integrations.deliverReady('operator', sessionId);
    expect(f.delivery.deliver).toHaveBeenCalledTimes(1);
  });
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
  it('redacts a planted secret before provider delivery and fails closed when credentials cannot be read', async () => {
    const f = await integrationFixture();
    const { sessionId } = await f.integrations.accept('operator', 'binding', 'thread', f.target, f.input);
    await f.integrations.submitPending('operator', sessionId);
    const state = (await f.store.get<SessionState>('operator', 'sessions', sessionId))!.value;
    const turn = { ...state.turns[0]!.turn, status: 'completed' as const };
    const items = [{ id: 'planted', type: 'message' as const, role: 'assistant' as const, status: 'completed' as const, phase: 'final_answer' as const, turn_id: turn.id, content: [{ type: 'output_text' as const, text: 'answer planted-private-token' }] }];
    const input = { ownerId: 'operator', sessionId, source: f.input.source, turn, items };
    const deliver = vi.fn(async () => {});
    const read = vi.fn(async () => ['planted-private-token']);
    await new SessionDeliveryService({ deliver }, read).deliver(input);
    expect(read).toHaveBeenCalledWith('operator', sessionId);
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ body: 'answer [REDACTED]' }));
    deliver.mockClear();
    await expect(new SessionDeliveryService({ deliver }, async () => { throw new Error('unavailable'); }).deliver(input)).rejects.toThrow('unavailable');
    expect(deliver).not.toHaveBeenCalled();
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

function deliveryMock(f: Awaited<ReturnType<typeof integrationFixture>>) {
  return f.delivery.deliver as unknown as { mockImplementationOnce(implementation: (input: SessionDelivery) => Promise<void>): unknown };
}
