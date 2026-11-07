export type Architecture = 'arm64' | 'x86_64';
export interface LogSource { function: string; architecture: Architecture; files: string[] }
export interface Manifest {
  schemaVersion: 1;
  region: string;
  phase: string;
  start: string;
  end: string;
  sources: LogSource[];
  viewerHours?: number;
  isolatedPhase: boolean;
  completeWindowExport: boolean;
}
const rateUnits = {
  lambdaArmGbSecond: 'GB-second', lambdaX86GbSecond: 'GB-second', lambdaRequest: 'request',
  dynamoRead: 'read-request-unit', dynamoWrite: 'write-request-unit', s3Get: 'request', s3Put: 'request',
} as const;
type RateName = keyof typeof rateUnits;
export interface Rate {
  usdPerUnit: string;
  unit: string;
  source: { url: string; sku: string; rateCode: string; usageType: string; offerVersion: string;
    publicationDate: string; effectiveDate: string; retrievedAt: string };
}
export interface RateCard { schemaVersion: 1; region: string; currency: 'USD'; basis: string; rates: Record<RateName, Rate> }
export interface LogEvent { timestamp: number; message: string; eventId?: string; logStreamName?: string }
export interface SourceLogs { source: LogSource; events: LogEvent[] }
const operations = ['session-input', 'session-create', 'activity-stream', 'activity-snapshot', 'share-request', 'share-transfer', 'outbox-batch', 'other'];
const outcomes = ['success', 'client-error', 'server-error', 'aborted', 'error'];
const metricNames = ['RequestDuration', 'ResponseBytes', 'StorageGetCount', 'StorageListCount', 'StorageTransactionCount',
  'DynamoReadCapacity', 'DynamoWriteCapacity', 'DynamoUnclassifiedCapacity', 'DynamoAttempts', 'DynamoErrors',
  'DynamoCapacityReports', 'DynamoCapacityMissing', 'S3GetCount', 'S3PutCount', 'S3Attempts', 'S3Errors',
  'S3ReadBytes', 'S3WriteBytes', 'AuthorizationCount', 'ActivityPollCount', 'ActivityEventCount', 'SubmissionConflicts',
  'DynamoReadDuration', 'DynamoWriteDuration', 'S3GetDuration', 'S3PutDuration', 'AuthorizationDuration',
  'SubmissionAcceptedDuration', 'SubmissionReadDuration', 'SubmissionValidationDuration', 'SubmissionRateLimitDuration',
  'SubmissionCommitDuration', 'SubmissionRecoveryDuration', 'InputConnectionDuration', 'OutboxRetryCount', 'OutboxFailureCount',
  'HydrationCacheHits', 'HydrationCacheMisses', 'HydrationCacheCoalesced', 'HydrationCacheEvictions',
  'FeedbackBatchMessages', 'FeedbackBatchCount', 'FeedbackCollectionDuration'] as const;
type Metric = typeof metricNames[number];
type Metrics = Partial<Record<Metric, number>>;
type Observation =
  | { kind: 'performance'; operation: string; outcome: string; metrics: Metrics; emfSeries: string[]; requestId?: string; startedAt?: number }
  | { kind: 'start'; requestId: string }
  | { kind: 'report'; requestId: string; billedMs: number; memoryMb: number }
  | { kind: 'invalid' }
  | { kind: 'other' };

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function nonnegative(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
function requiredObject(value: unknown, label: string): Record<string, unknown> {
  const result = object(value); if (!result) throw new Error(`Invalid ${label}`); return result;
}
function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid ${label}`); return value;
}
function instant(value: unknown, label: string): string {
  const result = requiredString(value, label);
  if (!/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(result) || !Number.isFinite(Date.parse(result))) throw new Error(`Invalid ${label}; include timezone`);
  return result;
}
export function parseManifest(value: unknown): Manifest {
  const v = requiredObject(value, 'manifest');
  if (v.schemaVersion !== 1 || typeof v.isolatedPhase !== 'boolean' || typeof v.completeWindowExport !== 'boolean') throw new Error('Manifest needs schemaVersion 1 and explicit isolatedPhase/completeWindowExport booleans');
  const start = instant(v.start, 'start'), end = instant(v.end, 'end');
  if (Date.parse(end) <= Date.parse(start)) throw new Error('Window end must follow start');
  if (!Array.isArray(v.sources) || !v.sources.length) throw new Error('Manifest needs log sources');
  const sources = v.sources.map((raw): LogSource => {
    const s = requiredObject(raw, 'source');
    const name = requiredString(s.function, 'function');
    if (!/^[a-zA-Z0-9_:.-]+$/.test(name) || (s.architecture !== 'arm64' && s.architecture !== 'x86_64')) throw new Error('Invalid function or architecture');
    if (!Array.isArray(s.files) || !s.files.length || s.files.some(file => typeof file !== 'string' || !file)) throw new Error('Source needs files');
    return { function: name, architecture: s.architecture, files: s.files as string[] };
  });
  if (new Set(sources.map(s => s.function)).size !== sources.length) throw new Error('Combine each function into one source with multiple files');
  if (v.viewerHours !== undefined && !nonnegative(v.viewerHours)) throw new Error('Invalid viewerHours');
  return { schemaVersion: 1, region: requiredString(v.region, 'region'), phase: requiredString(v.phase, 'phase'), start, end, sources,
    isolatedPhase: v.isolatedPhase, completeWindowExport: v.completeWindowExport,
    ...(v.viewerHours === undefined ? {} : { viewerHours: v.viewerHours as number }) };
}
export function parseRateCard(value: unknown): RateCard {
  const v = requiredObject(value, 'rate card');
  if (v.schemaVersion !== 1 || v.currency !== 'USD') throw new Error('Rate card must use schemaVersion 1 and USD');
  const rawRates = requiredObject(v.rates, 'rates');
  const rates = Object.fromEntries(Object.entries(rateUnits).map(([name, unit]) => {
    const r = requiredObject(rawRates[name], `rate ${name}`);
    if (r.unit !== unit || typeof r.usdPerUnit !== 'string' || !/^\d+(?:\.\d+)?$/.test(r.usdPerUnit) || !Number.isFinite(Number(r.usdPerUnit))) throw new Error(`Invalid unit or price for ${name}`);
    const source = requiredObject(r.source, `source for ${name}`);
    for (const field of ['url', 'sku', 'rateCode', 'usageType', 'offerVersion', 'publicationDate', 'effectiveDate', 'retrievedAt']) requiredString(source[field], `rate source ${field}`);
    return [name, { usdPerUnit: r.usdPerUnit, unit, source }];
  })) as Record<RateName, Rate>;
  return { schemaVersion: 1, region: requiredString(v.region, 'rate region'), currency: 'USD', basis: requiredString(v.basis, 'rate basis'), rates };
}

/** Only exported, timestamped events are accepted; raw log contents never enter the report. */
export function parseLogExport(text: string): LogEvent[] {
  let values: unknown;
  try { values = JSON.parse(text); }
  catch { try { values = text.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line) as unknown); }
    catch { throw new Error('Log export must be JSON events or JSONL timestamped events'); } }
  const wrapper = object(values);
  const rows = Array.isArray(values) ? values : Array.isArray(wrapper?.events) ? wrapper.events : wrapper ? [wrapper] : [];
  if (!Array.isArray(values) && !wrapper) throw new Error('Invalid log export');
  return rows.map(raw => {
    const row = requiredObject(raw, 'log event');
    const timestamp = typeof row.timestamp === 'number' ? row.timestamp : typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
    if (!Number.isFinite(timestamp) || typeof row.message !== 'string') throw new Error('Log event needs timestamp and string message');
    return { timestamp, message: row.message,
      ...(typeof row.eventId === 'string' ? { eventId: row.eventId } : {}),
      ...(typeof row.logStreamName === 'string' ? { logStreamName: row.logStreamName } : {}) };
  });
}
function observation(message: string, inheritedRequestId?: string, depth = 0): Observation {
  if (depth > 3) return { kind: 'invalid' };
  const start = /\bSTART RequestId:\s+(\S+)/.exec(message);
  if (start) return { kind: 'start', requestId: start[1]! };
  const report = /\bREPORT RequestId:\s+(\S+).*?Billed Duration:\s+([\d.]+)\s+ms.*?Memory Size:\s+([\d.]+)\s+MB/.exec(message);
  if (report) {
    const billedMs = Number(report[2]), memoryMb = Number(report[3]);
    return nonnegative(billedMs) && memoryMb > 0 && Number.isFinite(memoryMb)
      ? { kind: 'report', requestId: report[1]!, billedMs, memoryMb } : { kind: 'invalid' };
  }
  const offset = message.indexOf('{');
  if (offset < 0) return { kind: message.includes('REPORT RequestId:') ? 'invalid' : 'other' };
  let parsed: unknown;
  try { parsed = JSON.parse(message.slice(offset)); } catch { return { kind: message.includes('rat.performance') || message.includes('platform.report') ? 'invalid' : 'other' }; }
  const p = object(parsed);
  if (!p) return { kind: 'other' };
  const prefixId = /^\S+\s+([a-zA-Z0-9-]+)\s+(?:INFO|WARN|ERROR|DEBUG)\s*$/.exec(message.slice(0, offset))?.[1];
  const requestId = typeof p.requestId === 'string' ? p.requestId : inheritedRequestId ?? prefixId;
  if (p.event === 'rat.performance') {
    if (!operations.includes(p.Operation as string) || !outcomes.includes(p.Outcome as string) || !nonnegative(p.RequestDuration)) return { kind: 'invalid' };
    const metrics: Metrics = {};
    for (const name of metricNames) {
      if (p[name] === undefined) continue;
      if (!nonnegative(p[name])) return { kind: 'invalid' };
      metrics[name] = p[name] as number;
    }
    const startedAt = p.StartedAt ?? object(p._aws)?.Timestamp;
    return { kind: 'performance', operation: p.Operation as string, outcome: p.Outcome as string, metrics, emfSeries: metricSeries(p),
      ...(requestId ? { requestId } : {}), ...(nonnegative(startedAt) ? { startedAt } : {}) };
  }
  if (p.type === 'platform.report') {
    const record = object(p.record), metrics = object(record?.metrics);
    return typeof record?.requestId === 'string' && nonnegative(metrics?.billedDurationMs) && nonnegative(metrics?.memorySizeMB) && metrics.memorySizeMB > 0
      ? { kind: 'report', requestId: record.requestId, billedMs: metrics.billedDurationMs, memoryMb: metrics.memorySizeMB }
      : { kind: 'invalid' };
  }
  if (p.type === 'platform.start') {
    const record = object(p.record);
    return typeof record?.requestId === 'string' && record.requestId ? { kind: 'start', requestId: record.requestId } : { kind: 'invalid' };
  }
  if (typeof p.message === 'string') return observation(p.message, requestId, depth + 1);
  if (object(p.message)) return observation(JSON.stringify(p.message), requestId, depth + 1);
  return { kind: 'other' };
}

function metricSeries(record: Record<string, unknown>): string[] {
  const definitions = object(record._aws)?.CloudWatchMetrics;
  if (!Array.isArray(definitions)) return [];
  return definitions.flatMap(raw => {
    const definition = object(raw);
    if (typeof definition?.Namespace !== 'string' || !Array.isArray(definition.Dimensions) || !Array.isArray(definition.Metrics)) return [];
    const dimensions = definition.Dimensions.filter((value): value is string[] => Array.isArray(value) && value.every(name => typeof name === 'string' && typeof record[name] === 'string'));
    const names = definition.Metrics.map(metric => object(metric)?.Name).filter((name): name is string => typeof name === 'string' && nonnegative(record[name]));
    return dimensions.flatMap(group => names.map(name => JSON.stringify([definition.Namespace, name, ...group.slice().sort().map(dimension => [dimension, record[dimension]])])));
  });
}

export interface Component {
  units: number | null;
  unit: string;
  usd: number | null;
  coverage: 'observed' | 'partial' | 'unavailable';
  basis: string;
}
function component(units: number | null, rate: Rate, partial: boolean, basis: string): Component {
  return { units, unit: rate.unit, usd: units === null ? null : units * Number(rate.usdPerUnit), coverage: units === null ? 'unavailable' : partial ? 'partial' : 'observed', basis };
}
const exclusions = [
  'KMS requests', 'Data transfer and Lambda response streaming bytes', 'CloudWatch log ingestion/storage, custom metrics and queries',
  'Baseline infrastructure and provisioned concurrency', 'Ongoing S3 storage, object versions and DynamoDB storage/backups',
  'Worker compute and model tokens', 'SQS and other uninstrumented service calls',
  'S3 multipart/stream uploads and other calls outside measuredS3', 'DynamoDB adapters outside DynamoAgentsStore',
  'Unknown retry/error charges and missing or unclassified DynamoDB capacity', 'Taxes, credits, free tiers, Savings Plans and account-wide volume discounts',
];
export function estimateCost(manifest: Manifest, card: RateCard, inputs: SourceLogs[]) {
  if (manifest.region !== card.region) throw new Error('Manifest and rate card regions differ');
  if (inputs.length !== manifest.sources.length || inputs.some((input, i) => input.source.function !== manifest.sources[i]?.function || input.source.architecture !== manifest.sources[i]?.architecture)) throw new Error('Log inputs must match manifest sources in order');
  const start = Date.parse(manifest.start), end = Date.parse(manifest.end);
  const emfSeries = new Set<string>();
  const sources = inputs.map(({ source, events }) => {
    const metrics: Metrics = {};
    const operationsSeen: Record<string, number> = {}, outcomesSeen: Record<string, number> = {};
    const seenEvents = new Set<string>(), starts = new Set<string>(), reports = new Map<string, { billedMs: number; memoryMb: number }>();
    const scopeIds = new Set<string>();
    let performanceRecords = 0, invocationScopes = 0, unidentifiedScopes = 0, invalidRecords = 0, duplicates = 0, outsideWindow = 0, crossingWindow = 0, unknownStart = 0;
    for (const event of events) {
      if (event.timestamp < start || event.timestamp >= end) { outsideWindow++; continue; }
      const identity = event.eventId ? `id:${event.eventId}` : `event:${event.logStreamName ?? ''}:${event.timestamp}:${event.message}`;
      if (seenEvents.has(identity)) { duplicates++; continue; } seenEvents.add(identity);
      const obs = observation(event.message);
      if (obs.kind === 'invalid') { invalidRecords++; continue; }
      if (obs.kind === 'other') continue;
      if (obs.kind === 'start') {
        if (starts.has(obs.requestId)) duplicates++;
        starts.add(obs.requestId); continue;
      }
      if (obs.kind === 'report') {
        if (reports.has(obs.requestId)) { duplicates++; continue; }
        reports.set(obs.requestId, obs); continue;
      }
      performanceRecords++;
      for (const series of obs.emfSeries) emfSeries.add(series);
      operationsSeen[obs.operation] = (operationsSeen[obs.operation] ?? 0) + 1;
      outcomesSeen[obs.outcome] = (outcomesSeen[obs.outcome] ?? 0) + 1;
      if (obs.startedAt === undefined) unknownStart++;
      else if (obs.startedAt < start || obs.startedAt + (obs.metrics.RequestDuration ?? 0) >= end) crossingWindow++;
      if (obs.operation !== 'share-transfer') {
        invocationScopes++;
        if (obs.requestId) scopeIds.add(obs.requestId); else unidentifiedScopes++;
      }
      for (const name of metricNames) if (obs.metrics[name] !== undefined) metrics[name] = (metrics[name] ?? 0) + obs.metrics[name]!;
    }
    const missingReports = [...scopeIds].filter(id => !reports.has(id)).length;
    const reportsWithoutScope = [...reports.keys()].filter(id => !scopeIds.has(id)).length;
    const startsWithoutReport = [...starts].filter(id => !reports.has(id)).length;
    const boundaryIncomplete = !manifest.completeWindowExport || !manifest.isolatedPhase || invalidRecords > 0 || crossingWindow > 0 || unknownStart > 0;
    const measurementIncomplete = boundaryIncomplete || missingReports > 0 || unidentifiedScopes > 0 || reportsWithoutScope > 0 || startsWithoutReport > 0;
    const gbSeconds = reports.size ? [...reports.values()].reduce((sum, r) => sum + r.billedMs / 1000 * r.memoryMb / 1024, 0) : null;
    const capacityReports = metrics.DynamoCapacityReports ?? 0, capacityMissing = metrics.DynamoCapacityMissing ?? 0;
    const capacityUnclassified = metrics.DynamoUnclassifiedCapacity ?? 0;
    const dynamoExtraAttempts = Math.max(0, (metrics.DynamoAttempts ?? 0) - capacityReports - capacityMissing);
    const dynamoPartial = measurementIncomplete || !performanceRecords || metrics.DynamoCapacityReports === undefined || capacityMissing > 0 || capacityUnclassified > 0 || dynamoExtraAttempts > 0;
    const s3Logical = (metrics.S3GetCount ?? 0) + (metrics.S3PutCount ?? 0);
    const s3ExtraAttempts = Math.max(0, (metrics.S3Attempts ?? 0) - s3Logical);
    const s3Partial = measurementIncomplete || !performanceRecords || metrics.S3Attempts === undefined || metrics.S3Attempts < s3Logical || s3ExtraAttempts > 0 || (metrics.S3Errors ?? 0) > 0;
    const observedMetric = (name: Metric) => metrics[name] ?? null;
    const components = {
      lambdaCompute: component(gbSeconds, card.rates[source.architecture === 'arm64' ? 'lambdaArmGbSecond' : 'lambdaX86GbSecond'], measurementIncomplete, 'REPORT billed duration milliseconds / 1000 × memory MB / 1024; no wall-duration substitute'),
      lambdaRequests: component(reports.size || null, card.rates.lambdaRequest, measurementIncomplete, 'One invocation request per unique REPORT; extra asynchronous payload request units excluded'),
      dynamoRead: component(observedMetric('DynamoReadCapacity'), card.rates.dynamoRead, dynamoPartial, 'Actual classified ReturnConsumedCapacity read units; no additional transaction multiplier'),
      dynamoWrite: component(observedMetric('DynamoWriteCapacity'), card.rates.dynamoWrite, dynamoPartial, 'Actual classified ReturnConsumedCapacity write units; no additional transaction multiplier'),
      s3Get: component(observedMetric('S3GetCount'), card.rates.s3Get, s3Partial, 'Logical measuredS3 GET calls; retry billing/status classification unavailable'),
      s3Put: component(observedMetric('S3PutCount'), card.rates.s3Put, s3Partial, 'Logical measuredS3 PUT calls; retry billing/status classification unavailable'),
    };
    return { function: source.function, architecture: source.architecture, components, metrics, operations: operationsSeen, outcomes: outcomesSeen,
      coverage: { performanceRecords, invocationScopes, starts: starts.size, startsWithoutReport, reports: reports.size, missingReports, unidentifiedScopes, reportsWithoutScope,
        invalidRecords, duplicates, outsideWindow, crossingWindow, unknownStart, capacityReports, capacityMissing, capacityUnclassified,
        dynamoExtraAttempts, s3ExtraAttempts, requestIdCorrelationComplete: invocationScopes > 0 && !missingReports && !unidentifiedScopes && !reportsWithoutScope && !startsWithoutReport } };
  });
  const all = sources.flatMap(s => Object.values(s.components));
  const priced = all.filter(c => c.usd !== null);
  const computeRead = sources.flatMap(s => [s.components.lambdaCompute, s.components.lambdaRequests, s.components.dynamoRead, s.components.s3Get]);
  const computeReadComplete = computeRead.every(c => c.usd !== null && c.coverage === 'observed');
  const observedComputeReadUsd = computeRead.some(c => c.usd !== null) ? computeRead.reduce((sum, c) => sum + (c.usd ?? 0), 0) : null;
  return {
    label: 'Measured variable collaboration subtotal estimate; not a billed total', currency: 'USD', region: card.region,
    phase: manifest.phase, window: { start: manifest.start, end: manifest.end, seconds: (end - start) / 1000, selection: 'CloudWatch event timestamp in [start, end); complete records only, no duration prorating' },
    assertions: { isolatedPhase: manifest.isolatedPhase, completeWindowExport: manifest.completeWindowExport },
    rates: card, sources,
    customMetrics: { observedEmfSeries: emfSeries.size, basis: 'Distinct emitted namespace, metric name and dimension name/value set across supplied sources. Not proof of successful CloudWatch ingestion. Monthly series price is excluded, not extrapolated from this burst.' },
    subtotal: { usd: priced.length ? priced.reduce((sum, c) => sum + c.usd!, 0) : null, pricedComponents: priced.length, unavailableComponents: all.length - priced.length,
      coverage: 'partial' as const, includes: 'Only listed components with measured units; null components and exclusions are not zero' },
    computeAndRead: { observedUsd: observedComputeReadUsd, completeForListedComponents: computeReadComplete,
      viewerHours: manifest.viewerHours ?? null,
      observedPhaseUsdPerViewerHour: manifest.viewerHours && observedComputeReadUsd !== null ? observedComputeReadUsd / manifest.viewerHours : null,
      interpretation: 'Phase average of observed compute, invocation requests, DynamoDB reads and S3 GETs; not a marginal result or universal viewer price' },
    exclusions,
    warnings: [
      ...(!manifest.isolatedPhase ? ['Window is not asserted isolated; unrelated work may be included.'] : []),
      ...(!manifest.completeWindowExport ? ['Export completeness is not asserted; missing pages or log groups can undercount.'] : []),
      'Unmatched STARTs, missing REPORTs, invalid records, unresolved request IDs and crossing-window scopes make all component coverage partial. Export all pages after streams finish and REPORTs arrive.',
      'START records and controller completion counts are required for an independent completeness check. The estimator cannot detect invocations absent from all supplied logs; a client disconnect does not prove server completion.',
      'S3 logical request dollars are an estimate, not charged attempts. Failed calls and aggregated SDK retries cannot be assigned an exact dollar amount.',
      'An absent metric is unknown, not zero. A reported zero is retained. Unclassified capacity is never priced as reads or writes.',
      'API, outbox and local share scopes must be exported separately. Never add a nested scope to its parent if they measure the same work.',
    ],
  };
}
export type Estimate = ReturnType<typeof estimateCost>;
export function compareViewerBaseline(current: Estimate, baseline: Estimate) {
  if (current.region !== baseline.region || JSON.stringify(current.rates) !== JSON.stringify(baseline.rates)) throw new Error('Baseline must use the same region and rate card');
  const sourceKeys = (value: Estimate) => value.sources.map(s => `${s.function}:${s.architecture}`).sort().join('|');
  if (sourceKeys(current) !== sourceKeys(baseline)) throw new Error('Baseline must cover the same functions and architectures');
  if (baseline.computeAndRead.viewerHours !== 0 || !(current.computeAndRead.viewerHours! > 0)) throw new Error('Marginal comparison needs a zero-viewer baseline and positive measured viewerHours');
  const usable = current.computeAndRead.completeForListedComponents && baseline.computeAndRead.completeForListedComponents;
  const normalizedBaselineUsd = usable ? baseline.computeAndRead.observedUsd! * current.window.seconds / baseline.window.seconds : null;
  const deltaUsd = usable ? current.computeAndRead.observedUsd! - normalizedBaselineUsd! : null;
  return { label: 'Measured marginal viewer-hour compute and read subtotal estimate; not a billed total',
    usdPerViewerHour: deltaUsd === null ? null : deltaUsd / current.computeAndRead.viewerHours!, deltaUsd, normalizedBaselineUsd,
    coverage: usable ? 'observed-listed-components' : 'unavailable',
    basis: 'Current observed compute/read subtotal minus zero-viewer baseline scaled by window seconds, divided by measured viewer-hours. Negative noise is retained. Repeat matched runs; other workload and storage costs remain excluded.' };
}
