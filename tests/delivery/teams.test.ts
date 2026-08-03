import { afterEach, describe, expect, it, vi } from 'vitest';
import { CredentialBroker } from '../../src/credentials/broker.js';
import { TeamsDeliveryAdapter } from '../../src/delivery/providers/teams.js';
import type { DeliveryRequest } from '../../src/delivery/types.js';

const run = {
  runId: 'run-1',
  ownerId: 'teams:tenant-1:user-1',
  ownerCreated: 'teams:tenant-1:user-1#2026-01-01T00:00:00.000Z#run-1',
  status: 'succeeded' as const,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:01:00.000Z',
  expiresAt: 1_800_000_000,
  requestHash: 'hash',
  input: { bucket: 'artifacts', key: 'input.json', sha256: 'input-hash' },
  sourceKind: 'teams' as const,
  result: {
    output: { bucket: 'artifacts', key: 'result.md', sha256: 'result-hash' },
    preview: 'Rat Things reply',
    exitCode: 0,
    durationMs: 100,
  },
};

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
  run,
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
    expect(init.headers).toMatchObject({ 'idempotency-key': 'run-1' });
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
      run: { id: 'run-1', status: 'succeeded' },
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
