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
      expect((await f.store.get<EventCandidate>('operator', candidates[0].id))?.value.state.status).toBe('discarded');
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
});

async function fixture(pauseAccept = false) {
  const setup = await integrationFixture();
  const adapter = new SlackIngressAdapter(new CredentialBroker({ get: async () => signingSecret }), { signingSecretArn: 'test-secret', candidateEventsEnabled: true });
  const registry = new RuntimePluginRegistry([{
    manifest: { name: 'slack-test', version: '1', description: 'Signed ingress test', provider: 'slack' },
    ingress: adapter,
  }]);
  const candidates = new EventCandidateService({
    store: setup.store,
    integrations: setup.integrations,
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
  return { ...setup, service, candidates, acceptStarted, resumeAccept };
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
  const integration = await f.store.get<{ inputs: Array<{ id: string }> }>('operator', 'session_integrations', sessionId);
  return integration?.value.inputs ?? [];
}
