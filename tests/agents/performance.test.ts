import { describe, expect, it } from 'vitest';
import { PerformanceScope, performanceCount, performanceMetricRecord, requestPerformanceOperation, type PerformanceRecord } from '../../src/core/performance.js';
import { measuredDynamo, measuredS3 } from '../../src/adapters/aws-performance.js';

describe('bounded performance observations', () => {
  it('isolates simultaneous requests and finishes once without logging caller content', async () => {
    const records: PerformanceRecord[] = [];
    let now = 0;
    const first = new PerformanceScope('session-input', { now: () => now, wallNow: () => 1000, sink: r => records.push(r) });
    const second = new PerformanceScope('activity-stream', { now: () => now, wallNow: () => 1000, sink: r => records.push(r) });
    await Promise.all([
      first.run(async () => { await Promise.resolve(); performanceCount('ResponseBytes', 12); now = 10; }),
      second.run(async () => { performanceCount('ResponseBytes', 34); await Promise.resolve(); }),
    ]);
    first.finish('success'); first.finish('error'); second.finish('aborted');
    expect(records.map(r => r.metrics.ResponseBytes)).toEqual([12, 34]);
    expect(records.map(r => [r.durationMs, r.outcome])).toEqual([[10, 'success'], [10, 'aborted']]);
    expect(performanceMetricRecord(records[0]!)).not.toHaveProperty('_aws');
    const emf = performanceMetricRecord(records[0]!, 'local', 'RatThings', true);
    expect(emf._aws?.CloudWatchMetrics[0]!.Dimensions).toEqual([['Deployment', 'Component', 'Operation', 'Outcome']]);
    expect(JSON.stringify(emf)).not.toMatch(/owner|session_id|actor|prompt|authorization|token/);
  });
  it('reports actual AWS capacity, request attempts and failures without swallowing the failure', async () => {
    let record: PerformanceRecord | undefined;
    const scope = new PerformanceScope('activity-stream', { sink: r => { record = r; } });
    const error = Object.assign(new Error('failure'), { $metadata: { attempts: 3 } });
    await scope.run(async () => {
      await measuredDynamo(async () => ({ $metadata: { attempts: 1 }, ConsumedCapacity: { CapacityUnits: 2 } }), 'read');
      await measuredDynamo(async () => ({ ConsumedCapacity: [{ ReadCapacityUnits: 1, WriteCapacityUnits: 6 }, { CapacityUnits: 2 }] }), 'write');
      await expect(measuredS3(async () => { throw error; }, 'get')).rejects.toBe(error);
    });
    scope.finish('error');
    expect(record?.metrics).toEqual({ DynamoAttempts: 2, DynamoCapacityReports: 2, DynamoReadCapacity: 3, DynamoWriteCapacity: 6,
      DynamoUnclassifiedCapacity: 2, S3GetCount: 1, S3Attempts: 3, S3Errors: 1 });
  });
  it('does not let an unavailable metric sink change an operation outcome', async () => {
    const scope = new PerformanceScope('share-transfer', { sink: () => { throw new Error('offline'); } });
    expect(await scope.run(async () => 42)).toBe(42);
    expect(() => scope.finish('success')).not.toThrow();
  });
  it('classifies route shapes without including arbitrary path values', () => {
    expect(requestPerformanceOperation('POST', '/v1/agents/sessions/private-id/events')).toBe('session-input');
    expect(requestPerformanceOperation('GET', '/v1/rat/sessions/private-id/activity/events')).toBe('activity-stream');
    expect(requestPerformanceOperation('POST', '/v1/rat/shares/private-id/activate')).toBe('share-request');
    expect(requestPerformanceOperation('GET', '/arbitrary/private-data')).toBe('other');
  });
});
