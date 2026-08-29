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
  run: {
    runId: 'run-1',
    ownerId: 'slack:T123:U123',
    capabilityOwnerId: 'api:owner',
    ownerCreated: 'slack:T123:U123#2026-01-01T00:00:00.000Z#run-1',
    status: 'succeeded',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:01:00.000Z',
    expiresAt: 1_800_000_000,
    requestHash: 'hash',
    input: { bucket: 'artifacts', key: 'input.json', sha256: 'input-hash' },
    sourceKind: 'slack',
    result: {
      output: { bucket: 'artifacts', key: 'result.md', sha256: 'result-hash' },
      preview: 'Found it',
      exitCode: 0,
      durationMs: 100,
    },
  },
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

  it('turns connection failures into a durable not-delivered result', async () => {
    const adapter = new SlackDeliveryAdapter(
      new CredentialBroker({ get: vi.fn() }),
      { connectionPoster: { post: vi.fn().mockRejectedValue(new Error('scope missing')) } },
    );

    await expect(adapter.deliver(delivery)).rejects.toMatchObject({
      name: 'KnownNotDeliveredError',
      message: 'Slack connection delivery failed: scope missing',
    });
  });
});
