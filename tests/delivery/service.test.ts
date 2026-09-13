import { afterEach, describe, expect, it, vi } from 'vitest';
import { CredentialBroker } from '../../src/credentials/broker.js';
import { GitHubDeliveryAdapter } from '../../src/delivery/providers/github.js';
import { KnownNotDeliveredError } from '../../src/delivery/errors.js';
import { DeliveryService, resolveDestinations } from '../../src/delivery/service.js';
import type { RunRecord, RunRequest, RunStateEvent } from '../../src/domain/contracts.js';
import { RuntimePluginRegistry } from '../../src/plugins/registry.js';

const request: RunRequest = {
  version: '1',
  prompt: 'review',
  source: {
    kind: 'github',
    deliveryId: 'delivery-1',
    event: 'pull_request',
    repository: 'acme/runtime',
    issueNumber: 7,
  },
};

const run: RunRecord = {
  runId: 'run-1',
  ownerId: 'github:installation-1',
  ownerCreated: 'github:installation-1#2026-01-01T00:00:00.000Z#run-1',
  status: 'succeeded',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:01:00.000Z',
  expiresAt: 1_800_000_000,
  requestHash: 'hash',
  input: { bucket: 'artifacts', key: 'input.json', sha256: 'input-hash' },
  sourceKind: 'github',
  result: {
    output: { bucket: 'artifacts', key: 'result.md', sha256: 'result-hash' },
    preview: 'preview',
    exitCode: 0,
    durationMs: 100,
  },
};

const event: RunStateEvent = {
  version: '1',
  runId: run.runId,
  ownerId: run.ownerId,
  status: 'succeeded',
  sourceKind: 'github',
  occurredAt: run.updatedAt,
};

describe('delivery service', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('leaves Agents notifications to Turn delivery when the private harness exits', async () => {
    const getJson = vi.fn();
    const read = vi.fn();
    const claim = vi.fn();
    const service = new DeliveryService({
      store: { get: vi.fn().mockResolvedValue({ ...run, agentsSession: { sessionId: 'sess_one', turnId: 'turn_one', launch: run.input } }) },
      artifacts: { getJson }, results: { read },
      fence: { claim, delivered: vi.fn(), failed: vi.fn(), release: vi.fn() },
      plugins: new RuntimePluginRegistry([]), defaultDestinations: [{ kind: 'source' }],
    });
    await service.handle(event);
    expect(getJson).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
  });

  it.each([
    { status: 403, retryable: false, known: true },
    { status: 429, retryable: true, known: true },
    { status: 500, retryable: false, known: false },
    { status: 503, retryable: false, known: false },
    { status: undefined, retryable: false, known: false },
  ])('handles provider failure $status without retrying an uncertain write', async ({ status, retryable, known }) => {
    const fetchMock = status
      ? vi.fn().mockResolvedValue(new Response('{}', { status }))
      : vi.fn().mockRejectedValue(new Error('connection closed after sending'));
    vi.stubGlobal('fetch', fetchMock);
    const fence = {
      claim: vi.fn().mockResolvedValue(true),
      delivered: vi.fn(),
      release: vi.fn(),
      failed: vi.fn(),
    };
    const adapter = new GitHubDeliveryAdapter(new CredentialBroker({
      get: vi.fn().mockResolvedValue('fixture-token'),
    }), { tokenSecretArn: 'fixture-secret', apiBaseUrl: 'https://api.github.com' });
    const service = new DeliveryService({
      store: { get: vi.fn().mockResolvedValue(run) },
      artifacts: { getJson: vi.fn().mockResolvedValue(request) },
      results: { read: vi.fn().mockResolvedValue('complete result') },
      fence,
      plugins: new RuntimePluginRegistry([{
        manifest: { name: 'github', version: '1', description: 'test GitHub plugin', provider: 'github' },
        delivery: adapter,
      }]),
      defaultDestinations: [{ kind: 'source' }],
    });

    if (retryable) {
      await expect(service.handle(event)).rejects.toBeInstanceOf(KnownNotDeliveredError);
      expect(fence.release).toHaveBeenCalledWith(run.runId, JSON.stringify(['github', 'default', 'acme/runtime', 7]));
      expect(fence.failed).not.toHaveBeenCalled();
    } else {
      await service.handle(event);
      expect(fence.release).not.toHaveBeenCalled();
      expect(fence.failed).toHaveBeenCalledWith(run.runId, JSON.stringify(['github', 'default', 'acme/runtime', 7]), expect.any(Error));
      expect(fence.failed.mock.calls[0]?.[2] instanceof KnownNotDeliveredError).toBe(known);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fence.delivered).not.toHaveBeenCalled();
  });

  it('resolves source delivery through the provider plugin and durable fence', async () => {
    const deliver = vi.fn().mockResolvedValue('comment-1');
    const fence = {
      claim: vi.fn().mockResolvedValue(true),
      delivered: vi.fn().mockResolvedValue(undefined),
      release: vi.fn().mockResolvedValue(undefined),
      failed: vi.fn().mockResolvedValue(undefined),
    };
    const plugins = new RuntimePluginRegistry([{
      manifest: {
        name: 'github',
        version: '1',
        description: 'test GitHub plugin',
        provider: 'github',
      },
      delivery: { provider: 'github', deliver },
    }]);
    const service = new DeliveryService({
      store: { get: vi.fn().mockResolvedValue(run) },
      artifacts: { getJson: vi.fn().mockResolvedValue(request) },
      results: { read: vi.fn().mockResolvedValue('complete result') },
      fence,
      plugins,
      defaultDestinations: [{ kind: 'source' }],
    });

    await service.handle(event);

    expect(fence.claim).toHaveBeenCalledWith(expect.objectContaining({ id: run.runId, expiresAt: run.expiresAt }), JSON.stringify(['github', 'default', 'acme/runtime', 7]));
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({ provider: 'github' }),
      request,
      execution: expect.objectContaining({ id: run.runId, status: run.status }),
      body: 'complete result',
    }));
    expect(fence.delivered).toHaveBeenCalledWith('run-1', JSON.stringify(['github', 'default', 'acme/runtime', 7]), 'comment-1');
  });

  it('normalizes chat source destinations without leaking provider routing into core', () => {
    const contexts = resolveDestinations({
      source: {
        kind: 'slack',
        channelId: 'channel-1',
        eventId: 'event-1',
      },
    }, [{ kind: 'source' }]);

    expect(contexts).toEqual([{
      provider: 'slack',
      destination: { kind: 'slack', route: 'channel-1' },
      source: expect.objectContaining({ kind: 'slack' }),
    }]);
  });
});
