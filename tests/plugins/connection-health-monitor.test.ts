import { describe, expect, it, vi } from 'vitest';
import type { IntegrationConnection } from '../../src/domain/capabilities.js';
import { ConnectionHealthMonitor } from '../../src/plugins/connection-health-monitor.js';

describe('connection health monitor', () => {
  it('tests only stale non-revoked connections and keeps provider failures bounded', async () => {
    const candidates = [
      connection('stale'),
      connection('fresh'),
      { ...connection('revoked'), status: 'revoked' as const },
      connection('failure'),
    ];
    const get = vi.fn().mockImplementation(async (_ownerId, connectionId) => ({
      connection: candidates.find((candidate) => candidate.connectionId === connectionId),
      health: connectionId === 'fresh'
        ? health('fresh', '2026-08-29T19:30:00.000Z')
        : health(connectionId),
    }));
    const test = vi.fn().mockImplementation(async (_ownerId, connectionId) => {
      if (connectionId === 'failure') throw new Error('provider response containing secret material');
      return { connection: connection(connectionId), health: health(connectionId) };
    });
    const monitor = new ConnectionHealthMonitor({
      candidates: { nextHealthCheckCandidates: vi.fn().mockResolvedValue(candidates) },
      connections: { get, test },
      clock: { now: () => new Date('2026-08-29T20:00:00.000Z') },
      staleAfterMs: 60 * 60_000,
      limit: 10,
      concurrency: 2,
    });

    await expect(monitor.run()).resolves.toEqual({ selected: 4, tested: 1, skipped: 2, failed: 1 });
    expect(test.mock.calls).toEqual([
      ['api:owner-1', 'stale'],
      ['api:owner-1', 'failure'],
    ]);
  });
});

function connection(connectionId: string): IntegrationConnection {
  return {
    version: '1', connectionId, ownerId: 'api:owner-1', pluginId: 'slack', alias: connectionId,
    label: connectionId, authorization: { scheme: 'oauth2', access: 'full', scopeModel: 'granular', scopes: [] },
    status: 'active', createdAt: '2026-08-20T00:00:00.000Z', updatedAt: '2026-08-20T00:00:00.000Z',
  };
}

function health(connectionId: string, checkedAt?: string) {
  return {
    version: '1' as const, ownerId: 'api:owner-1', connectionId,
    status: checkedAt ? 'healthy' as const : 'unknown' as const,
    code: checkedAt ? 'verified' as const : 'not-tested' as const,
    ...(checkedAt ? { checkedAt } : {}),
  };
}
