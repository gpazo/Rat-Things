import { AsyncLocalStorage } from 'node:async_hooks';
import { writeMetricRecord } from './metrics.js';

export type PerformanceOperation = 'session-input' | 'session-create' | 'activity-stream' | 'activity-snapshot' | 'share-request' | 'share-transfer' | 'outbox-batch' | 'other';
export type PerformanceOutcome = 'success' | 'client-error' | 'server-error' | 'aborted' | 'error';
const units = {
  ResponseHeadersDuration: 'Milliseconds', ResponseBytes: 'Bytes',
  StorageGetCount: 'Count', StorageListCount: 'Count', StorageTransactionCount: 'Count',
  DynamoReadCapacity: 'Count', DynamoWriteCapacity: 'Count', DynamoUnclassifiedCapacity: 'Count',
  DynamoAttempts: 'Count', DynamoErrors: 'Count', DynamoCapacityReports: 'Count', DynamoCapacityMissing: 'Count',
  DynamoReadDuration: 'Milliseconds', DynamoWriteDuration: 'Milliseconds',
  S3GetCount: 'Count', S3PutCount: 'Count', S3Attempts: 'Count', S3Errors: 'Count',
  S3ReadBytes: 'Bytes', S3WriteBytes: 'Bytes',
  S3GetDuration: 'Milliseconds', S3PutDuration: 'Milliseconds',
  HydrationCacheHits: 'Count', HydrationCacheMisses: 'Count', HydrationCacheCoalesced: 'Count', HydrationCacheEvictions: 'Count', HydrationCacheBytes: 'Bytes',
  AuthorizationCount: 'Count', ActivityPollCount: 'Count', ActivityEventCount: 'Count',
  AuthorizationDuration: 'Milliseconds',
  FeedbackBatchMessages: 'Count', FeedbackBatchCount: 'Count', FeedbackCollectionDuration: 'Milliseconds',
  SubmissionConflicts: 'Count', SubmissionAcceptedDuration: 'Milliseconds',
  SubmissionContractDuration: 'Milliseconds', SubmissionConfigurationDuration: 'Milliseconds', SubmissionPlanningDuration: 'Milliseconds',
  SubmissionReadDuration: 'Milliseconds', SubmissionValidationDuration: 'Milliseconds',
  SubmissionRateLimitDuration: 'Milliseconds', SubmissionCommitDuration: 'Milliseconds',
  SubmissionRecoveryDuration: 'Milliseconds',
  OutboxRetryCount: 'Count', OutboxFailureCount: 'Count',
  ShareQuiesceDuration: 'Milliseconds', ShareSnapshotDuration: 'Milliseconds',
  ShareUploadDuration: 'Milliseconds', ShareStageDuration: 'Milliseconds',
  ShareReleaseDuration: 'Milliseconds', ShareActivateDuration: 'Milliseconds',
  ShareArchiveBytes: 'Bytes', ShareWorkspaceBytes: 'Bytes',
} as const;
export type PerformanceMetric = keyof typeof units;
export interface PerformanceRecord {
  operation: PerformanceOperation;
  outcome: PerformanceOutcome;
  startedAt: number;
  durationMs: number;
  metrics: Partial<Record<PerformanceMetric, number>>;
}
const context = new AsyncLocalStorage<PerformanceScope>();

/** One bounded aggregate per request/transfer; never include content or identities. */
export class PerformanceScope {
  private readonly startedAt: number;
  private readonly started: number;
  private readonly values: Partial<Record<PerformanceMetric, number>> = {};
  private finished = false;
  public constructor(private readonly operation: PerformanceOperation, private readonly options: {
    now?: () => number; wallNow?: () => number; sink?: (record: PerformanceRecord) => void;
  } = {}) {
    this.started = this.now(); this.startedAt = (options.wallNow ?? Date.now)();
  }
  private now() { return (this.options.now ?? (() => performance.now()))(); }
  public run<T>(work: () => T): T { return context.run(this, work); }
  public add(name: PerformanceMetric, value = 1) {
    if (!this.finished && Number.isFinite(value) && value >= 0) this.values[name] = (this.values[name] ?? 0) + value;
  }
  public elapsed() { return Math.max(0, this.now() - this.started); }
  public finish(outcome: PerformanceOutcome): void {
    if (this.finished) return;
    this.finished = true;
    const record: PerformanceRecord = { operation: this.operation, outcome, startedAt: this.startedAt,
      durationMs: this.elapsed(), metrics: { ...this.values } };
    // Telemetry failure cannot change a committed operation or its acknowledgement.
    try { (this.options.sink ?? emitPerformance)(record); } catch { /* Best-effort telemetry. */ }
  }
}

export function performanceCount(name: PerformanceMetric, value = 1) { context.getStore()?.add(name, value); }
export function performanceHeaders() { const scope = context.getStore(); if (scope) scope.add('ResponseHeadersDuration', scope.elapsed()); }
export async function performancePhase<T>(name: PerformanceMetric, work: () => Promise<T>): Promise<T> {
  const scope = context.getStore();
  if (!scope) return work();
  const started = performance.now();
  try { return await work(); } finally { scope.add(name, Math.max(0, performance.now() - started)); }
}
export function performancePhaseSync<T>(name: PerformanceMetric, work: () => T): T {
  const scope = context.getStore();
  if (!scope) return work();
  const started = performance.now();
  try { return work(); } finally { scope.add(name, Math.max(0, performance.now() - started)); }
}
export function requestPerformanceOperation(method: string, pathname: string): PerformanceOperation {
  const path = pathname.split('/').filter(Boolean);
  if (path[0] !== 'v1') return 'other';
  if (path[1] === 'agents' && path[2] === 'sessions') {
    if (method === 'POST' && path.length === 3) return 'session-create';
    if (method === 'POST' && path.length === 5 && path[4] === 'events') return 'session-input';
  }
  if (method === 'GET' && path[1] === 'rat' && path[2] === 'sessions' && path[4] === 'activity') {
    if (path.length === 5) return 'activity-snapshot';
    if (path.length === 6 && path[5] === 'events') return 'activity-stream';
  }
  if (path[1] === 'rat' && path[2] === 'shares' || path[1] === 'workspace' && path[2] === 'shares') return 'share-request';
  return 'other';
}
export function responsePerformanceOutcome(status: number): PerformanceOutcome {
  return status >= 500 ? 'server-error' : status >= 400 ? 'client-error' : 'success';
}
export function performanceMetricRecord(record: PerformanceRecord, deployment = 'local', namespace = 'RatThings', publishMetrics = false) {
  return {
    event: 'rat.performance', Operation: record.operation, Outcome: record.outcome,
    Deployment: deployment, Component: 'collaboration', StartedAt: record.startedAt, RequestCount: 1, RequestDuration: record.durationMs,
    ...record.metrics,
    ...(publishMetrics ? { _aws: { Timestamp: record.startedAt, CloudWatchMetrics: [{ Namespace: namespace,
      Dimensions: [['Deployment', 'Component', 'Operation', 'Outcome']],
      Metrics: [{ Name: 'RequestCount', Unit: 'Count' }, { Name: 'RequestDuration', Unit: 'Milliseconds' },
        ...Object.keys(record.metrics).map(name => ({ Name: name, Unit: units[name as PerformanceMetric] }))],
    }] } } : {}),
  };
}
function emitPerformance(record: PerformanceRecord) {
  writeMetricRecord(performanceMetricRecord(record, process.env.METRIC_DEPLOYMENT, process.env.METRIC_NAMESPACE, process.env.RAT_PERFORMANCE_EMF === 'true'));
}
