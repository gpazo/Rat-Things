import type { DynamoDBRecord, DynamoDBStreamHandler } from 'aws-lambda';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { createAwsClients, EventBridgeRunEvents } from '../adapters/aws-runtime.js';
import { requiredEnv } from '../adapters/executors.js';
import type { RunRecord, RunStateEvent, RunStatus } from '../domain/contracts.js';
import { RUN_STATUSES } from '../domain/contracts.js';

const publisher = new EventBridgeRunEvents(
  createAwsClients().events,
  requiredEnv('EVENT_BUS_NAME'),
);

/**
 * Turns the runs table stream into the durable run-state event source.
 *
 * Direct worker publishing creates a crash window after the state commit. DynamoDB Streams
 * retries this handler until EventBridge accepts the event, while downstream delivery fences
 * make duplicate events harmless.
 */
export const handler: DynamoDBStreamHandler = async (event) => {
  const failures: Error[] = [];
  for (const record of event.Records) {
    try {
      const change = stateChange(record);
      if (change) await publisher.publish(change);
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'failed to publish run state changes');
};

function stateChange(record: DynamoDBRecord): RunStateEvent | undefined {
  if (record.eventName !== 'INSERT' && record.eventName !== 'MODIFY') return undefined;
  const current = decode(record.dynamodb?.NewImage);
  if (!isRunRecord(current)) return undefined;
  const previous = decode(record.dynamodb?.OldImage);
  if (isRunStatus(previous?.status) && previous.status === current.status) return undefined;

  const event: RunStateEvent = {
    version: '1',
    runId: current.runId,
    ownerId: current.ownerId,
    status: current.status,
    sourceKind: current.sourceKind,
    occurredAt: current.updatedAt,
  };
  if (current.result?.preview) event.resultPreview = current.result.preview;
  if (current.error) event.error = current.error;
  return event;
}

function decode(
  image: DynamoDBRecord['dynamodb'] extends infer _T
    ? Record<string, unknown> | undefined
    : never,
): Record<string, unknown> | undefined {
  if (!image) return undefined;
  return unmarshall(image as Parameters<typeof unmarshall>[0]);
}

function isRunRecord(
  value: Record<string, unknown> | undefined,
): value is Record<string, unknown> & RunRecord {
  return Boolean(
    value &&
      typeof value.runId === 'string' &&
      typeof value.ownerId === 'string' &&
      typeof value.updatedAt === 'string' &&
      isRunStatus(value.status) &&
      ['api', 'github', 'gitlab', 'teams', 'slack'].includes(String(value.sourceKind)),
  );
}

function isRunStatus(value: unknown): value is RunStatus {
  return typeof value === 'string' && (RUN_STATUSES as readonly string[]).includes(value);
}
