import { LambdaMicrovmsClient } from '@aws-sdk/client-lambda-microvms';
import type { EventBridgeEvent, EventBridgeHandler } from 'aws-lambda';
import {
  createAwsClientConfig,
  createAwsClients,
  DynamoRunStore,
  S3ArtifactStore,
  S3ResultReader,
  SqsConversationQueue,
} from '../adapters/aws-runtime.js';
import { MicrovmSessionController, requiredEnv } from '../adapters/executors.js';
import { getConversationService } from '../app/composition.js';
import { ConversationCompletionCoordinator } from '../conversation/coordinator.js';
import type { RunStateEvent } from '../domain/contracts.js';

let coordinator: ConversationCompletionCoordinator | undefined;

export const handler: EventBridgeHandler<'Agent Run State', RunStateEvent, void> = async (
  event: EventBridgeEvent<'Agent Run State', RunStateEvent>,
) => {
  const service = coordinator ??= defaultCoordinator();
  await service.handle(event.detail);
};

function defaultCoordinator(): ConversationCompletionCoordinator {
  const clients = createAwsClients();
  return new ConversationCompletionCoordinator({
    conversations: getConversationService(),
    runs: new DynamoRunStore(clients.dynamodb, requiredEnv('RUNS_TABLE_NAME')),
    artifacts: new S3ArtifactStore(clients.s3, requiredEnv('ARTIFACT_BUCKET')),
    results: new S3ResultReader(clients.s3),
    queue: new SqsConversationQueue(clients.sqs, requiredEnv('CONVERSATION_QUEUE_URL')),
    sessions: new MicrovmSessionController(
      new LambdaMicrovmsClient(createAwsClientConfig()),
    ),
  });
}
