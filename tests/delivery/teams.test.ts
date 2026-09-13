import { afterEach, describe, expect, it, vi } from 'vitest';
import { CredentialBroker } from '../../src/credentials/broker.js';
import { TeamsDeliveryAdapter } from '../../src/delivery/providers/teams.js';
import type { DeliveryRequest } from '../../src/delivery/types.js';

const request = {
  version: '1' as const,
  prompt: 'Hello Rat Things',
  source: {
    kind: 'teams' as const,
    tenantId: 'tenant-1',
    teamId: 'team-1',
    channelId: 'channel-1',
    conversationId: 'conversation-1',
    activityId: 'activity-1',
    senderId: 'user-1',
  },
};

const delivery: DeliveryRequest = {
  context: {
    provider: 'teams',
    destination: { kind: 'teams' },
    source: request.source,
  },
  request,
  execution: { id: 'turn_1', status: 'completed', label: 'Turn', sessionId: 'sess_1' },
  body: 'Rat Things reply',
};

afterEach(() => vi.unstubAllGlobals());

describe('Teams delivery adapter', () => {
  it('addresses a gateway reply to the exact source conversation and activity', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', {
      status: 202,
      headers: { 'request-id': 'reply-1' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const credentials = new CredentialBroker({
      get: vi.fn().mockResolvedValue(JSON.stringify({ url: 'https://gateway.example/replies' })),
    });
    const adapter = new TeamsDeliveryAdapter(credentials, {
      mode: 'threaded-gateway',
      replyGatewayUrlSecretArn: 'secret:teams-reply-gateway',
      routes: {},
    });

    await expect(adapter.deliver(delivery)).resolves.toBe('reply-1');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://gateway.example/replies',
      expect.objectContaining({ method: 'POST' }),
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(init.headers).toMatchObject({ 'idempotency-key': 'turn_1' });
    expect(body).toMatchObject({
      version: '1',
      operation: 'reply-to-activity',
      conversationId: 'conversation-1',
      replyToActivityId: 'activity-1',
      activity: {
        type: 'message',
        conversation: { id: 'conversation-1' },
        replyToId: 'activity-1',
      },
      source: {
        tenantId: 'tenant-1',
        teamId: 'team-1',
        channelId: 'channel-1',
        senderId: 'user-1',
      },
      execution: { id: 'turn_1', status: 'completed', sessionId: 'sess_1', type: 'turn' },
    });
    expect(body.activity).toMatchObject({ text: expect.stringContaining('Rat Things reply') });
  });

  it('rejects threaded delivery without a trusted Teams source', async () => {
    const credentials = new CredentialBroker({ get: vi.fn() });
    const adapter = new TeamsDeliveryAdapter(credentials, {
      mode: 'threaded-gateway',
      replyGatewayUrlSecretArn: 'secret:teams-reply-gateway',
      routes: {},
    });

    await expect(adapter.deliver({
      ...delivery,
      context: { ...delivery.context, source: { kind: 'api', requestId: 'request-1' } },
    })).rejects.toThrow('requires a Teams source conversation');
  });
});
