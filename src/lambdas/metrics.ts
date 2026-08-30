import type { SQSRecord } from 'aws-lambda';
import { emitMetric } from '../core/metrics.js';
export { embeddedMetric, emitMetric, type MetricUnit } from '../core/metrics.js';

const MAX_SQS_RETENTION_MS = 14 * 24 * 60 * 60 * 1_000;

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
