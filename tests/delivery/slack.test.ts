import { describe, expect, it, vi } from 'vitest';
import { CredentialBroker } from '../../src/credentials/broker.js';
import { SlackDeliveryAdapter } from '../../src/delivery/providers/slack.js';
import type { DeliveryRequest } from '../../src/delivery/types.js';

const request = {
  version: '1' as const,
  prompt: 'Find the launch note',
  integrations: { connectionSet: 'slack-events' },
  source: {
    kind: 'slack' as const,
    teamId: 'T123',
    channelId: 'C123',
    eventId: 'Ev123',
    threadTs: '1700000000.000001',
    senderId: 'U123',
  },
};

const delivery: DeliveryRequest = {
  context: {
    provider: 'slack',
    destination: { kind: 'slack', route: 'C123' },
    source: request.source,
  },
  request,
  execution: { id: 'turn_1', status: 'completed', label: 'Turn', sessionId: 'sess_1', credentialOwnerId: 'api:owner' },
  body: 'Found it',
};

describe('Slack delivery adapter', () => {
  it('replies through the source owner connection without reading a deployment bot token', async () => {
    const getSecret = vi.fn();
    const credentials = new CredentialBroker({ get: getSecret });
    const post = vi.fn().mockResolvedValue({ ok: true, ts: '1700000001.000002' });
    const adapter = new SlackDeliveryAdapter(credentials, {
      connectionPoster: { post },
    });

    await expect(adapter.deliver(delivery)).resolves.toBe('1700000001.000002');

    expect(post).toHaveBeenCalledWith({
      ownerId: 'api:owner',
      request: { connectionSet: 'slack-events' },
      channel: 'C123',
      text: expect.stringContaining('Found it'),
      threadTs: '1700000000.000001',
    });
    expect(getSecret).not.toHaveBeenCalled();
  });

  it('preserves uncertain connection failures without claiming the message was not delivered', async () => {
    const error = new Error('connection closed after sending');
    const adapter = new SlackDeliveryAdapter(
      new CredentialBroker({ get: vi.fn() }),
      { connectionPoster: { post: vi.fn().mockRejectedValue(error) } },
    );

    await expect(adapter.deliver(delivery)).rejects.toBe(error);
  });
});
