import { describe, expect, it, vi } from 'vitest';
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

    expect(fence.claim).toHaveBeenCalledWith(run, 'github:default');
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({ provider: 'github' }),
      request,
      run,
      body: 'complete result',
    }));
    expect(fence.delivered).toHaveBeenCalledWith('run-1', 'github:default', 'comment-1');
  });

  it('normalizes chat source destinations without leaking provider routing into core', () => {
    const contexts = resolveDestinations({
      version: '1',
      prompt: 'answer',
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
