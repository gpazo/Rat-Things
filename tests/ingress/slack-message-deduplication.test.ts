import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EventCandidateService } from '../../src/core/event-candidate-service.js';
import type { EventCandidate } from '../../src/domain/event-candidates.js';
import { CredentialBroker } from '../../src/credentials/broker.js';
import { SlackIngressAdapter } from '../../src/ingress/providers/slack.js';
import { WebhookIngressService } from '../../src/ingress/service.js';
import { RuntimePluginRegistry } from '../../src/plugins/registry.js';
import { integrationFixture } from '../agents/integration-fixtures.js';

const signingSecret = 'test-slack-signing-secret';
const policy = { mode: 'candidate' as const, semantic: { policies: ['Unresolved failures'], maxCandidatesPerHour: 10 } };

describe('signed Slack message and app-mention deduplication', () => {
  it('lets a later explicit app mention supersede an already queued candidate', async () => {
    const f = await fixture();
    const message = await f.service.receive('slack', signedRequest('message', 'EvMessage'));
    const mention = await f.service.receive('slack', signedRequest('app_mention', 'EvMention'));

    expect(message.body).toMatchObject({ accepted: true, candidateId: expect.any(String) });
    expect(mention.body).toMatchObject({ accepted: true, sessionId: expect.any(String) });
    expect(await f.integrations.listSubscriptions('operator')).toMatchObject({ data: [{ threadKey: JSON.stringify(['slack', 'T1', 'C1', '1000.1000']) }] });

    const candidates = (await f.store.list<EventCandidate>('operator', 'event_candidates', {})).data;
    expect(candidates).toHaveLength(1);
    await f.candidates.process('operator', candidates[0]!.id);
    expect((await f.store.list<EventCandidate>('operator', 'event_candidates', {})).data[0]?.value.state).toMatchObject({ status: 'discarded', decision: { reason: 'explicit_request_won' } });
    expect((await integrationInputs(f)).map(input => input.id)).toEqual(['slack:C1:1000.3000']);
  });

  it('accepts the explicit event first and treats the matching message event as the same occurrence', async () => {
    const f = await fixture();
    const mention = await f.service.receive('slack', signedRequest('app_mention', 'EvMention'));
    const message = await f.service.receive('slack', signedRequest('message', 'EvMessage'));

    expect(mention.body).toMatchObject({ accepted: true, sessionId: expect.any(String) });
    expect(message.body).toMatchObject({ accepted: true, duplicate: true });
    expect((await f.store.list<EventCandidate>('operator', 'event_candidates', {})).data).toHaveLength(0);
    expect((await integrationInputs(f)).map(input => input.id)).toEqual(['slack:C1:1000.3000']);
  });

  it('preserves explicit precedence when both signed deliveries race', async () => {
    const f = await fixture();
    const [message, mention] = await Promise.all([
      f.service.receive('slack', signedRequest('message', 'EvMessage')),
      f.service.receive('slack', signedRequest('app_mention', 'EvMention')),
    ]);

    expect([202, 503]).toContain(message.statusCode);
    expect(mention.body).toMatchObject({ accepted: true, sessionId: expect.any(String) });
    if (message.statusCode === 503) {
      expect(await f.service.receive('slack', signedRequest('message', 'EvMessage'))).toMatchObject({ statusCode: 202, body: { accepted: true, duplicate: true } });
    }
    expect((await integrationInputs(f)).map(input => input.id)).toEqual(['slack:C1:1000.3000']);
    const candidates = (await f.store.list<EventCandidate>('operator', 'event_candidates', {})).data;
    expect(candidates.length).toBeLessThanOrEqual(1);
    if (candidates[0]) {
      await f.candidates.process('operator', candidates[0].id);
      expect((await f.store.get<EventCandidate>('operator', 'event_candidates', candidates[0].id))?.value.state.status).toBe('discarded');
    }
  });

  it('asks Slack to retry a matching message while the explicit Session receipt is still pending', async () => {
    const f = await fixture(true);
    const mentionPromise = f.service.receive('slack', signedRequest('app_mention', 'EvMention'));
    await f.acceptStarted;

    expect(await f.service.receive('slack', signedRequest('message', 'EvMessage'))).toMatchObject({ statusCode: 503, body: { accepted: false, reason: 'explicit_occurrence_pending' } });
    f.resumeAccept();
    await mentionPromise;
    expect(await f.service.receive('slack', signedRequest('message', 'EvMessage'))).toMatchObject({ statusCode: 202, body: { accepted: true, duplicate: true } });
    expect((await f.store.list<EventCandidate>('operator', 'event_candidates', {})).data).toHaveLength(0);
  });

  it('upgrades an admitted empty candidate to an explicit reply without adding an input or Turn', async () => {
    const f = await fixture();
    f.execution.items = async () => [];
    const candidateResponse = await f.service.receive('slack', signedRequest('message', 'EvMessage'));
    const candidateId = (candidateResponse.body as { candidateId: string }).candidateId;
    await f.candidates.process('operator', candidateId);
    const candidate = await f.store.get<EventCandidate>('operator', 'event_candidates', candidateId);
    expect(candidate?.value.state.status).toBe('admitted');
    const subscriptions = await f.integrations.listSubscriptions('operator');
    const sessionId = subscriptions.data[0]!.subscribers[0]!.sessionId;
    await f.integrations.submitPending('operator', sessionId);
    await f.sessions.dispatch('operator', sessionId);
    const turn = (await f.sessions.turns('operator', sessionId)).data[0]!;
    f.observations.set(turn.id, { turn: { ...turn, status: 'completed', completed_at: 2 }, requiredActions: [] });
    await f.sessions.completeReadyTurns('operator', sessionId);
    await f.integrations.deliverReady('operator', sessionId);
    expect(f.delivery.deliver).toHaveBeenCalledWith(expect.objectContaining({ silentIfEmpty: true, items: [] }));

    const mention = await f.service.receive('slack', signedRequest('app_mention', 'EvMention'));
    expect(mention.body).toMatchObject({ accepted: true, sessionId });
    const integration = await f.store.get<{ inputs: Array<{ id: string; admission?: string; deliveryProcessed?: boolean }> }>('operator', 'session_integrations', sessionId);
    expect(integration?.value.inputs).toEqual([expect.objectContaining({ id: candidate!.value.input.id, admission: 'explicit', deliveryProcessed: false })]);
    await f.integrations.deliverReady('operator', sessionId);
    expect(f.delivery.deliver).toHaveBeenCalledTimes(2);
    expect(f.delivery.deliver).toHaveBeenLastCalledWith(expect.objectContaining({ silentIfEmpty: false, items: [] }));
    expect((await f.sessions.turns('operator', sessionId)).data).toHaveLength(1);
  });

  it('discards candidate-worker admission when a signed app mention wins during the commit', async () => {
    const f = await fixture({ pauseCandidateAdmission: true });
    await f.service.receive('slack', signedRequest('message', 'EvMessage'));
    const candidates = (await f.store.list<EventCandidate>('operator', 'event_candidates', {})).data;
    const candidateId = candidates[0]!.id;
    const process = f.candidates.process('operator', candidateId);
    await f.candidateAdmissionStarted;

    const mention = await f.service.receive('slack', signedRequest('app_mention', 'EvMention'));
    expect(mention.body).toMatchObject({ accepted: true, sessionId: expect.any(String) });
    f.resumeCandidateAdmission();
    await process;

    expect((await f.store.get<EventCandidate>('operator', 'event_candidates', candidateId))?.value.state).toMatchObject({ status: 'discarded', decision: { reason: 'explicit_request_won' } });
    expect((await integrationInputs(f)).map(input => input.id)).toEqual(['slack:C1:1000.3000']);
  });
});

async function fixture(options: boolean | { pauseCandidateAdmission?: boolean } = false) {
  const setup = await integrationFixture();
  const pauseAccept = typeof options === 'boolean' ? options : false;
  const pauseCandidateAdmission = typeof options === 'boolean' ? false : options.pauseCandidateAdmission ?? false;
  const adapter = new SlackIngressAdapter(new CredentialBroker({ get: async () => signingSecret }), { signingSecretArn: 'test-secret', candidateEventsEnabled: true });
  const registry = new RuntimePluginRegistry([{
    manifest: { name: 'slack-test', version: '1', description: 'Signed ingress test', provider: 'slack' },
    ingress: adapter,
  }]);
  let resumeCandidateAdmission = () => {};
  let signalCandidateAdmission = () => {};
  const candidateAdmissionGate = new Promise<void>(resolve => { resumeCandidateAdmission = resolve; });
  const candidateAdmissionStarted = new Promise<void>(resolve => { signalCandidateAdmission = resolve; });
  const candidates = new EventCandidateService({
    store: setup.store,
    integrations: { accept: async (...args: Parameters<typeof setup.integrations.accept>) => {
      if (pauseCandidateAdmission && args[4]?.admission === 'candidate') {
        signalCandidateAdmission();
        await candidateAdmissionGate;
      }
      return setup.integrations.accept(...args);
    } },
    model: { id: 'test', decide: async () => ({ act: true, reason: 'Relevant' }) },
    clock: { now: () => 10_000 },
  });
  let resumeAccept = () => {};
  let signalAcceptStarted = () => {};
  const acceptGate = new Promise<void>(resolve => { resumeAccept = resolve; });
  const acceptStarted = new Promise<void>(resolve => { signalAcceptStarted = resolve; });
  const service = new WebhookIngressService(registry, {
    accept: async (...args) => {
      if (pauseAccept) {
        signalAcceptStarted();
        await acceptGate;
      }
      return setup.integrations.accept(...args);
    },
    hasActiveSubscription: setup.integrations.hasActiveSubscription.bind(setup.integrations),
  }, {
    resolve: async () => ({
      ownerId: 'operator', bindingId: 'slack-binding', ...setup.target, threadScope: 'thread', eventPolicy: policy,
    }),
  }, candidates);
  return { ...setup, service, candidates, acceptStarted, resumeAccept, candidateAdmissionStarted, resumeCandidateAdmission };
}

function signedRequest(type: 'message' | 'app_mention', eventId: string) {
  const body = JSON.stringify({
    type: 'event_callback',
    event_id: eventId,
    team_id: 'T1',
    event: {
      type,
      channel: 'C1',
      user: 'U1',
      thread_ts: '1000.1000',
      ts: '1000.3000',
      text: '<@U123ABC> inspect the queue',
    },
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac('sha256', signingSecret).update(`v0:${timestamp}:${body}`).digest('hex')}`;
  return { body, headers: { 'x-slack-request-timestamp': timestamp, 'x-slack-signature': signature } };
}

async function integrationInputs(f: Awaited<ReturnType<typeof fixture>>) {
  const subscriptions = await f.store.list<{ subscribers: Array<{ sessionId: string }> }>('operator', 'thread_subscriptions', {});
  const sessionId = subscriptions.data[0]?.value.subscribers[0]?.sessionId;
  if (!sessionId) return [];
  const integration = await f.store.get<{ inputs: Array<{ id: string; admission?: string }> }>('operator', 'session_integrations', sessionId);
  return integration?.value.inputs ?? [];
}
