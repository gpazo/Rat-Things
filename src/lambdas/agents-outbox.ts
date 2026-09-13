import { agentsStreamJobs, parseAgentsJob, agentsJobGroup, agentsJobRetrySeconds } from '../core/agents-outbox-planning.js';
import { createHash } from 'node:crypto';
import type { DynamoDBStreamEvent, SQSEvent } from 'aws-lambda';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { ChangeMessageVisibilityCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { createAwsClients } from '../adapters/aws-runtime.js';
import { requiredEnv } from '../adapters/executors.js';
import { getAgentsApiServices, getSessionIntegrationService, getScheduleService } from '../app/composition.js';
import { AgentsApiError } from '../domain/agents-api-validation.js';


const queue = createAwsClients().sqs;

/** Streams wake independent FIFO groups. An absent executor cannot block the DynamoDB shard. */
export async function handler(event: DynamoDBStreamEvent | SQSEvent) {
  const batchItemFailures: Array<{ itemIdentifier: string }> = [];
  for (const record of event.Records) {
    if ('body' in record) {
      try {
        const job = parseAgentsJob(JSON.parse(record.body));
        const services = getAgentsApiServices();
        if (job.type === 'webhook_batch') await services.webhooks.fanout(job.ownerId, job.id);
        else if (job.type === 'webhook_delivery') {
          const attempt = await services.webhooks.deliver(job.ownerId, job.id);
          if (attempt.retryAfterSeconds) {
            await queue.send(new ChangeMessageVisibilityCommand({ QueueUrl: requiredEnv('AGENTS_QUEUE_URL'), ReceiptHandle: record.receiptHandle, VisibilityTimeout: Math.min(43_200, Math.max(1, Math.ceil(attempt.retryAfterSeconds))) }));
            batchItemFailures.push({ itemIdentifier: record.messageId });
          }
        }
        else if (job.type === 'delivery') await getSessionIntegrationService().deliverReady(job.ownerId, job.id);
        else if (job.type === 'schedule') await getScheduleService().synchronize(job.ownerId, job.id);
        else if (job.type === 'integration') await getSessionIntegrationService().submitPending(job.ownerId, job.id);
        else if (job.type === 'complete' || job.type === 'snapshot') await services.sessions.completeReadyTurns(job.ownerId, job.id);
        else if (job.type === 'environment') {
          const sessionId = await services.environments.sessionId(job.ownerId, job.id);
          if (sessionId) await services.sessions.dispatch(job.ownerId, sessionId);
        } else { await services.sessions.dispatch(job.ownerId, job.id); await services.sessions.completeReadyTurns(job.ownerId, job.id); }
      } catch (error) {
        const retrySeconds = error instanceof AgentsApiError ? agentsJobRetrySeconds(error) : undefined;
        if (retrySeconds !== undefined) {
          await queue.send(new ChangeMessageVisibilityCommand({ QueueUrl: requiredEnv('AGENTS_QUEUE_URL'), ReceiptHandle: record.receiptHandle, VisibilityTimeout: retrySeconds }));
        } else {
          console.warn(JSON.stringify({ message: 'Agents outbox job failed', messageId: record.messageId,
            error: error instanceof Error ? error.name : 'UnknownError',
            ...(error instanceof AgentsApiError ? { status: error.status, code: error.code } : {}),
          }));
        }
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
      continue;
    }
    if (!record.dynamodb?.NewImage) continue;
    const index = unmarshall(record.dynamodb.NewImage as Parameters<typeof unmarshall>[0]);
    try {
      for (const job of agentsStreamJobs(index)) {
      await queue.send(new SendMessageCommand({
        QueueUrl: requiredEnv('AGENTS_QUEUE_URL'), MessageBody: JSON.stringify(job),
        MessageGroupId: hash(agentsJobGroup(job)), MessageDeduplicationId: hash(`${job.type}:${record.eventID ?? `${job.id}:${index.revision ?? index.updatedAt}`}`),
      }));
      }
    } catch {
      if (record.dynamodb.SequenceNumber) batchItemFailures.push({ itemIdentifier: record.dynamodb.SequenceNumber });
      else throw new Error('Session outbox failed without a stream sequence number');
    }
  }
  return { batchItemFailures };
}

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
