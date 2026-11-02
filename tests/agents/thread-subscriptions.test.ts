import { describe, expect, it, vi } from 'vitest';
import type { SessionIntegrationInput, SessionIntegrationState, ThreadSubscription } from '../../src/domain/session-integrations.js';
import { acceptIntegrationInput, integrationSessionId, MAX_THREAD_INPUTS, threadSubscriptionId } from '../../src/core/session-integration-planning.js';
import { planSessionRun } from '../../src/core/session-run-planning.js';
import { integrationFixture } from './integration-fixtures.js';
import { THREAD_RELEASE_TOOL } from '../../src/core/thread-release-tool.js';

async function repositoryFixture() {
  const f = await integrationFixture();
  const prepare = vi.spyOn(f.execution, 'prepare').mockImplementation(async (_owner, id) => ({ type: 'openai_hosted', id: `env_${id}`, capability_directories: [], files: [], skills: [], plugins: [], network: { access: 'disabled', allowed_domains: [] }, packages: { npm: [], python: [], system: [] } }));
  const target = { ...f.target, environment: { type: 'openai_hosted' as const } };
  const input: SessionIntegrationInput = { ...f.input, source: { kind: 'github', repository: 'acme/app', issueNumber: 7, deliveryId: 'event-1', event: 'pull_request' }, repository: { provider: 'github', url: 'https://github.com/acme/app.git', ref: '1111111111111111111111111111111111111111' } };
  return { ...f, prepare, target, input };
}

describe('thread subscriptions', () => {
  it('keeps comments in one Session and preserves the original workspace until a head change', async () => {
    const f = await repositoryFixture();
    const first = await f.integrations.accept('operator', 'binding', 'pr-7', f.target, f.input);
    await f.integrations.submitPending('operator', first.sessionId);
    const comment = { ...f.input, id: 'comment', text: 'Explain the review', repository: { ...f.input.repository!, ref: 'refs/pull/7/head' } };
    expect(await f.integrations.accept('operator', 'binding', 'pr-7', f.target, comment)).toEqual(first);
    await f.integrations.submitPending('operator', first.sessionId);
    const saved = (await f.store.get<SessionIntegrationState>('operator', 'session_integrations', first.sessionId))!.value;
    const session = await f.sessions.retrieve('operator', first.sessionId);
    expect(saved.inputs).toHaveLength(2);
    expect(planSessionRun(session, 'microvm', [], saved.inputs[0]).repository?.ref).toBe(f.input.repository?.ref);
    expect(f.prepare).toHaveBeenCalledTimes(1);
    const update = { ...f.input, id: 'synchronize', repositoryHeadChanged: true, repository: { ...f.input.repository!, ref: '2222222222222222222222222222222222222222' } };
    const second = await f.integrations.accept('operator', 'binding', 'pr-7', f.target, update);
    expect(second.sessionId).toBe(integrationSessionId('binding', 'pr-7#1'));
    await f.integrations.submitPending('operator', second.sessionId);
    expect(f.prepare).toHaveBeenCalledTimes(2);
    expect((await f.store.get<SessionIntegrationState>('operator', 'session_integrations', first.sessionId))?.value.supersededBy).toBe(second.sessionId);
    expect((await f.store.get<SessionIntegrationState>('operator', 'session_integrations', second.sessionId))?.value).toMatchObject({ epoch: 1, previousSessionId: first.sessionId });
    expect(await f.integrations.accept('operator', 'binding', 'pr-7', f.target, update)).toEqual(second);
    expect(await f.integrations.accept('operator', 'binding', 'pr-7', f.target, f.input)).toEqual(first);
    expect(await f.integrations.accept('operator', 'binding', 'pr-7', f.target, { ...comment, id: 'next-comment' })).toEqual(second);
    expect(await f.integrations.accept('operator', 'binding', 'pr-7', f.target, { ...update, id: 'same-head' })).toEqual(second);
  });

  it('releases future input while the current Turn still delivers and old events stay deduplicated', async () => {
    const f = await integrationFixture();
    const first = await f.integrations.accept('operator', 'binding', 'thread', f.target, f.input);
    const subscriptionId = threadSubscriptionId('binding', 'thread');
    await f.integrations.submitPending('operator', first.sessionId);
    await f.sessions.dispatch('operator', first.sessionId);
    expect(await f.integrations.hasActiveSubscription('operator', 'binding', 'thread')).toBe(true);
    await f.integrations.release('operator', subscriptionId, { reason: 'Finished' }, first.sessionId);
    expect(await f.integrations.hasActiveSubscription('operator', 'binding', 'thread')).toBe(false);
    const next = await f.integrations.accept('operator', 'binding', 'thread', f.target, { ...f.input, id: 'event-2' });
    expect(next.sessionId).toBe(integrationSessionId('binding', 'thread#1'));
    await expect(f.integrations.release('operator', subscriptionId, { reason: 'Old operator retry' }, undefined, 0)).rejects.toMatchObject({ status: 409 });
    expect(await f.integrations.accept('operator', 'binding', 'thread', f.target, f.input)).toEqual(first);
    await f.integrations.release('operator', subscriptionId, { reason: 'Finished' }, first.sessionId);
    expect(await f.integrations.hasActiveSubscription('operator', 'binding', 'thread')).toBe(true);
    const turn = (await f.sessions.turns('operator', first.sessionId)).data[0]!;
    f.observations.set(turn.id, { turn: { ...turn, status: 'completed', completed_at: 3 }, requiredActions: [] });
    await f.sessions.completeReadyTurns('operator', first.sessionId);
    await f.integrations.deliverReady('operator', first.sessionId);
    await f.integrations.deliverReady('operator', first.sessionId);
    expect(f.delivery.deliver).toHaveBeenCalledTimes(1);
    expect(f.delivery.deliver).toHaveBeenCalledWith(expect.objectContaining({ sessionId: first.sessionId }));
  });

  it('moves a deleted Session to the next epoch without resurrecting it', async () => {
    const f = await integrationFixture();
    const first = await f.integrations.accept('operator', 'binding', 'thread', f.target, f.input);
    await f.integrations.submitPending('operator', first.sessionId);
    await f.sessions.dispatch('operator', first.sessionId);
    await f.sessions.delete('operator', first.sessionId);
    expect(await f.integrations.hasActiveSubscription('operator', 'binding', 'thread')).toBe(false);
    const second = await f.integrations.accept('operator', 'binding', 'thread', f.target, { ...f.input, id: 'next' });
    await f.integrations.submitPending('operator', second.sessionId);
    expect(second.sessionId).toBe(integrationSessionId('binding', 'thread#1'));
    expect(await f.integrations.accept('operator', 'binding', 'thread', f.target, f.input)).toEqual(first);
    expect((await f.sessions.list('operator')).data.map(session => session.id)).toEqual([second.sessionId]);
  });

  it('bounds each epoch and remembers duplicates across rollover', async () => {
    const f = await integrationFixture();
    const first = await f.integrations.accept('operator', 'binding', 'thread', f.target, f.input);
    for (let i = 1; i < MAX_THREAD_INPUTS; i++) await f.integrations.accept('operator', 'binding', 'thread', f.target, { ...f.input, id: `event-${i + 1}` });
    const next = await f.integrations.accept('operator', 'binding', 'thread', f.target, { ...f.input, id: 'rollover' });
    expect(next.sessionId).toBe(integrationSessionId('binding', 'thread#1'));
    expect((await f.store.get<SessionIntegrationState>('operator', 'session_integrations', first.sessionId))?.value.inputs).toHaveLength(MAX_THREAD_INPUTS);
    expect((await f.store.get<ThreadSubscription>('operator', 'thread_subscriptions', threadSubscriptionId('binding', 'thread')))?.value.subscribers).toHaveLength(1);
    expect(await f.integrations.accept('operator', 'binding', 'thread', f.target, f.input)).toEqual(first);
    await expect(f.integrations.accept('operator', 'binding', 'thread', f.target, { ...f.input, text: 'Changed' })).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });

  it('adopts earlier integration receipts before a deleted legacy Session rotates', async () => {
    const f = await integrationFixture();
    const sessionId = integrationSessionId('binding', 'thread');
    await f.store.put({ ownerId: 'operator', collection: 'session_integrations', id: sessionId, revision: 1, createdAt: 1, value: acceptIntegrationInput(undefined, f.target, f.input) }, 0);
    await f.integrations.submitPending('operator', sessionId);
    await f.sessions.dispatch('operator', sessionId);
    await f.sessions.delete('operator', sessionId);
    const next = await f.integrations.accept('operator', 'binding', 'thread', f.target, { ...f.input, id: 'next' });
    expect(next.sessionId).toBe(integrationSessionId('binding', 'thread#1'));
    expect(await f.integrations.accept('operator', 'binding', 'thread', f.target, f.input)).toEqual({ sessionId });
  });

  it('serializes concurrent first input and a release that wins an admission race', async () => {
    const f = await integrationFixture();
    const [one, two] = await Promise.all([f.integrations.accept('operator', 'binding', 'thread', f.target, f.input), f.integrations.accept('operator', 'binding', 'thread', f.target, { ...f.input, id: 'two' })]);
    expect(one).toEqual(two);
    expect((await f.store.get<SessionIntegrationState>('operator', 'session_integrations', one.sessionId))?.value.inputs).toHaveLength(2);
    const commit = f.store.commit.bind(f.store);
    let release!: () => void;
    let reached!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const paused = new Promise<void>(resolve => { reached = resolve; });
    let pause = true;
    vi.spyOn(f.store, 'commit').mockImplementation(async writes => {
      if (pause && writes.some(write => write.resource.collection === 'integration_occurrences')) { pause = false; reached(); await wait; }
      return commit(writes);
    });
    const pending = f.integrations.accept('operator', 'binding', 'thread', f.target, { ...f.input, id: 'three' });
    await paused;
    await f.integrations.release('operator', threadSubscriptionId('binding', 'thread'), { reason: 'Done' });
    release();
    expect((await pending).sessionId).toBe(integrationSessionId('binding', 'thread#1'));
  });

  it('fences deletion against an input whose admission was already in progress', async () => {
    const f = await integrationFixture();
    const first = await f.integrations.accept('operator', 'binding', 'thread', f.target, f.input);
    await f.integrations.submitPending('operator', first.sessionId);
    await f.sessions.dispatch('operator', first.sessionId);
    const commit = f.store.commit.bind(f.store);
    let resume!: () => void;
    let arrived!: () => void;
    const waiting = new Promise<void>(resolve => { resume = resolve; });
    const paused = new Promise<void>(resolve => { arrived = resolve; });
    let pause = true;
    vi.spyOn(f.store, 'commit').mockImplementation(async writes => {
      if (pause && writes.some(write => write.resource.collection === 'integration_occurrences')) { pause = false; arrived(); await waiting; }
      return commit(writes);
    });
    const pending = f.integrations.accept('operator', 'binding', 'thread', f.target, { ...f.input, id: 'next' });
    await paused;
    await f.sessions.delete('operator', first.sessionId);
    resume();
    expect((await pending).sessionId).toBe(integrationSessionId('binding', 'thread#1'));
    expect(await f.store.get('operator', 'sessions', first.sessionId)).toBeUndefined();
  });

  it('recovers a lost release acknowledgement without touching a later epoch', async () => {
    const f = await integrationFixture();
    const first = await f.integrations.accept('operator', 'binding', 'thread', f.target, f.input);
    const id = threadSubscriptionId('binding', 'thread');
    const commit = f.store.commit.bind(f.store);
    let fail = true;
    vi.spyOn(f.store, 'commit').mockImplementation(async writes => {
      await commit(writes);
      if (fail && writes.some(write => write.resource.collection === 'session_integrations' && (write.resource.value as SessionIntegrationState).threadReleased)) { fail = false; throw new Error('Lost release acknowledgement'); }
    });
    await expect(f.integrations.release('operator', id, { reason: 'Done' }, first.sessionId)).rejects.toThrow('Lost release acknowledgement');
    await f.integrations.accept('operator', 'binding', 'thread', f.target, { ...f.input, id: 'next' });
    expect(await f.integrations.release('operator', id, { reason: 'Done' }, first.sessionId)).toEqual({ id, sessionId: first.sessionId, released: true });
    expect(await f.integrations.hasActiveSubscription('operator', 'binding', 'thread')).toBe(true);
  });

  it('lists and retrieves only the operator’s subscriptions with pagination', async () => {
    const f = await integrationFixture();
    await f.integrations.accept('operator', 'first', 'thread', f.target, f.input);
    await f.integrations.accept('operator', 'second', 'thread', f.target, f.input);
    const first = await f.integrations.listSubscriptions('operator', { limit: 1 });
    expect(first.has_more).toBe(true);
    expect(first.data).toHaveLength(1);
    const second = await f.integrations.listSubscriptions('operator', { after: first.data[0]!.id, limit: 1 });
    expect(second.data).toHaveLength(1);
    expect(second.data[0]!.id).not.toBe(first.data[0]!.id);
    expect(await f.integrations.subscription('operator', first.data[0]!.id)).toEqual(first.data[0]);
    expect((await f.integrations.listSubscriptions('other-owner')).data).toEqual([]);
    await expect(f.integrations.subscription('other-owner', first.data[0]!.id)).rejects.toMatchObject({ status: 404 });
  });

  it('rejects stale companion admission writes without adding an input', async () => {
    const f = await integrationFixture();
    const marker = { ownerId: 'operator', collection: 'candidate_markers', id: 'thread', createdAt: 1, revision: 1, value: { revision: 1 } };
    await f.store.put(marker, 0);
    await expect(f.integrations.accept('operator', 'binding', 'thread', f.target, f.input, [{ resource: marker, expectedRevision: 0 }])).rejects.toMatchObject({ code: 'conflict' });
    expect((await f.store.list('operator', 'session_integrations', {})).data).toEqual([]);
    expect((await f.store.list('operator', 'thread_subscriptions', {})).data).toEqual([]);
  });

  it('resolves only the current Session subscription and supplies a durable host tool result', async () => {
    const f = await integrationFixture();
    const { sessionId } = await f.integrations.accept('operator', 'binding', 'thread', f.target, f.input);
    await f.integrations.submitPending('operator', sessionId);
    await f.sessions.dispatch('operator', sessionId);
    const session = await f.sessions.retrieve('operator', sessionId);
    expect(session.agent.tools).toContainEqual(THREAD_RELEASE_TOOL);
    const turn = (await f.sessions.turns('operator', sessionId)).data[0]!;
    f.observations.set(turn.id, { turn: { ...turn, status: 'waiting' }, requiredActions: [{ type: 'function_call', turn_id: turn.id, call_id: 'release', name: THREAD_RELEASE_TOOL.name, arguments: { reason: 'Complete' } }] });
    await f.integrations.resolveTools('operator', sessionId);
    await f.integrations.resolveTools('operator', sessionId);
    expect(await f.integrations.hasActiveSubscription('operator', 'binding', 'thread')).toBe(false);
    expect((await f.sessions.items('operator', sessionId)).data.filter(item => item.type === 'function_call_output' && item.call_id === 'release')).toHaveLength(1);
    await expect(f.integrations.release('other-owner', threadSubscriptionId('binding', 'thread'), { reason: 'Forged' })).rejects.toMatchObject({ status: 404 });
    await expect(f.integrations.release('operator', threadSubscriptionId('binding', 'thread'), { reason: 'Forged', sessionId: 'someone-else' }, sessionId)).rejects.toMatchObject({ status: 400 });
    const ordinary = await f.sessions.create('operator', { agent_id: f.agent.id, environment: { type: 'none' }, input: 'Judge this' });
    expect(ordinary.agent.tools).toEqual([]);
  });
});
