import { describe, expect, it, vi } from 'vitest';
import { SessionIntegrationService } from '../../src/core/session-integration-service.js';
import { SessionDeliveryService } from '../../src/delivery/session-delivery.js';
import type { DeliveryRequest } from '../../src/delivery/types.js';
import { OwnerRateLimiter } from '../../src/core/owner-rate-limiter.js';
import { applyWatchdogAction } from '../../src/core/watchdog-session-actions.js';
import type { SessionState } from '../../src/core/session-ports.js';
import type { SessionIntegrationState } from '../../src/domain/session-integrations.js';
import { defaultWatchdogPolicy } from '../../src/domain/watchdog.js';
import { integrationFixture } from './integration-fixtures.js';

async function failedProviderSession(admission: 'explicit' | 'candidate' = 'explicit', mixed = false) {
  const f = await integrationFixture();
  const deliver = vi.fn(async (_request: Omit<DeliveryRequest, 'context'>) => {});
  const integrations = new SessionIntegrationService({ store: f.store, sessions: f.sessions, delivery: new SessionDeliveryService({ deliver }) });
  const target = { ...f.target, destinations: [{ kind: 'source' as const }], connectionSetId: 'delivery-connections' };
  const { sessionId } = await integrations.accept('operator', 'binding', 'thread', target, { ...f.input, admission });
  await integrations.submitPending('operator', sessionId);
  await f.sessions.dispatch('operator', sessionId);
  if (mixed) {
    await integrations.accept('operator', 'binding', 'thread', target, { ...f.input, id: 'explicit-followup', admission: 'explicit', text: 'Please answer' });
    await integrations.submitPending('operator', sessionId);
    await f.sessions.dispatch('operator', sessionId);
  }
  const turn = (await f.sessions.turns('operator', sessionId)).data[0]!;
  f.observations.set(turn.id, { turn: { ...turn, status: 'failed', completed_at: 100, error: { code: 'server_overloaded', message: 'Try again' } }, requiredActions: [] });
  await f.sessions.completeReadyTurns('operator', sessionId);
  await integrations.deliverReady('operator', sessionId);
  deliver.mockClear();
  const rateLimit = new OwnerRateLimiter(f.store, () => 1, { now: () => 1000 });
  const candidate = { ownerId: 'operator', sessionId, subjectId: sessionId, turnId: turn.id, reason: 'transient_failure' as const, since: 100 };
  const retry = () => applyWatchdogAction(f.store, rateLimit, candidate, 'retry', 1000, defaultWatchdogPolicy);
  const integration = () => f.store.get<SessionIntegrationState>('operator', 'session_integrations', sessionId);
  async function completeRetry(empty = false) {
    await f.sessions.dispatch('operator', sessionId);
    const retried = (await f.store.get<SessionState>('operator', 'sessions', sessionId))!.value.turns.at(-1)!.turn;
    f.observations.set(retried.id, { turn: { ...retried, status: 'completed', completed_at: 1001 }, requiredActions: [] });
    if (empty) vi.spyOn(f.execution, 'items').mockResolvedValue([]);
    await f.sessions.completeReadyTurns('operator', sessionId);
    await integrations.deliverReady('operator', sessionId);
    await integrations.deliverReady('operator', sessionId);
    return retried;
  }
  return { ...f, integrations, deliver, target, sessionId, turn, candidate, retry, integration, completeRetry };
}

describe('watchdog retry provider delivery', () => {
  it('delivers the retry result once to the original thread with its integration context', async () => {
    const f = await failedProviderSession();
    const previous = (await f.integration())!.value;
    expect(await f.retry()).toBe(true);
    expect(await f.retry()).toBe(true);
    const retried = await f.completeRetry();
    expect(f.deliver).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      body: 'The answer', execution: expect.objectContaining({ id: retried.id, sessionId: f.sessionId }),
      request: { source: f.input.source, destinations: f.target.destinations, integrations: { connectionSet: f.target.connectionSetId } },
    }));
    const current = (await f.integration())!.value;
    expect(current.target).toEqual(previous.target);
    expect(current.inputs[0]).toEqual(previous.inputs[0]);
    expect(current.inputs.filter(input => input.turnId === retried.id)).toEqual([expect.objectContaining({ actor: f.input.actor, credentialSubject: f.input.credentialSubject, source: f.input.source, deliveryProcessed: true })]);
    expect((await f.store.get<{ requests: number }>('operator', 'rate_limits', 'current'))!.value.requests).toBe(1);
  });

  it.each([{ admission: 'candidate' as const, mixed: false, deliveries: 0 }, { admission: 'explicit' as const, mixed: false, deliveries: 1 }, { admission: 'candidate' as const, mixed: true, deliveries: 1 }])('preserves empty-result delivery for $admission inputs (mixed=$mixed)', async ({ admission, mixed, deliveries }) => {
    const f = await failedProviderSession(admission, mixed);
    await f.retry();
    const retried = await f.completeRetry(true);
    expect(f.deliver).toHaveBeenCalledTimes(deliveries);
    const receipts = (await f.integration())!.value.inputs.filter(input => input.turnId === retried.id);
    expect(receipts).toHaveLength(mixed ? 2 : 1);
    expect(receipts.every(input => input.deliveryProcessed)).toBe(true);
  });

  it('commits retry delivery tracking atomically with the Session when a provider occurrence races', async () => {
    const f = await failedProviderSession();
    const before = await f.store.get('operator', 'sessions', f.sessionId);
    const commit = f.store.commit.bind(f.store);
    let raced = false;
    vi.spyOn(f.store, 'commit').mockImplementation(async writes => {
      if (!raced && writes.some(({ resource }) => resource.collection === 'sessions')) {
        raced = true;
        await f.integrations.accept('operator', 'binding', 'thread', f.target, { ...f.input, id: 'arriving-input', text: 'Also check this' });
      }
      return commit(writes);
    });
    await expect(f.retry()).rejects.toMatchObject({ code: 'conflict' });
    expect(await f.store.get('operator', 'sessions', f.sessionId)).toEqual(before);
    expect((await f.integration())!.value.inputs.map(input => input.id)).toEqual(['event-1', 'arriving-input']);
    expect(await f.retry()).toBe(true);
    await f.completeRetry();
    expect(f.deliver).toHaveBeenCalledOnce();
    expect((await f.integration())!.value.inputs.find(input => input.id === 'arriving-input')?.turnId).toBeUndefined();
  });

  it('accepts concurrent retry invocations without duplicate delivery receipts', async () => {
    const f = await failedProviderSession();
    const results = await Promise.allSettled([f.retry(), f.retry()]);
    expect(results.filter(result => result.status === 'fulfilled' && result.value)).toHaveLength(1);
    await f.retry();
    await f.completeRetry();
    expect((await f.integration())!.value.inputs).toHaveLength(2);
    expect(f.deliver).toHaveBeenCalledOnce();
  });

  it('does not attach an unrelated API Turn to an earlier provider input', async () => {
    const f = await failedProviderSession();
    await f.sessions.events('operator', f.sessionId, { events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: 'API input' }] }] }] });
    await f.sessions.dispatch('operator', f.sessionId);
    const apiTurn = (await f.store.get<SessionState>('operator', 'sessions', f.sessionId))!.value.turns.at(-1)!.turn;
    f.observations.set(apiTurn.id, { turn: { ...apiTurn, status: 'failed', completed_at: 100, error: { code: 'server_overloaded', message: 'Try again' } }, requiredActions: [] });
    await f.sessions.completeReadyTurns('operator', f.sessionId);
    const integration = await f.integration();
    const limiter = new OwnerRateLimiter(f.store, () => 1, { now: () => 1000 });
    expect(await applyWatchdogAction(f.store, limiter, { ...f.candidate, turnId: apiTurn.id }, 'retry', 1000, defaultWatchdogPolicy)).toBe(true);
    await f.completeRetry();
    expect(await f.integration()).toEqual(integration);
    expect(f.deliver).not.toHaveBeenCalled();
  });
});
