import { afterEach, describe, expect, it, vi } from 'vitest';
import { embeddedMetric, emitSqsQueueDelay } from '../../src/lambdas/metrics.js';

describe('low-cardinality Lambda metrics', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.METRIC_DEPLOYMENT;
    delete process.env.METRIC_NAMESPACE;
  });

  it('uses only deployment and component as dimensions', () => {
    process.env.METRIC_DEPLOYMENT = 'rat-things-demo';
    const metric = embeddedMetric(
      'dispatcher',
      'ProcessingDuration',
      125,
      'Milliseconds',
      1_000,
    );

    expect(metric).toMatchObject({
      Deployment: 'rat-things-demo',
      Component: 'dispatcher',
      ProcessingDuration: 125,
      _aws: {
        Timestamp: 1_000,
        CloudWatchMetrics: [{
          Namespace: 'RatThings',
          Dimensions: [['Deployment', 'Component']],
          Metrics: [{ Name: 'ProcessingDuration', Unit: 'Milliseconds' }],
        }],
      },
    });
    expect(metric).not.toHaveProperty('RunId');
    expect(metric).not.toHaveProperty('MessageId');
  });

  it('derives queue delay from the SQS sent timestamp without emitting identifiers', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    emitSqsQueueDelay(
      'conversation-coordinator',
      { attributes: { SentTimestamp: '1000' } } as never,
      1_750,
    );

    expect(info).toHaveBeenCalledOnce();
    const metric = JSON.parse(String(info.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(metric).toMatchObject({
      Component: 'conversation-coordinator',
      QueueDelay: 750,
    });
    expect(JSON.stringify(metric)).not.toContain('messageId');
  });
});
