import type { IntegrationConnection } from '../domain/capabilities.js';
import type { ConnectionService } from './connection-service.js';

export interface ConnectionHealthCandidateSource {
  nextHealthCheckCandidates(limit: number): Promise<IntegrationConnection[]>;
}

export interface ConnectionHealthMonitorOptions {
  candidates: ConnectionHealthCandidateSource;
  connections: Pick<ConnectionService, 'get' | 'test'>;
  clock?: { now(): Date };
  staleAfterMs: number;
  limit: number;
  concurrency?: number;
}

export interface ConnectionHealthMonitorResult {
  selected: number;
  tested: number;
  skipped: number;
  failed: number;
}

/**
 * Bounded operator-plane health verification. It records only the safe health
 * projection produced by ConnectionService and never returns credentials or
 * provider response bodies.
 */
export class ConnectionHealthMonitor {
  private readonly clock: { now(): Date };
  private readonly concurrency: number;

  public constructor(private readonly options: ConnectionHealthMonitorOptions) {
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) {
      throw new Error('connection health monitor limit must be 1-100');
    }
    if (!Number.isFinite(options.staleAfterMs) || options.staleAfterMs < 60_000) {
      throw new Error('connection health monitor stale interval must be at least one minute');
    }
    this.clock = options.clock ?? { now: () => new Date() };
    this.concurrency = Math.max(1, Math.min(10, options.concurrency ?? 3));
  }

  public async run(): Promise<ConnectionHealthMonitorResult> {
    const candidates = await this.options.candidates.nextHealthCheckCandidates(this.options.limit);
    const result: ConnectionHealthMonitorResult = {
      selected: candidates.length,
      tested: 0,
      skipped: 0,
      failed: 0,
    };
    for (let offset = 0; offset < candidates.length; offset += this.concurrency) {
      const batch = candidates.slice(offset, offset + this.concurrency);
      await Promise.all(batch.map(async (candidate) => {
        if (candidate.status === 'revoked') {
          result.skipped += 1;
          return;
        }
        try {
          const detail = await this.options.connections.get(
            candidate.ownerId,
            candidate.connectionId,
          );
          const checkedAt = detail.health.checkedAt
            ? Date.parse(detail.health.checkedAt)
            : Number.NaN;
          if (
            Number.isFinite(checkedAt) &&
            checkedAt > this.clock.now().getTime() - this.options.staleAfterMs
          ) {
            result.skipped += 1;
            return;
          }
          await this.options.connections.test(candidate.ownerId, candidate.connectionId);
          result.tested += 1;
        } catch {
          // The Lambda emits a count only. Provider errors and credential-shaped
          // values are intentionally excluded from logs and metrics.
          result.failed += 1;
        }
      }));
    }
    return result;
  }
}
