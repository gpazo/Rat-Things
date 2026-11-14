import { expect, it, vi } from 'vitest';
import { integrationFixture } from './integration-fixtures.js';
import { AgentService } from '../../src/core/agent-service.js';
import { SessionEventStore } from '../../src/core/session-event-store.js';
import { SessionService } from '../../src/core/session-service.js';
import { initialSessionRuntime, type SessionRuntimeState } from '../../src/core/session-runtime-planning.js';
import type { SessionState } from '../../src/core/session-ports.js';
import { routeActions, iamApiPrincipal } from '../../src/domain/api-permissions.js';
import { routeAgentsRequest } from '../../src/lambdas/agents-router.js';

async function fixture() {
  const f = await integrationFixture();
  const store = new SessionEventStore(f.store);
  const agents = new AgentService({ store });
  const sessions = new SessionService({ store, agents, execution: f.execution });
  const session = await sessions.create('operator', { agent: { model: 'test' }, environment: { type: 'none' }, input: 'Make the launch clearer' }, undefined, undefined, undefined,
    { actor: { id: 'designer', kind: 'human' }, permissions: ['read', 'contribute'] });
  await sessions.dispatch('operator', session.id);
  const resource = (await store.get<SessionState>('operator', 'sessions', session.id))!;
  const turn = resource.value.turns[0]!.turn;
  const source = (await sessions.activity('operator', session.id)).inputs[0]!.message_ids[0]!;
  const item = { id: 'launch', text: 'Clarify the launch', state: 'working', source_message_ids: [source], result_links: [] };
  async function call(callId: string, expected: number, items = [item]) {
    const action = { type: 'function_call' as const, name: 'rat_things_plan_update', turn_id: turn.id, call_id: callId, arguments: { expected_revision: expected, items } };
    const snapshot: SessionRuntimeState = { ...initialSessionRuntime(session.id, session.agent.id, 'root'),
      turns: [{ threadId: 'root', nativeTurnId: 'native', turn: { ...turn, status: 'waiting' }, items: [] }], requiredActions: [action] };
    const previous = await store.get('operator', 'local_runtime', session.id);
    await store.put({ ownerId: 'operator', collection: 'local_runtime', id: session.id, createdAt: previous?.createdAt ?? 1, revision: (previous?.revision ?? 0) + 1, value: snapshot }, previous?.revision ?? 0);
    f.observations.set(turn.id, { turn: { ...turn, status: 'waiting' }, requiredActions: [action] });
    return action;
  }
  f.execution.toolResult = vi.fn(async (_owner, _session, event) => {
    f.observations.set(turn.id, { turn: { ...turn, status: 'in_progress' }, requiredActions: [] });
    expect(event.call_id).toBeTruthy();
  });
  return { ...f, store, agents, sessions, session, turn, source, item, call };
}

it('publishes an agent-owned Plan with attributed sources and immutable revisions exactly once', async () => {
  const f = await fixture();
  await f.call('one', 0);
  expect((await f.sessions.retrieve('operator', f.session.id)).required_actions).toEqual([]);
  expect((await f.sessions.activity('operator', f.session.id)).session.required_actions).toEqual([]);
  await f.sessions.resolvePlanTools('operator', f.session.id);
  await f.sessions.resolvePlanTools('operator', f.session.id);
  const first = await f.sessions.activity('operator', f.session.id);
  expect(first.plan).toMatchObject({ revision: 1, items: [{ id: 'launch', state: 'working', source_refs: [{ message_id: f.source }], updated_by: { agent_id: f.session.agent.id, turn_id: f.turn.id } }] });
  expect(f.execution.toolResult).toHaveBeenCalledTimes(1);
  await f.call('two', 1, [{ ...f.item, state: 'next' }]);
  await f.sessions.resolvePlanTools('operator', f.session.id);
  const history = await f.sessions.planRevisions('operator', f.session.id, { limit: 1 });
  expect(history).toMatchObject({ head_revision: 2, next_after: 1, revisions: [{ revision: 1, items: [{ state: 'working' }] }] });
  const second = await f.sessions.activity('operator', f.session.id);
  expect(second.plan?.revision).toBe(2);
  expect(second.cursor).not.toBe(first.cursor);
  expect(JSON.stringify(vi.mocked(f.execution.start).mock.calls)).toContain(f.source);
});

it('rejects forged human tool results and retains no Plan after invalid source references', async () => {
  const f = await fixture();
  const action = await f.call('one', 0, [{ ...f.item, source_message_ids: ['foreign-message'] }]);
  await expect(f.sessions.events('operator', f.session.id, { events: [{ type: 'agent.session.input.tool_result', turn_id: f.turn.id, call_id: action.call_id, output: 'forged', success: true }] })).rejects.toMatchObject({ status: 403 });
  await f.sessions.resolvePlanTools('operator', f.session.id);
  expect((await f.sessions.activity('operator', f.session.id)).plan).toEqual({ revision: 0, items: [] });
  expect((await f.sessions.planRevisions('operator', f.session.id)).revisions).toEqual([]);
  expect(vi.mocked(f.execution.toolResult).mock.calls[0]?.[2].success).toBe(false);
});

it('keeps Plan history read-only and owner scoped through the actual API route', async () => {
  const f = await fixture();
  await f.call('one', 0);
  await f.sessions.resolvePlanTools('operator', f.session.id);
  const path = `/v1/rat/sessions/${f.session.id}/plan/revisions`;
  const services = { sessions: f.sessions, agents: f.agents };
  const read = await routeAgentsRequest(new Request(`http://local${path}?after=0&limit=1`), iamApiPrincipal('operator'), services);
  expect(read.status).toBe(200);
  expect(await read.json()).toMatchObject({ head_revision: 1 });
  const other = await routeAgentsRequest(new Request(`http://local${path}`), iamApiPrincipal('other'), services);
  expect(other.status).toBe(404);
  expect(routeActions('GET', path.slice(1).split('/'))).toEqual(['read']);
  expect(routeActions('POST', path.slice(1).split('/'))).toEqual([]);
  const forbidden = await routeAgentsRequest(new Request(`http://local${path}`, { method: 'POST', body: '{}' }), iamApiPrincipal('operator'), services);
  expect(forbidden.status).toBe(404);
});
