import type { EventBridgeHandler } from 'aws-lambda';
import { createAwsClients } from '../adapters/aws-runtime.js';
import { DynamoIntegrationStore } from '../adapters/dynamo-integration-store.js';
import { requiredEnv } from '../adapters/executors.js';
import { getConnectionService } from '../app/composition.js';
import { ConnectionHealthMonitor } from '../plugins/connection-health-monitor.js';
import { emitMetric } from './metrics.js';

const store = new DynamoIntegrationStore(
  createAwsClients().dynamodb,
  requiredEnv('INTEGRATIONS_TABLE_NAME'),
);

/** Scheduled, operator-plane verification with no agent or public ingress. */
export const handler: EventBridgeHandler<'Scheduled Event', Record<string, never>, void> = async () => {
  const monitor = new ConnectionHealthMonitor({
    candidates: store,
    connections: getConnectionService(),
    limit: boundedInteger(process.env.CONNECTION_HEALTH_CHECK_LIMIT, 10, 1, 100),
    concurrency: boundedInteger(process.env.CONNECTION_HEALTH_CHECK_CONCURRENCY, 3, 1, 10),
    staleAfterMs: boundedInteger(
      process.env.CONNECTION_HEALTH_STALE_MINUTES,
      60,
      1,
      24 * 60,
    ) * 60_000,
  });
  const result = await monitor.run();
  emitMetric('connection-health', 'ConnectionHealthSelected', result.selected, 'Count');
  emitMetric('connection-health', 'ConnectionHealthTested', result.tested, 'Count');
  emitMetric('connection-health', 'ConnectionHealthSkipped', result.skipped, 'Count');
  emitMetric('connection-health', 'ConnectionHealthFailed', result.failed, 'Count');
};

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error('connection health monitor environment is invalid');
  }
  return parsed;
}
