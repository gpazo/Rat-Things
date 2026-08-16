import type { SQSBatchResponse, SQSEvent, SQSHandler } from 'aws-lambda';
import { createAwsClients, S3ArtifactStore } from '../adapters/aws-runtime.js';
import { requiredEnv } from '../adapters/executors.js';
import { getConversationService, getRunService } from '../app/composition.js';
import {
  ConversationCoordinator,
  parseConversationWakeMessage,
} from '../conversation/coordinator.js';
import { emitMetric, emitSqsQueueDelay } from './metrics.js';

let coordinator: ConversationCoordinator | undefined;

export const handler: SQSHandler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const failures: SQSBatchResponse['batchItemFailures'] = [];
  const service = coordinator ??= defaultCoordinator();
  for (const record of event.Records) {
    const startedAt = Date.now();
    emitSqsQueueDelay('conversation-coordinator', record, startedAt);
    try {
      await service.handle(parseConversationWakeMessage(record.body));
    } catch (error) {
      console.error(JSON.stringify({
        level: 'error',
        message: 'conversation coordination failed',
        messageId: record.messageId,
        error: error instanceof Error ? error.message : String(error),
      }));
      failures.push({ itemIdentifier: record.messageId });
    } finally {
      emitMetric(
        'conversation-coordinator',
        'ProcessingDuration',
        Date.now() - startedAt,
        'Milliseconds',
      );
    }
  }
  return { batchItemFailures: failures };
};

function defaultCoordinator(): ConversationCoordinator {
  const clients = createAwsClients();
  return new ConversationCoordinator({
    conversations: getConversationService(),
    runs: getRunService(),
    artifacts: new S3ArtifactStore(clients.s3, requiredEnv('ARTIFACT_BUCKET')),
    sliceTimeoutSeconds: Number(process.env.CONVERSATION_SLICE_TIMEOUT_SECONDS ?? 600),
  });
}
