import { expect, it, vi } from 'vitest';
import { integrationFixture } from './integration-fixtures.js';
import { AgentService } from '../../src/core/agent-service.js';
import { SessionService } from '../../src/core/session-service.js';
import { SessionEventStore } from '../../src/core/session-event-store.js';
import { SessionRuntimeStore } from '../../src/core/session-runtime-store.js';
import { initialSessionRuntime } from '../../src/core/session-runtime-planning.js';
import { SessionSteerRejectedError } from '../../src/domain/session-errors.js';
import { AgentsResourceConflictError } from '../../src/domain/agents-api-validation.js';
import type { SessionState } from '../../src/core/session-ports.js';
import type { SessionIntegrationState } from '../../src/domain/session-integrations.js';

const input = (text: string) => ({ events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text }] }] }] });
async function fixture() {
  const f = await integrationFixture();
  const store = new SessionEventStore(f.store);
  const sessions = new SessionService({ store, agents: new AgentService({ store }), execution: f.execution });
  const session = await sessions.create('operator', { agent_id: f.agent.id, environment: { type: 'none' }, input: 'Original' });
  await sessions.dispatch('operator', session.id);
  await Promise.all(['alice', 'bob'].map(id => sessions.events('operator', session.id, input(id), 'same-key', { waitForConnection: false, caller: { actor: { id, kind: 'human' } } })));
  const accepted = (await store.get<SessionState>('operator', 'sessions', session.id))!.value;
  const original = accepted.turns[0]!;
  const completed = { ...original.turn, status: 'completed' as const, started_at: 1, completed_at: 2 };
  f.observations.set(original.turn.id, { turn: completed, requiredActions: [] });
  return { ...f, store, sessions, session, accepted, original, completed };
}

it('moves definitively rejected simultaneous inputs in order without changing receipts, messages, actors or settings', async () => {
  const f = await fixture();
  const applied: string[] = [];
  vi.mocked(f.execution.steer).mockImplementation(async (_owner, _session, turnId, input) => {
    if (turnId === f.original.turn.id) throw new SessionSteerRejectedError();
    applied.push(input.map(message => message.content.at(-1)).map(part => part?.type === 'input_text' ? part.text : '').join(''));
  });
  const start = f.execution.start;
  f.execution.start = vi.fn(async (...args: Parameters<typeof start>) => { applied.push(args[2].input[0]!.content.at(-1)!.type === 'input_text' ? (args[2].input[0]!.content.at(-1) as { text: string }).text : ''); await start(...args); });
  const commit = f.store.commit.bind(f.store);
  let contention = true;
  f.store.commit = async (writes, observations) => {
    if (contention && writes.some(write => write.resource.collection === 'sessions' && (write.resource.value as SessionState).turns.length > 1)) { contention = false; throw new AgentsResourceConflictError(); }
    return commit(writes, observations);
  };
  for (let attempt = 0; attempt < 4; attempt++) await f.sessions.dispatch('operator', f.session.id);
  const saved = (await f.store.get<SessionState>('operator', 'sessions', f.session.id))!.value;
  expect(saved.turns).toHaveLength(2);
  expect(saved.turns[0]!.input).toHaveLength(1);
  expect(saved.turns[1]!.input.map(message => ({ id: message.id, actor: message.actor, content: message.content, acceptedOrdinal: message.acceptedOrdinal })))
    .toEqual(f.original.input.slice(1).map(message => ({ id: message.id, actor: message.actor, content: message.content, acceptedOrdinal: message.acceptedOrdinal })));
  expect(saved.turns[1]!.modelSettings).toEqual(f.original.modelSettings);
  expect(saved.turns[1]!.configuration).toEqual(f.original.configuration);
  expect(applied).toEqual(['alice', 'bob']);
  expect(f.execution.start).toHaveBeenCalledTimes(1);
  for (const [key, before] of Object.entries(f.accepted.receipts)) {
    expect(saved.receipts[key]).toMatchObject({ digest: before.digest, sequence: before.sequence, ...(before.actor ? { actor: before.actor } : {}), dispatched: true });
  }
  const activity = await f.sessions.activity('operator', f.session.id);
  expect(activity.items.filter(item => item.type === 'message' && item.role === 'user').map(item => item.id).sort()).toEqual(f.original.input.map(message => message.id).sort());
  expect(activity.inputs.flatMap(receipt => receipt.message_ids)).toHaveLength(2);
});

it('retains an ambiguous steer and never creates a successor just because its Turn later completes', async () => {
  const f = await fixture();
  f.execution.steer = vi.fn(async () => { throw new Error('Control acknowledgement was lost'); });
  for (let attempt = 0; attempt < 2; attempt++) await expect(f.sessions.dispatch('operator', f.session.id)).rejects.toThrow('acknowledgement was lost');
  const saved = (await f.store.get<SessionState>('operator', 'sessions', f.session.id))!.value;
  expect(saved.turns).toEqual(f.accepted.turns);
  expect(saved.receipts).toEqual(f.accepted.receipts);
  expect(f.execution.start).toHaveBeenCalledTimes(1);
});

it.each([false, true])('keeps multiple message events in one receipt ordered when its first recovery start has acknowledged (completed=%s)', async completed => {
  const f = await integrationFixture();
  const session = await f.sessions.create('operator', { agent_id: f.agent.id, environment: { type: 'none' }, input: 'Original' });
  await f.sessions.dispatch('operator', session.id);
  await f.sessions.events('operator', session.id, { events: [...input('first').events, ...input('second').events] }, 'batch', { waitForConnection: false });
  const original = (await f.store.get<SessionState>('operator', 'sessions', session.id))!.value.turns[0]!;
  f.observations.set(original.turn.id, { turn: { ...original.turn, status: 'completed', started_at: 1, completed_at: 2 }, requiredActions: [] });
  const applied: string[] = [];
  const started = new Set<string>();
  const start = f.execution.start;
  f.execution.start = vi.fn(async (...args: Parameters<typeof start>) => {
    if (started.has(args[2].turn.id)) return;
    started.add(args[2].turn.id);
    applied.push((args[2].input[0]!.content.at(-1) as { text: string }).text);
    await start(...args);
  });
  f.execution.steer = vi.fn(async (_owner, _session, turnId, messages) => {
    if (turnId === original.turn.id) {
      if (completed && started.size) {
        const first = [...f.observations.values()].find(observation => started.has(observation.turn.id))!;
        f.observations.set(first.turn.id, { ...first, turn: { ...first.turn, status: 'completed', completed_at: 3 } });
        await f.sessions.completeReadyTurns('operator', session.id);
      }
      throw new SessionSteerRejectedError();
    }
    applied.push((messages[0]!.content.at(-1) as { text: string }).text);
  });
  for (let attempt = 0; attempt < 3; attempt++) await f.sessions.dispatch('operator', session.id);
  const state = (await f.store.get<SessionState>('operator', 'sessions', session.id))!.value;
  expect(state.turns).toHaveLength(completed ? 3 : 2);
  expect(state.turns.slice(1).flatMap(binding => binding.input.map(message => (message.content.at(-1) as { text: string }).text))).toEqual(['first', 'second']);
  expect(applied).toEqual(['first', 'second']);
  if (completed) {
    const history = vi.mocked(f.execution.start).mock.calls.at(-1)![3];
    expect(history?.flatMap(item => item.type === 'message' && item.role === 'user' ? item.content.flatMap(part => part.type === 'input_text' ? [part.text] : []) : []))
      .toEqual(['Original', 'first']);
  }
  expect(Object.values(state.receipts).every(receipt => receipt.dispatched)).toBe(true);
});

it('publishes completed activity directly from runtime while a rejected dispatch awaits acknowledgement', async () => {
  const f = await fixture();
  const runtimes = new SessionRuntimeStore(f.store);
  await runtimes.claim('operator', f.session.id, 'run', 1);
  await runtimes.publish('operator', f.session.id, 'run', { ...initialSessionRuntime(f.session.id, f.agent.id, 'thread'), turns: [{ turn: f.completed, threadId: 'thread', nativeTurnId: 'native', items: [] }] });
  const activity = await f.sessions.activity('operator', f.session.id);
  expect(activity.turns[0]?.status).toBe('completed');
  expect(activity.inputs.every(receipt => receipt.status === 'accepted')).toBe(true);
  expect((await f.store.get<SessionState>('operator', 'sessions', f.session.id))!.value.turns[0]?.turn.status).not.toBe('completed');
});

it('atomically moves an integration delivery with its rejected input while retaining concurrent delivery configuration', async () => {
  const f = await integrationFixture();
  const { sessionId } = await f.integrations.accept('operator', 'binding', 'thread', f.target, f.input);
  await f.integrations.submitPending('operator', sessionId);
  await f.sessions.dispatch('operator', sessionId);
  await f.integrations.accept('operator', 'binding', 'thread', f.target, { ...f.input, id: 'late', text: 'Later question' });
  await f.integrations.submitPending('operator', sessionId);
  const original = (await f.store.get<SessionState>('operator', 'sessions', sessionId))!.value.turns[0]!;
  f.observations.set(original.turn.id, { turn: { ...original.turn, status: 'completed', started_at: 1, completed_at: 2 }, requiredActions: [] });
  await f.sessions.completeReadyTurns('operator', sessionId);
  await f.integrations.deliverReady('operator', sessionId);
  const before = (await f.store.get<SessionIntegrationState>('operator', 'session_integrations', sessionId))!.value;
  expect(before.inputs.every(input => input.deliveryProcessed)).toBe(true);
  f.execution.steer = vi.fn(async () => { throw new SessionSteerRejectedError(); });
  const commit = f.store.commit.bind(f.store);
  let contention = true;
  f.store.commit = async (writes, observations) => {
    if (contention && writes.some(write => write.resource.collection === 'sessions') && writes.some(write => write.resource.collection === 'session_integrations')) {
      contention = false;
      const current = (await f.store.get<SessionIntegrationState>('operator', 'session_integrations', sessionId))!;
      await commit([{ resource: { ...current, revision: current.revision + 1, value: { ...current.value, target: { ...current.value.target, connectionSetId: 'new-delivery-connection' } } }, expectedRevision: current.revision }]);
    }
    return commit(writes, observations);
  };
  await f.sessions.dispatch('operator', sessionId);
  const state = (await f.store.get<SessionState>('operator', 'sessions', sessionId))!.value;
  const integration = (await f.store.get<SessionIntegrationState>('operator', 'session_integrations', sessionId))!.value;
  const successor = state.turns[1]!;
  expect(contention).toBe(false);
  expect(integration.inputs[0]).toEqual(before.inputs[0]);
  const { deliveryProcessed: _processed, ...pending } = before.inputs[1]!;
  expect(integration.inputs[1]).toEqual({ ...pending, turnId: successor.turn.id });
  expect(integration.target.connectionSetId).toBe('new-delivery-connection');
  await f.sessions.dispatch('operator', sessionId);
  f.observations.set(successor.turn.id, { turn: { ...successor.turn, status: 'completed', started_at: 2, completed_at: 3 }, requiredActions: [] });
  await f.sessions.completeReadyTurns('operator', sessionId);
  await f.integrations.deliverReady('operator', sessionId);
  expect(f.delivery.deliver).toHaveBeenLastCalledWith(expect.objectContaining({ turn: expect.objectContaining({ id: successor.turn.id }), source: pending.source, connectionSetId: 'new-delivery-connection' }));
  expect((await f.store.get<SessionIntegrationState>('operator', 'session_integrations', sessionId))!.value.inputs.every(input => input.deliveryProcessed)).toBe(true);
});


it('executes older accepted input before a newer queued successor without steering a Turn that has not started', async () => {
  const f = await fixture();
  await f.sessions.events('operator', f.session.id, input('newer'), 'newer', { waitForConnection: false, caller: { actor: { id: 'carol', kind: 'human' } } });
  const queued = (await f.store.get<SessionState>('operator', 'sessions', f.session.id))!.value.turns.at(-1)!;
  const applied: string[] = [];
  f.execution.steer = vi.fn(async (_owner, _session, turnId, input) => {
    if (turnId === f.original.turn.id) throw new SessionSteerRejectedError();
    expect(f.observations.has(turnId)).toBe(true);
    applied.push((input[0]!.content.at(-1) as { text: string }).text);
  });
  const start = f.execution.start;
  f.execution.start = vi.fn(async (...args: Parameters<typeof start>) => { applied.push((args[2].input[0]!.content.at(-1) as { text: string }).text); await start(...args); });
  await f.sessions.dispatch('operator', f.session.id);
  await f.sessions.dispatch('operator', f.session.id);
  await expect(f.sessions.dispatch('operator', f.session.id)).rejects.toMatchObject({ code: 'service_unavailable' });
  expect(applied).toEqual(['alice', 'bob']);
  const recovering = (await f.store.get<SessionState>('operator', 'sessions', f.session.id))!.value;
  expect(recovering.turns.map(binding => binding.turn.id)).toEqual([f.original.turn.id, expect.any(String), queued.turn.id]);
  const successor = recovering.turns[1]!;
  f.observations.set(successor.turn.id, { turn: { ...successor.turn, status: 'completed', started_at: 2, completed_at: 3 }, requiredActions: [] });
  await f.sessions.dispatch('operator', f.session.id);
  expect(applied).toEqual(['alice', 'bob', 'newer']);
  expect(f.execution.start).toHaveBeenCalledTimes(2);
  expect((await f.sessions.activity('operator', f.session.id)).inputs.every(receipt => receipt.status === 'dispatched')).toBe(true);
});
