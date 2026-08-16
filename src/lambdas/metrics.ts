import type { SQSRecord } from 'aws-lambda';

const DEFAULT_NAMESPACE = 'RatThings';
const MAX_SQS_RETENTION_MS = 14 * 24 * 60 * 60 * 1_000;

export type MetricUnit = 'Count' | 'Milliseconds';

export function emitSqsQueueDelay(
  component: string,
  record: Pick<SQSRecord, 'attributes'>,
  observedAt = Date.now(),
): void {
  const sentAt = Number(record.attributes.SentTimestamp);
  if (!Number.isFinite(sentAt) || sentAt < 0 || sentAt > observedAt) return;
  const delay = observedAt - sentAt;
  if (delay > MAX_SQS_RETENTION_MS) return;
  emitMetric(component, 'QueueDelay', delay, 'Milliseconds', observedAt);
}

export function emitMetric(
  component: string,
  name: string,
  value: number,
  unit: MetricUnit,
  timestamp = Date.now(),
): void {
  console.info(JSON.stringify(embeddedMetric(component, name, value, unit, timestamp)));
}

export function embeddedMetric(
  component: string,
  name: string,
  value: number,
  unit: MetricUnit,
  timestamp: number,
): Record<string, unknown> {
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(component)) {
    throw new Error('metric component is invalid');
  }
  if (!/^[A-Z][A-Za-z0-9]{0,62}$/.test(name)) throw new Error('metric name is invalid');
  if (!Number.isFinite(value) || value < 0) throw new Error('metric value is invalid');
  if (!Number.isFinite(timestamp) || timestamp < 0) throw new Error('metric timestamp is invalid');
  const deployment = process.env.METRIC_DEPLOYMENT ?? 'local';
  const namespace = process.env.METRIC_NAMESPACE ?? DEFAULT_NAMESPACE;
  return {
    _aws: {
      Timestamp: Math.floor(timestamp),
      CloudWatchMetrics: [{
        Namespace: namespace,
        Dimensions: [['Deployment', 'Component']],
        Metrics: [{ Name: name, Unit: unit }],
      }],
    },
    Deployment: deployment,
    Component: component,
    [name]: value,
  };
}
