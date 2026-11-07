import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import rates from '../../testing/performance-cost/us-west-2-rates.json' with { type: 'json' };
import { compareViewerBaseline, estimateCost, parseLogExport, parseManifest, parseRateCard, type LogEvent, type Manifest } from '../../testing/performance-cost/cost.js';

const card = parseRateCard(rates);
const start = Date.parse('2026-11-07T00:00:00Z');
const manifest: Manifest = {
  schemaVersion: 1, region: 'us-west-2', phase: 'idle-viewers', start: new Date(start).toISOString(), end: new Date(start + 60_000).toISOString(),
  isolatedPhase: true, completeWindowExport: true, viewerHours: 20 / 60,
  sources: [{ function: 'agents-api', architecture: 'arm64', files: ['api.json'] }],
};
function perf(metrics: Record<string, unknown> = {}, requestId = 'request-1'): LogEvent {
  return { timestamp: start + 2000, message: `${new Date(start + 2000).toISOString()}\t${requestId}\tINFO\t${JSON.stringify({
    event: 'rat.performance', Operation: 'activity-stream', Outcome: 'success', RequestDuration: 1000,
    _aws: { Timestamp: start + 1000 }, ...metrics,
  })}` };
}
function report(requestId = 'request-1', billed = 1000, memory = 512): LogEvent {
  return { timestamp: start + 2001, message: `REPORT RequestId: ${requestId}\tDuration: 997.51 ms\tBilled Duration: ${billed} ms\tMemory Size: ${memory} MB\tMax Memory Used: 129 MB` };
}
function invocationStart(requestId: string, timestamp = start + 1000): LogEvent {
  return { timestamp, message: `START RequestId: ${requestId} Version: $LATEST` };
}
function run(events: LogEvent[], config = manifest) { return estimateCost(config, card, [{ source: config.sources[0]!, events }]); }
const readMetrics = { DynamoAttempts: 1, DynamoCapacityReports: 1, DynamoReadCapacity: 2, S3GetCount: 3, S3Attempts: 3 };

describe('measured variable collaboration cost', () => {
  it('uses REPORT billed GB-seconds, fractional capacity and exact per-unit rates', () => {
    const estimate = run([perf({ ...readMetrics, DynamoReadCapacity: 0.5, DynamoWriteCapacity: 6, S3PutCount: 2, S3Attempts: 5 }), report()]);
    const source = estimate.sources[0]!;
    expect(source.components.lambdaCompute.units).toBe(0.5);
    expect(source.components.lambdaCompute.usd).toBeCloseTo(0.5 * 0.0000133334, 14);
    expect(source.components.lambdaRequests.usd).toBe(0.0000002);
    expect(source.components.dynamoRead.usd).toBe(0.5 * 0.000000125);
    expect(source.components.dynamoWrite.usd).toBe(6 * 0.000000625);
    expect(source.components.s3Get.usd).toBe(3 * 0.0000004);
    expect(source.components.s3Put.usd).toBe(2 * 0.000005);
    expect(estimate.subtotal.usd).toBeCloseTo(0.0000218792, 12);
    expect(source.coverage.requestIdCorrelationComplete).toBe(true);
    expect(estimate.label).toContain('not a billed total');
  });
  it('does not multiply transaction capacity again or price unclassified/missing capacity', () => {
    const estimate = run([perf({ DynamoAttempts: 4, DynamoCapacityReports: 2, DynamoCapacityMissing: 1,
      DynamoReadCapacity: 1, DynamoWriteCapacity: 8, DynamoUnclassifiedCapacity: 19 }), report()]);
    const source = estimate.sources[0]!;
    expect(source.components.dynamoWrite.units).toBe(8);
    expect(source.components.dynamoWrite.usd).toBe(0.000005);
    expect(source.components.dynamoWrite.coverage).toBe('partial');
    expect(source.coverage).toMatchObject({ capacityMissing: 1, capacityUnclassified: 19, dynamoExtraAttempts: 1 });
    expect(source.components.s3Get.usd).toBeNull();
  });
  it('preserves missing compute as unknown even when wall duration is present', () => {
    const estimate = run([perf(readMetrics)]);
    expect(estimate.sources[0]!.components.lambdaCompute.usd).toBeNull();
    expect(estimate.sources[0]!.components.lambdaRequests.units).toBeNull();
    expect(estimate.sources[0]!.coverage.missingReports).toBe(1);
    expect(estimate.computeAndRead.completeForListedComponents).toBe(false);
    expect(run([]).subtotal.usd).toBeNull();
  });
  it('marks every component partial for an invocation with START but no final records', () => {
    const complete = run([invocationStart('request-1'), perf(readMetrics), report()]);
    const incomplete = run([invocationStart('request-1'), perf(readMetrics), report(), invocationStart('still-running')]);
    expect(incomplete.subtotal.usd).toBe(complete.subtotal.usd);
    expect(incomplete.sources[0]!.coverage).toMatchObject({ starts: 2, startsWithoutReport: 1, missingReports: 0, requestIdCorrelationComplete: false });
    expect(incomplete.computeAndRead.completeForListedComponents).toBe(false);
    for (const component of Object.values(incomplete.sources[0]!.components)) if (component.units !== null) expect(component.coverage).toBe('partial');
    expect(compareViewerBaseline(incomplete, run([perf(readMetrics), report()], { ...manifest, viewerHours: 0 })).usdPerViewerHour).toBeNull();
  });
  it('matches structured STARTs and deduplicates repeat starts regardless of event order', () => {
    const structured = { timestamp: start + 1000, message: JSON.stringify({ type: 'platform.start', record: { requestId: 'request-1', version: '$LATEST' } }) };
    const estimate = run([report(), structured, perf(readMetrics), invocationStart('request-1', start + 1001)]);
    expect(estimate.sources[0]!.coverage).toMatchObject({ starts: 1, startsWithoutReport: 0, duplicates: 1 });
    expect(estimate.computeAndRead.completeForListedComponents).toBe(true);
  });
  it('does not invent missing starts when a start predates the export window', () => {
    const estimate = run([invocationStart('request-1', start - 100), perf({ ...readMetrics, StartedAt: start - 100 }), report()]);
    expect(estimate.sources[0]!.coverage).toMatchObject({ starts: 0, startsWithoutReport: 0, outsideWindow: 1, crossingWindow: 1 });
    expect(estimate.computeAndRead.completeForListedComponents).toBe(false);
  });
  it('marks storage partial when a REPORT lacks its performance record', () => {
    const estimate = run([perf(readMetrics), report(), report('no-performance-record')]);
    expect(estimate.sources[0]!.coverage.reportsWithoutScope).toBe(1);
    expect(estimate.sources[0]!.components.dynamoRead.coverage).toBe('partial');
    expect(estimate.sources[0]!.components.s3Get.coverage).toBe('partial');
  });
  it('keeps reported zero distinct from absent metrics and marks old telemetry partial', () => {
    const source = run([perf({ DynamoReadCapacity: 0, S3GetCount: 0 }), report()]).sources[0]!;
    expect(source.components.dynamoRead).toMatchObject({ units: 0, usd: 0, coverage: 'partial' });
    expect(source.components.dynamoWrite.units).toBeNull();
    expect(source.components.s3Get).toMatchObject({ units: 0, usd: 0, coverage: 'partial' });
  });
  it('discloses S3 logical request uncertainty instead of guessing retry classes', () => {
    const source = run([perf({ S3GetCount: 4, S3PutCount: 1, S3Attempts: 8, S3Errors: 1 }), report()]).sources[0]!;
    expect(source.components.s3Get).toMatchObject({ units: 4, coverage: 'partial' });
    expect(source.components.s3Put.usd).toBe(0.000005);
    expect(source.coverage.s3ExtraAttempts).toBe(3);
  });
  it('deduplicates overlapping exports and REPORTs without discarding distinct operations', () => {
    const p = { ...perf(readMetrics), eventId: 'event-1' };
    const r = report();
    const source = run([p, p, r, { ...r, timestamp: r.timestamp + 1 }, perf(readMetrics, 'request-2'), report('request-2')]).sources[0]!;
    expect(source.coverage).toMatchObject({ performanceRecords: 2, reports: 2, duplicates: 2 });
    expect(source.components.lambdaCompute.units).toBe(1);
  });
  it('handles structured Lambda logs and platform REPORTs', () => {
    const message = JSON.parse(perf(readMetrics).message.slice(perf(readMetrics).message.indexOf('{'))) as unknown;
    const source = run([
      { timestamp: start + 2000, message: JSON.stringify({ requestId: 'structured-1', message }) },
      { timestamp: start + 2001, message: JSON.stringify({ type: 'platform.report', record: { requestId: 'structured-1', metrics: { billedDurationMs: 1500, memorySizeMB: 1024 } } }) },
    ]).sources[0]!;
    expect(source.components.lambdaCompute.units).toBe(1.5);
    expect(source.coverage.requestIdCorrelationComplete).toBe(true);
  });
  it('uses a half-open event window and discloses scopes crossing its boundary', () => {
    const source = run([perf({ _aws: { Timestamp: start - 100 } }), report(), { ...report('outside'), timestamp: start + 60_000 }]).sources[0]!;
    expect(source.coverage).toMatchObject({ outsideWindow: 1, crossingWindow: 1, reports: 1 });
    expect(source.components.lambdaCompute.coverage).toBe('partial');
  });
  it('counts invalid telemetry without outputting log content or accepting negative units', () => {
    const invalid = perf({ DynamoReadCapacity: -1, token: 'secret-must-not-appear' });
    const estimate = run([invalid, { timestamp: start + 1, message: 'unrelated secret-must-not-appear' }, report()]);
    expect(estimate.sources[0]!.coverage.invalidRecords).toBe(1);
    expect(estimate.sources[0]!.components.dynamoRead.usd).toBeNull();
    expect(JSON.stringify(estimate)).not.toContain('secret-must-not-appear');
  });
  it('requires matched zero-viewer baseline coverage for a marginal estimate', () => {
    const current = run([perf(readMetrics), report()]);
    const baseline = run([perf({ ...readMetrics, DynamoReadCapacity: 1, S3GetCount: 1, S3Attempts: 1 }), report('request-1', 500)], { ...manifest, viewerHours: 0 });
    const marginal = compareViewerBaseline(current, baseline);
    expect(marginal.usdPerViewerHour).toBeCloseTo((0.25 * 0.0000133334 + 0.000000125 + 2 * 0.0000004) / (20 / 60), 14);
    expect(compareViewerBaseline(current, run([], { ...manifest, viewerHours: 0 })).usdPerViewerHour).toBeNull();
    expect(() => compareViewerBaseline(current, current)).toThrow('zero-viewer baseline');
  });
  it('keeps functions and architecture rates distinct', () => {
    const config = { ...manifest, sources: [...manifest.sources, { function: 'agents-outbox', architecture: 'x86_64' as const, files: ['outbox.json'] }] };
    const estimate = estimateCost(config, card, config.sources.map(source => ({ source, events: [perf(readMetrics), report()] })));
    expect(estimate.sources[1]!.components.lambdaCompute.usd).toBe(0.5 * 0.0000166667);
    expect(estimate.sources[0]!.components.lambdaCompute.usd).toBe(0.5 * 0.0000133334);
  });
  it('counts emitted metric series across sources without multiplying by event count', () => {
    const emf = { Timestamp: start + 1000, CloudWatchMetrics: [{ Namespace: 'RatThings', Dimensions: [['Deployment', 'Operation', 'Outcome']],
      Metrics: [{ Name: 'RequestDuration', Unit: 'Milliseconds' }, { Name: 'S3GetCount', Unit: 'Count' }] }] };
    const events = [perf({ ...readMetrics, Deployment: 'test', _aws: emf }), perf({ ...readMetrics, Deployment: 'test', _aws: emf }, 'request-2'),
      perf({ ...readMetrics, Deployment: 'test', Outcome: 'aborted', _aws: emf }, 'request-3')];
    expect(run(events).customMetrics.observedEmfSeries).toBe(4);
    const logsOnly = run([perf({ ...readMetrics, _aws: undefined, StartedAt: start + 1000 }), report()]);
    expect(logsOnly.customMetrics.observedEmfSeries).toBe(0);
    expect(logsOnly.computeAndRead.completeForListedComponents).toBe(true);
    expect(JSON.stringify(run(events).customMetrics)).not.toContain('request-');
  });
  it('normalizes baseline duration and retains a negative measured difference', () => {
    const current = run([perf(readMetrics), report()]);
    const baseline = run([perf(readMetrics), report('request-1', 4000)], { ...manifest, viewerHours: 0, end: new Date(start + 120_000).toISOString() });
    const comparison = compareViewerBaseline(current, baseline);
    expect(comparison.normalizedBaselineUsd).toBe(baseline.computeAndRead.observedUsd! / 2);
    expect(comparison.usdPerViewerHour).toBeLessThan(0);
  });
});

describe('input and CLI boundary', () => {
  it('accepts CloudWatch exported events and JSONL, and rejects unbounded/ambiguous inputs', () => {
    const events = [perf(), report()];
    expect(parseLogExport(JSON.stringify({ events }))).toEqual(events);
    expect(parseLogExport(events.map(e => JSON.stringify(e)).join('\n'))).toEqual(events);
    expect(() => parseLogExport('REPORT RequestId: no-timestamp')).toThrow();
    expect(() => parseManifest({ ...manifest, end: manifest.start })).toThrow();
    expect(() => parseManifest({ ...manifest, sources: [manifest.sources[0], manifest.sources[0]] })).toThrow();
    expect(() => parseRateCard({ ...rates, rates: { ...rates.rates, dynamoRead: { ...rates.rates.dynamoRead, unit: 'million-requests' } } })).toThrow();
    expect(() => run([], { ...manifest, region: 'us-east-1' })).toThrow('regions differ');
  });
  it('runs the real CLI using exported log files and a baseline manifest', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'performance-cost-'));
    try {
      await writeFile(join(directory, 'api.json'), JSON.stringify({ events: [perf(readMetrics), report()] }));
      await writeFile(join(directory, 'phase.json'), JSON.stringify(manifest));
      await writeFile(join(directory, 'baseline.json'), JSON.stringify({ ...manifest, viewerHours: 0 }));
      const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'testing/performance-cost/cli.ts',
        '--manifest', join(directory, 'phase.json'), '--rates', resolve('testing/performance-cost/us-west-2-rates.json'), '--baseline', join(directory, 'baseline.json')]);
      const result = JSON.parse(stdout) as { subtotal: { usd: number }; marginalViewerHour: { usdPerViewerHour: number } };
      expect(result.subtotal.usd).toBeGreaterThan(0);
      expect(result.marginalViewerHour.usdPerViewerHour).toBe(0);
      expect(stderr).toBe('');
      expect(await readFile(join(directory, 'api.json'), 'utf8')).toContain('rat.performance');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
