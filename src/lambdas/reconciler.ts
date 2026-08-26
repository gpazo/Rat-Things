import type { EventBridgeHandler } from 'aws-lambda';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { createAwsClients, DynamoRunStore } from '../adapters/aws-runtime.js';
import { requiredEnv } from '../adapters/executors.js';
import type { RunQueueMessage, RunRecord } from '../domain/contracts.js';
import { recoveryWakeForQueuedRun } from '../core/run-recovery.js';
import { getRoutineService } from '../app/composition.js';
import {
  createExecutionInspectorFromEnv,
  createExecutorRegistryFromEnv,
} from '../adapters/executors.js';
import { ActiveRunReconciler } from '../execution/reconciler.js';
import { emitMetric } from './metrics.js';

const clients = createAwsClients();
const tableName = requiredEnv('RUNS_TABLE_NAME');
const queueUrl = requiredEnv('RUN_QUEUE_URL');
const conversationQueueUrl = requiredEnv('CONVERSATION_QUEUE_URL');
const store = new DynamoRunStore(clients.dynamodb, tableName);
const activeRuns = new ActiveRunReconciler({
  store,
  inspector: createExecutionInspectorFromEnv(),
  executions: createExecutorRegistryFromEnv(),
});

/** Repairs the durable-record/SQS crash window by periodically re-nudging stale queued runs. */
export const handler: EventBridgeHandler<'Scheduled Event', Record<string, never>, void> = async () => {
  const ageSeconds = Math.max(30, Number(process.env.QUEUED_RECONCILE_AGE_SECONDS ?? 90));
  const cutoff = new Date(Date.now() - ageSeconds * 1_000).toISOString();
  await requeue(cutoff);
  await redriveUnattachedExecutions(cutoff);
  const heartbeatAgeSeconds = Math.max(
    30,
    Number(process.env.RUN_HEARTBEAT_STALE_SECONDS ?? 90),
  );
  const heartbeatCutoff = new Date(Date.now() - heartbeatAgeSeconds * 1_000).toISOString();
  await reconcileStaleAttachedExecutions(heartbeatCutoff);
  await reconcileCancellations(cutoff);
  await getRoutineService().tick(Number(process.env.ROUTINE_TICK_LIMIT ?? 100));
};

async function requeue(cutoff: string): Promise<void> {
  let startKey: Record<string, unknown> | undefined;
  let sent = 0;
  do {
    const result = await clients.dynamodb.send(new QueryCommand({
      TableName: tableName,
      IndexName: 'status-updated-index',
      KeyConditionExpression: '#status = :queued AND updatedAt <= :cutoff',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':queued': 'queued', ':cutoff': cutoff },
      Limit: Math.min(100, 500 - sent),
      ...(startKey ? { ExclusiveStartKey: startKey } : {}),
    }));
    for (const run of (result.Items ?? []) as RunRecord[]) {
      await nudgeQueued(run);
      sent += 1;
    }
    startKey = result.LastEvaluatedKey;
  } while (startKey && sent < 500);
}

async function redriveUnattachedExecutions(cutoff: string): Promise<void> {
  for (const status of ['dispatching', 'running'] as const) {
    const result = await clients.dynamodb.send(new QueryCommand({
      TableName: tableName,
      IndexName: 'status-updated-index',
      KeyConditionExpression: '#status = :status AND updatedAt <= :cutoff',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':status': status, ':cutoff': cutoff },
      Limit: 100,
    }));
    for (const run of (result.Items ?? []) as RunRecord[]) {
      if (!run.execution || run.execution.id === 'pending') await nudge(run.runId);
    }
  }
}

async function nudge(runId: string): Promise<void> {
  const message: RunQueueMessage = {
    version: '1',
    runId,
    traceId: `reconcile:${runId}:${Date.now()}`,
  };
  await clients.sqs.send(new SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: JSON.stringify(message),
    MessageAttributes: {
      traceId: { DataType: 'String', StringValue: message.traceId },
    },
  }));
}

async function nudgeQueued(run: RunRecord): Promise<void> {
  const wake = recoveryWakeForQueuedRun(run);
  await clients.sqs.send(new SendMessageCommand({
    QueueUrl: wake.kind === 'thread' ? conversationQueueUrl : queueUrl,
    MessageBody: JSON.stringify(wake.message),
    MessageAttributes: {
      traceId: { DataType: 'String', StringValue: wake.message.traceId },
    },
  }));
}

async function reconcileStaleAttachedExecutions(cutoff: string): Promise<void> {
  const stale: RunRecord[] = [];
  for (const status of ['dispatching', 'running'] as const) {
    const result = await clients.dynamodb.send(new QueryCommand({
      TableName: tableName,
      IndexName: 'status-heartbeat-index',
      KeyConditionExpression: '#status = :status AND heartbeatAt <= :cutoff',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':status': status, ':cutoff': cutoff },
      Limit: 25,
    }));
    stale.push(...(result.Items ?? []) as RunRecord[]);
  }
  await inBatches(stale, 5, reconcileAttachedRun);
}

async function reconcileCancellations(cutoff: string): Promise<void> {
  const result = await clients.dynamodb.send(new QueryCommand({
    TableName: tableName,
    IndexName: 'status-updated-index',
    KeyConditionExpression: '#status = :cancelling AND updatedAt <= :cutoff',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ':cancelling': 'cancelling', ':cutoff': cutoff },
    Limit: 25,
  }));
  await inBatches((result.Items ?? []) as RunRecord[], 5, async (run) => {
    if (!run.execution || run.execution.id === 'pending') {
      await store.transition(run.runId, ['cancelling'], 'cancelled');
    } else {
      await reconcileAttachedRun(run);
    }
  });
}

async function reconcileAttachedRun(run: RunRecord): Promise<void> {
  const outcome = await activeRuns.reconcile(run);
  const metric = {
    active: 'ExecutionVerifiedActive',
    failed: 'ExecutionLost',
    cancelled: 'CancellationFinalized',
    'stop-requested': 'CancellationStopRequested',
    deferred: 'ExecutionInspectionDeferred',
    quarantined: 'ExecutionQuarantined',
    raced: 'ExecutionReconcileRace',
    legacy: 'LegacyExecutionAttachment',
  }[outcome];
  emitMetric('reconciler', metric, 1, 'Count');
  if (outcome === 'quarantined' || outcome === 'legacy') {
    console.warn(JSON.stringify({
      level: 'warn',
      message: outcome === 'quarantined'
        ? 'stale execution observation quarantined'
        : 'stale execution has no fenced liveness identity',
      runId: run.runId,
    }));
  }
}

async function inBatches<T>(
  values: T[],
  concurrency: number,
  work: (value: T) => Promise<void>,
): Promise<void> {
  for (let index = 0; index < values.length; index += concurrency) {
    await Promise.all(values.slice(index, index + concurrency).map(work));
  }
}
