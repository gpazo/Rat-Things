import { afterEach, describe, expect, it, vi } from 'vitest';
import { emitMicrovmStartupObservation } from '../../src/lambdas/dispatcher.js';
import { embeddedMetric, emitSqsQueueDelay } from '../../src/lambdas/metrics.js';
import { emitMetric } from '../../src/core/metrics.js';
import { PerformanceScope } from '../../src/core/performance.js';

describe('low-cardinality Lambda metrics', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    delete process.env.METRIC_DEPLOYMENT;
    delete process.env.METRIC_NAMESPACE;
  });

  it('emits unwrapped newline-delimited metrics through the Web Function runtime', () => {
    vi.stubEnv('AWS_LAMBDA_HTTP_ENDPOINT', '127.0.0.1:8080');
    vi.stubEnv('RAT_PERFORMANCE_EMF', 'true');
    const output: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { output.push(String(chunk)); return true; });
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    emitMetric('integrations', 'OutputRedactions', 1, 'Count', 1000);
    new PerformanceScope('session-input').finish('success');
    expect(info).not.toHaveBeenCalled();
    expect(stdout).toHaveBeenCalledTimes(2);
    expect(output.every(line => line.endsWith('\n') && line.trim().split('\n').length === 1)).toBe(true);
    const records = output.map(line => JSON.parse(line));
    expect(records[0]).toMatchObject({ OutputRedactions: 1, _aws: { Timestamp: 1000 } });
    expect(records[1]).toMatchObject({ event: 'rat.performance', Operation: 'session-input', _aws: { CloudWatchMetrics: expect.any(Array) } });
    expect(records.every(record => record._aws && !record.message)).toBe(true);
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
      'agents-outbox',
      { attributes: { SentTimestamp: '1000' } } as never,
      1_750,
    );

    expect(info).toHaveBeenCalledOnce();
    const metric = JSON.parse(String(info.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(metric).toMatchObject({
      Component: 'agents-outbox',
      QueueDelay: 750,
    });
    expect(JSON.stringify(metric)).not.toContain('messageId');
  });

  it('reports launch duration and failure without execution identifiers', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    emitMicrovmStartupObservation({ mode: 'launch', outcome: 'succeeded', durationMs: 42_000 });
    emitMicrovmStartupObservation({ mode: 'launch', outcome: 'failed', durationMs: 6_000 });

    const metrics = info.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
    expect(metrics).toHaveLength(3);
    expect(metrics[0]).toMatchObject({ Component: 'dispatcher', MicrovmLaunchRequestDuration: 42_000 });
    expect(metrics[1]).toMatchObject({ Component: 'dispatcher', MicrovmLaunchRequestDuration: 6_000 });
    expect(metrics[2]).toMatchObject({ Component: 'dispatcher', MicrovmStartupFailure: 1 });
    expect(JSON.stringify(metrics)).not.toMatch(/runId|microvmId|ownerId/);
  });
});
