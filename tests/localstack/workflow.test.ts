import { createHash, createHmac, randomUUID } from 'node:crypto';
import {
  DescribeTableCommand,
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import {
  DescribeStreamCommand,
  DynamoDBStreamsClient,
  GetRecordsCommand,
  GetShardIteratorCommand,
  type _Record as DynamoStreamRecord,
  type Shard,
} from '@aws-sdk/client-dynamodb-streams';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
  DynamoDBStreamEvent,
  EventBridgeEvent,
  SQSEvent,
} from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import {
  createAwsClientConfig,
  createAwsClients,
  DynamoRunStore,
  S3ArtifactStore,
  S3ResultReader,
  SqsConversationQueue,
} from '../../src/adapters/aws-runtime.js';
import { DynamoConversationStore } from '../../src/adapters/dynamo-conversation-store.js';
import {
  ExecutorRegistry,
  type RunExecutor,
} from '../../src/adapters/executors.js';
import { ConversationService } from '../../src/conversation/service.js';
import { ConversationCompletionCoordinator } from '../../src/conversation/coordinator.js';
import {
  ConversationConflictError,
  ConversationLeaseError,
} from '../../src/conversation/types.js';
import { createDispatcher } from '../../src/lambdas/dispatcher.js';
import { runAgentWorker } from '../../src/runner/main.js';
import type { RunRequest, RunStateEvent } from '../../src/domain/contracts.js';

const integration = process.env.LOCALSTACK_E2E === 'true' ? describe : describe.skip;
const realTeamsCodex = process.env.LOCALSTACK_REAL_CODEX === 'true';

integration('LocalStack webhook-to-egress workflow', () => {
  it('accepts signed GitHub webhook ingress into S3, DynamoDB, and SQS', async () => {
    const clients = createAwsClients();
    const store = new DynamoRunStore(clients.dynamodb, required('RUNS_TABLE_NAME'));
    const artifacts = new S3ArtifactStore(clients.s3, required('ARTIFACT_BUCKET'));
    const deliveryId = randomUUID();
    const body = JSON.stringify({
      action: 'opened',
      number: 17,
      installation: { id: 4242 },
      repository: {
        full_name: 'local-fixtures/runtime',
        clone_url: 'https://github.com/local-fixtures/runtime.git',
      },
      pull_request: {
        title: 'Exercise GitHub ingress',
        body: 'LocalStack contract fixture',
        user: { login: 'local-user' },
        head: { sha: '0123456789abcdef0123456789abcdef01234567' },
        base: { ref: 'main' },
      },
    });
    const signature = `sha256=${createHmac('sha256', required('GITHUB_WEBHOOK_SIGNING_SECRET'))
      .update(body)
      .digest('hex')}`;
    const event = webhookEvent('/webhooks/github', body, {
      'x-github-event': 'pull_request',
      'x-github-delivery': deliveryId,
      'x-hub-signature-256': signature,
    });
    const webhook = await import('../../src/lambdas/webhook-github.js');
    const response = await invoke<APIGatewayProxyStructuredResultV2>(webhook.handler, event);
    expect(response.statusCode).toBe(202);
    const runId = acceptedRunId(response);
    const run = await store.get(runId);
    expect(run).toMatchObject({
      ownerId: 'github:4242',
      status: 'queued',
      sourceKind: 'github',
    });
    if (!run) throw new Error('GitHub run was not persisted');
    expect(await artifacts.getJson<RunRequest>(run.input)).toMatchObject({
      repository: {
        provider: 'github',
        url: 'https://github.com/local-fixtures/runtime.git',
      },
      source: {
        kind: 'github',
        deliveryId,
        repository: 'local-fixtures/runtime',
        issueNumber: 17,
      },
    });
    const message = await receiveRequired(
      clients.sqs,
      required('RUN_QUEUE_URL'),
      10_000,
      (item) => queuedRunId(item) === runId,
    );
    expect(JSON.parse(message.Body ?? '{}')).toEqual({ version: '1', runId, traceId: deliveryId });
    await deleteMessage(clients.sqs, required('RUN_QUEUE_URL'), message);
  }, 30_000);

  it('accepts signed GitLab webhook ingress into S3, DynamoDB, and SQS', async () => {
    const clients = createAwsClients();
    const store = new DynamoRunStore(clients.dynamodb, required('RUNS_TABLE_NAME'));
    const artifacts = new S3ArtifactStore(clients.s3, required('ARTIFACT_BUCKET'));
    const webhookId = randomUUID();
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const body = JSON.stringify({
      object_kind: 'merge_request',
      project: {
        id: 314,
        path_with_namespace: 'local-fixtures/runtime',
        git_http_url: 'https://gitlab.com/local-fixtures/runtime.git',
      },
      object_attributes: {
        action: 'open',
        iid: 23,
        title: 'Exercise GitLab ingress',
        description: 'LocalStack contract fixture',
        target_branch: 'main',
        last_commit: { id: 'fedcba9876543210fedcba9876543210fedcba98' },
      },
    });
    const signingToken = required('GITLAB_WEBHOOK_SIGNING_TOKEN');
    const signature = createHmac(
      'sha256',
      Buffer.from(signingToken.slice('whsec_'.length), 'base64'),
    )
      .update(`${webhookId}.${timestamp}.${body}`)
      .digest('base64');
    const event = webhookEvent('/webhooks/gitlab', body, {
      'webhook-id': webhookId,
      'webhook-timestamp': timestamp,
      'webhook-signature': `v1,${signature}`,
      'x-gitlab-event': 'Merge Request Hook',
    });
    const webhook = await import('../../src/lambdas/webhook-gitlab.js');
    const response = await invoke<APIGatewayProxyStructuredResultV2>(webhook.handler, event);
    expect(response.statusCode).toBe(202);
    const runId = acceptedRunId(response);
    const run = await store.get(runId);
    expect(run).toMatchObject({ ownerId: 'gitlab:314', status: 'queued', sourceKind: 'gitlab' });
    if (!run) throw new Error('GitLab run was not persisted');
    expect(await artifacts.getJson<RunRequest>(run.input)).toMatchObject({
      repository: {
        provider: 'gitlab',
        url: 'https://gitlab.com/local-fixtures/runtime.git',
      },
      source: { kind: 'gitlab', projectId: '314', mergeRequestIid: 23 },
    });
    const message = await receiveRequired(
      clients.sqs,
      required('RUN_QUEUE_URL'),
      10_000,
      (item) => queuedRunId(item) === runId,
    );
    expect(JSON.parse(message.Body ?? '{}')).toEqual({ version: '1', runId, traceId: webhookId });
    await deleteMessage(clients.sqs, required('RUN_QUEUE_URL'), message);
  }, 30_000);

  it('persists an interruptible and resumable conversation mailbox in DynamoDB and S3', async () => {
    const clients = createAwsClients();
    const artifacts = new S3ArtifactStore(clients.s3, required('ARTIFACT_BUCKET'));
    const store = new DynamoConversationStore(
      clients.dynamodb,
      required('CONVERSATIONS_TABLE_NAME'),
    );
    let clockMilliseconds = Date.parse('2026-08-03T12:00:00.000Z');
    const service = new ConversationService({
      store,
      artifacts,
      clock: { now: () => new Date(clockMilliseconds += 1_000) },
      ids: { random: () => randomUUID() },
      leaseSeconds: 600,
      retentionSeconds: 3_600,
    });
    const conversationId = `local-conversation-${randomUUID()}`;
    const ownerId = 'teams:local-tenant:local-user';
    const actor = {
      kind: 'human' as const,
      id: ownerId,
      provider: 'teams' as const,
    };
    const credentialSubject = { kind: 'runtime' as const, id: 'runtime:teams' };
    const source = (activityId: string) => ({
      kind: 'teams' as const,
      tenantId: 'local-tenant',
      teamId: 'local-team',
      channelId: 'local-channel',
      conversationId,
      activityId,
      senderId: 'local-user',
    });
    const destination = { kind: 'source' as const };

    const deferred = await service.appendMessage({
      conversationId,
      ownerId,
      messageId: 'message-deferred',
      delivery: 'defer',
      content: { text: 'Summarize the deployment when the current action is done.' },
      source: source('message-deferred'),
      destination,
      actor,
      credentialSubject,
    });
    expect(deferred.status).toBe('appended');
    await service.appendMessage({
      conversationId,
      ownerId,
      messageId: 'message-interrupt',
      delivery: 'interrupt',
      content: { text: 'Stop and inspect the failing health check now.' },
      source: source('message-interrupt'),
      destination,
      actor,
      credentialSubject,
    });

    const acquired = await service.acquireLease(conversationId);
    expect(acquired.status).toBe('acquired');
    if (acquired.status !== 'acquired') throw new Error('conversation lease was not acquired');
    const firstLease = acquired.lease.token;
    const checkedIn = await service.checkIn(conversationId, firstLease);
    expect(checkedIn.lease).toMatchObject({ token: firstLease });
    expect(checkedIn.lease?.checkedInAt).not.toBe(acquired.lease.checkedInAt);
    const contended = await service.acquireLease(conversationId);
    expect(contended).toMatchObject({
      status: 'active',
      conversation: { lease: { token: firstLease } },
    });
    const pending = await waitForPendingMessages(service, conversationId, firstLease, 2);
    expect(pending.map(({ messageId, delivery }) => ({ messageId, delivery }))).toEqual([
      { messageId: 'message-interrupt', delivery: 'interrupt' },
      { messageId: 'message-deferred', delivery: 'defer' },
    ]);
    await expect(service.pending(conversationId, firstLease, { delivery: 'interrupt' }))
      .resolves.toEqual([expect.objectContaining({ messageId: 'message-interrupt' })]);

    const started = await service.beginTurn({
      conversationId,
      leaseToken: firstLease,
      runId: `run-${randomUUID()}`,
    });
    await service.reportProgress({
      conversationId,
      turnId: started.turnId,
      leaseToken: firstLease,
      text: 'Inspecting the health-check logs',
    });
    await service.consumeMessages({
      conversationId,
      messageIds: ['message-interrupt'],
      leaseToken: firstLease,
    });
    const checkpointed = await service.checkpointTurn({
      conversationId,
      turnId: started.turnId,
      leaseToken: firstLease,
      reason: 'yield',
      checkpoint: {
        version: '1',
        messages: [
          { role: 'user', content: 'Stop and inspect the failing health check now.' },
          { role: 'assistant', content: 'The target is unhealthy; investigation can resume.' },
        ],
        metadata: { nextAction: 'summarize-deployment' },
      },
    });
    expect(checkpointed).toMatchObject({ state: 'awaiting_resume', resumeReason: 'yield' });
    await expect(service.pending(conversationId, firstLease))
      .rejects.toBeInstanceOf(ConversationLeaseError);

    const reacquired = await service.acquireLease(conversationId);
    expect(reacquired.status).toBe('acquired');
    if (reacquired.status !== 'acquired') throw new Error('checkpointed turn was not reacquired');
    const secondLease = reacquired.lease.token;
    expect(secondLease).not.toBe(firstLease);
    const resumed = await service.resumeTurn({
      conversationId,
      turnId: started.turnId,
      leaseToken: secondLease,
    });
    expect(resumed).toMatchObject({ state: 'running', slice: 1, resumedFromSlice: 0 });
    const afterResume = await waitForPendingMessages(service, conversationId, secondLease, 1);
    expect(afterResume.map(({ messageId }) => messageId)).toEqual(['message-deferred']);
    await service.consumeMessages({
      conversationId,
      messageIds: ['message-deferred'],
      leaseToken: secondLease,
    });
    const result = await artifacts.putJson(
      `owners/localstack/results/${started.turnId}.json`,
      { answer: 'Health check investigated and deployment summarized.' },
    );
    const completed = await service.completeTurn({
      conversationId,
      turnId: started.turnId,
      leaseToken: secondLease,
      result,
    });
    expect(completed).toMatchObject({ state: 'completed', slice: 1, result });

    const conversation = await service.get(conversationId);
    expect(conversation).toMatchObject({ status: 'idle', pendingCount: 0 });
    expect(conversation).not.toHaveProperty('lease');
    expect(conversation).not.toHaveProperty('activeTurnId');
    expect(conversation).not.toHaveProperty('latestProgress');
    const persistedTurn = await service.getTurn(conversationId, started.turnId);
    expect(persistedTurn).toMatchObject({
      state: 'completed',
      slice: 1,
      resumedFromSlice: 0,
      checkpoint: checkpointed.checkpoint,
      result,
    });
    if (!persistedTurn?.checkpoint) throw new Error('checkpoint reference was not persisted');
    await expect(artifacts.getJson(persistedTurn.checkpoint)).resolves.toMatchObject({
      version: '1',
      metadata: { nextAction: 'summarize-deployment' },
    });

    const eventTypes = (await service.history(conversationId)).map(({ type }) => type);
    expect(eventTypes).toHaveLength(9);
    expect(eventTypes).toEqual(expect.arrayContaining([
      'message_received',
      'turn_started',
      'progress_reported',
      'messages_consumed',
      'turn_checkpointed',
      'turn_resumed',
      'turn_completed',
    ]));
    expect(eventTypes.filter((type) => type === 'message_received')).toHaveLength(2);
    expect(eventTypes.filter((type) => type === 'messages_consumed')).toHaveLength(2);

    const duplicate = await service.appendMessage({
      conversationId,
      ownerId,
      messageId: 'message-deferred',
      delivery: 'defer',
      content: { text: 'Summarize the deployment when the current action is done.' },
      source: source('message-deferred'),
      destination,
      actor,
      credentialSubject,
    });
    expect(duplicate.status).toBe('duplicate');
    await expect(service.appendMessage({
      conversationId,
      ownerId,
      messageId: 'message-deferred',
      delivery: 'defer',
      content: { text: 'This is conflicting webhook content.' },
      source: source('message-deferred'),
      destination,
      actor,
      credentialSubject,
    })).rejects.toBeInstanceOf(ConversationConflictError);
  }, 60_000);

  it('runs a signed Teams request through durable state, events, and Teams delivery', async () => {
    const tableName = required('RUNS_TABLE_NAME');
    const artifactBucket = required('ARTIFACT_BUCKET');
    const runQueueUrl = required('RUN_QUEUE_URL');
    const conversationQueueUrl = required('CONVERSATION_QUEUE_URL');
    const terminalQueueUrl = required('TERMINAL_EVENTS_QUEUE_URL');
    const wiremockBaseUrl = required('WIREMOCK_BASE_URL');
    const signingSecret = required('TEAMS_SIGNING_SECRET');
    const clients = createAwsClients();
    const store = new DynamoRunStore(clients.dynamodb, tableName);
    const artifacts = new S3ArtifactStore(clients.s3, artifactBucket);
    const rawDynamo = new DynamoDBClient(createAwsClientConfig());
    const streams = new DynamoDBStreamsClient(createAwsClientConfig());

    await resetWireMock(wiremockBaseUrl);

    const activityId = `local-e2e-${randomUUID()}`;
    const marker = `RAT_THINGS_TEAMS_${activityId}`;
    const prompt = realTeamsCodex
      ? `Reply in one concise sentence confirming you received this Teams message. Include the exact marker ${marker}.`
      : `Return LocalStack workflow marker ${activityId}`;
    const body = JSON.stringify({
      type: 'message',
      id: activityId,
      text: `<at>Rat Things</at> ${prompt}`,
      from: { id: 'local-user', name: 'Local User' },
      conversation: { id: 'local-conversation' },
      channelData: {
        tenant: { id: 'local-tenant' },
        team: { id: 'local-team' },
        channel: { id: 'local-channel' },
      },
    });
    const event = teamsEvent(body, teamsSignature(body, signingSecret));
    const teamsWebhook = await import('../../src/lambdas/webhook-teams.js');
    const firstResponse = await invoke<APIGatewayProxyStructuredResultV2>(teamsWebhook.handler, event);

    expect(firstResponse.statusCode).toBe(200);
    const acknowledgement = JSON.parse(firstResponse.body ?? '{}') as { text?: string };
    expect(acknowledgement.text).toBe(
      `Rat Things response received (${activityId.slice(0, 12)}). I'll reply in this thread when it finishes.`,
    );

    const conversationId = 'teams:local-tenant:local-user:local-conversation';
    const conversationStore = new DynamoConversationStore(
      clients.dynamodb,
      required('CONVERSATIONS_TABLE_NAME'),
    );
    await expect(conversationStore.getConversation(conversationId)).resolves.toMatchObject({
      status: 'pending',
      pendingCount: 1,
    });
    const conversationWake = await receiveRequired(clients.sqs, conversationQueueUrl, 10_000);
    expect(JSON.parse(conversationWake.Body ?? '{}')).toEqual({
      version: '1',
      conversationId,
      traceId: activityId,
    });
    const conversationCoordinator = await import('../../src/lambdas/conversation-coordinator.js');
    const coordination = await invoke<{ batchItemFailures: { itemIdentifier: string }[] }>(
      conversationCoordinator.handler,
      sqsEvent(conversationWake, conversationQueueUrl),
    );
    expect(coordination.batchItemFailures).toEqual([]);
    await deleteMessage(clients.sqs, conversationQueueUrl, conversationWake);

    const wakeUp = await receiveRequired(clients.sqs, runQueueUrl, 10_000);
    const queueMessage = JSON.parse(wakeUp.Body ?? '{}') as {
      version?: string;
      runId?: string;
      traceId?: string;
    };
    const runId = queueMessage.runId;
    expect(runId).toBeTruthy();
    if (!runId) throw new Error('conversation coordinator did not create a run');
    expect(queueMessage).toEqual({ version: '1', runId, traceId: activityId });

    const queued = await store.get(runId);
    expect(queued).toMatchObject({
      runId,
      ownerId: 'teams:local-tenant:local-user',
      sourceKind: 'teams',
      status: 'queued',
      conversation: {
        conversationId,
      },
    });
    if (!queued) throw new Error('queued run was not persisted');
    const storedRequest = await artifacts.getJson<RunRequest>(queued.input);
    expect(storedRequest).toMatchObject({
      version: '1',
      prompt: expect.stringContaining(prompt),
      source: { kind: 'teams', activityId },
    });

    let launches = 0;
    const localExecutor: RunExecutor = {
      backend: 'microvm',
      start: async (record) => {
        launches += 1;
        return { backend: 'microvm', id: `localstack:${record.runId}` };
      },
      stop: async () => undefined,
    };
    const dispatch = createDispatcher({
      store,
      artifacts,
      executors: new ExecutorRegistry([localExecutor]),
    });
    const dispatchResponse = await invoke<{ batchItemFailures: { itemIdentifier: string }[] }>(
      dispatch,
      sqsEvent(wakeUp, runQueueUrl),
    );
    expect(dispatchResponse.batchItemFailures).toEqual([]);
    expect(launches).toBe(1);
    await deleteMessage(clients.sqs, runQueueUrl, wakeUp);

    const dispatched = await store.get(runId);
    expect(dispatched).toMatchObject({
      status: 'dispatching',
      execution: { backend: 'microvm', id: `localstack:${runId}` },
    });
    if (!dispatched) throw new Error('dispatcher did not persist the execution reference');

    process.env.RUN_ID = runId;
    process.env.RUN_INPUT_BUCKET = dispatched.input.bucket;
    process.env.RUN_INPUT_KEY = dispatched.input.key;
    process.env.RUN_TIMEOUT_SECONDS = realTeamsCodex ? '180' : '30';
    process.env.PERSISTENT_SESSION = 'true';
    delete process.env.AGENT_THREAD_ID;
    delete process.env.RUN_AGENT_UID;
    delete process.env.RUN_AGENT_GID;
    await runAgentWorker();

    const completed = await store.get(runId);
    expect(completed).toMatchObject({
      status: 'succeeded',
      execution: { backend: 'microvm', id: `localstack:${runId}` },
      result: {
        exitCode: 0,
      },
    });
    if (!completed?.result) throw new Error('worker did not persist a result');
    if (realTeamsCodex) {
      expect(completed.result.agentThreadId).toBeTruthy();
      expect(completed.result.usage?.inputTokens).toBeGreaterThan(0);
      expect(completed.result.usage?.outputTokens).toBeGreaterThan(0);
    } else {
      expect(completed.result).toMatchObject({
        agentThreadId: 'mock-thread',
        usage: { inputTokens: 1, outputTokens: 1 },
      });
    }

    const output = await objectText(
      clients.s3,
      completed.result.output.bucket,
      completed.result.output.key,
    );
    const agentEvents = await objectText(
      clients.s3,
      completed.result.events?.bucket ?? '',
      completed.result.events?.key ?? '',
    );
    if (realTeamsCodex) expect(output).toContain(marker);
    else {
      expect(output).toContain('mock-agent: Continue this durable conversation.');
      expect(output).toContain(prompt);
    }
    expect(agentEvents).toContain('item.completed');
    expect(completed.result.preview).toBe(output);

    const streamArn = await latestStreamArn(rawDynamo, tableName);
    const records = await streamRecordsForRun(streams, streamArn, runId, 20_000);
    expect(records.map(streamStatus)).toEqual(
      expect.arrayContaining(['queued', 'dispatching', 'running', 'succeeded']),
    );
    const stateStream = await import('../../src/lambdas/state-stream.js');
    await invoke<void>(stateStream.handler, {
      Records: records,
    } as unknown as DynamoDBStreamEvent);

    const terminalMessage = await receiveRequired(
      clients.sqs,
      terminalQueueUrl,
      15_000,
      (message) => eventRunId(message) === runId,
    );
    const terminalEvent = JSON.parse(terminalMessage.Body ?? '{}') as EventBridgeEvent<
      'Agent Run State',
      RunStateEvent
    >;
    expect(terminalEvent).toMatchObject({
      source: 'rat-things.agent-runtime',
      'detail-type': 'Agent Run State',
      detail: { runId, status: 'succeeded', sourceKind: 'teams' },
    });

    const notifier = await import('../../src/lambdas/notifier.js');
    const conversationService = new ConversationService({
      store: conversationStore,
      artifacts,
    });
    const completion = new ConversationCompletionCoordinator({
      conversations: conversationService,
      runs: store,
      artifacts,
      results: new S3ResultReader(clients.s3),
      queue: new SqsConversationQueue(clients.sqs, conversationQueueUrl),
      sessions: { suspend: async () => undefined },
    });
    await completion.handle(terminalEvent.detail);
    await invoke<void>(notifier.handler, terminalEvent);
    await deleteMessage(clients.sqs, terminalQueueUrl, terminalMessage);

    const deliveryPath = realTeamsCodex ? '/teams/threaded-reply' : '/teams/workflow';
    const deliveries = await matchingWireMockRequests(wiremockBaseUrl, deliveryPath);
    expect(deliveries).toHaveLength(1);
    const delivery = JSON.parse(deliveries[0]?.body ?? '{}') as Record<string, unknown>;
    if (realTeamsCodex) {
      expect(delivery).toMatchObject({
        version: '1',
        operation: 'reply-to-activity',
        conversationId: 'local-conversation',
        replyToActivityId: activityId,
        activity: {
          type: 'message',
          conversation: { id: 'local-conversation' },
          replyToId: activityId,
          text: expect.stringContaining(marker),
        },
        run: { id: runId, status: 'succeeded' },
      });
    } else {
      const card = delivery as {
        attachments?: Array<{ content?: { body?: Array<{ text?: string }> } }>;
      };
      const cardText = card.attachments?.[0]?.content?.body?.map((item) => item.text).join('\n');
      expect(cardText).toContain('Agent run succeeded');
      expect(cardText).toContain('mock-agent: Continue this durable conversation.');
      expect(cardText).toContain(prompt);
      expect(JSON.stringify(card)).toContain(runId);
    }

    const destination = 'teams:default';
    const deliveryDigest = createHash('sha256').update(destination).digest('hex').slice(0, 24);
    const fence = await clients.dynamodb.send(new GetCommand({
      TableName: tableName,
      Key: { runId: `delivery#${runId}#${deliveryDigest}` },
      ConsistentRead: true,
    }));
    expect(fence.Item).toMatchObject({
      parentRunId: runId,
      destination,
      status: 'delivered',
      details: { receipt: 'localstack-wiremock-receipt' },
    });

    await invoke<void>(notifier.handler, terminalEvent);
    expect(await matchingWireMockRequests(wiremockBaseUrl, deliveryPath)).toHaveLength(1);

    const repeatedResponse = await invoke<APIGatewayProxyStructuredResultV2>(teamsWebhook.handler, event);
    expect(repeatedResponse.statusCode).toBe(200);
    expect(repeatedResponse.body).toBe(firstResponse.body);
    const duplicateWake = await receiveRequired(clients.sqs, conversationQueueUrl, 10_000);
    const duplicateCoordination = await invoke<{ batchItemFailures: { itemIdentifier: string }[] }>(
      conversationCoordinator.handler,
      sqsEvent(duplicateWake, conversationQueueUrl),
    );
    expect(duplicateCoordination.batchItemFailures).toEqual([]);
    await deleteMessage(clients.sqs, conversationQueueUrl, duplicateWake);
    expect(await receiveOptional(clients.sqs, runQueueUrl, 1_500)).toBeUndefined();

    const followUpActivityId = `local-follow-up-${randomUUID()}`;
    const followUpPrompt = 'Now summarize that answer in five words.';
    const followUpBody = JSON.stringify({
      type: 'message',
      id: followUpActivityId,
      text: `<at>Rat Things</at> ${followUpPrompt}`,
      from: { id: 'local-user', name: 'Local User' },
      conversation: { id: 'local-conversation' },
      channelData: {
        tenant: { id: 'local-tenant' },
        team: { id: 'local-team' },
        channel: { id: 'local-channel' },
      },
    });
    const followUpResponse = await invoke<APIGatewayProxyStructuredResultV2>(
      teamsWebhook.handler,
      teamsEvent(followUpBody, teamsSignature(followUpBody, signingSecret)),
    );
    expect(followUpResponse.statusCode).toBe(200);
    const followUpWake = await receiveRequired(clients.sqs, conversationQueueUrl, 10_000);
    const followUpCoordination = await invoke<{ batchItemFailures: { itemIdentifier: string }[] }>(
      conversationCoordinator.handler,
      sqsEvent(followUpWake, conversationQueueUrl),
    );
    expect(followUpCoordination.batchItemFailures).toEqual([]);
    await deleteMessage(clients.sqs, conversationQueueUrl, followUpWake);
    const followUpRunWake = await receiveRequired(clients.sqs, runQueueUrl, 10_000);
    const followUpRunId = queuedRunId(followUpRunWake);
    expect(followUpRunId).toBeTruthy();
    if (!followUpRunId) throw new Error('follow-up did not create a conversation run');
    await expect(store.get(followUpRunId)).resolves.toMatchObject({
      conversation: {
        conversationId,
        preferredMicrovmId: `localstack:${runId}`,
        agentThreadId: 'mock-thread',
      },
    });
    const followUpRun = await store.get(followUpRunId);
    if (!followUpRun) throw new Error('follow-up run was not persisted');
    const followUpRequest = await artifacts.getJson<RunRequest>(followUpRun.input);
    expect(followUpRequest.prompt).toContain(prompt);
    expect(followUpRequest.prompt).toContain(`mock-agent: Continue this durable conversation.`);
    expect(followUpRequest.prompt).toContain(followUpPrompt);
    await deleteMessage(clients.sqs, runQueueUrl, followUpRunWake);

    if (realTeamsCodex) {
      process.stdout.write(`\n${JSON.stringify({
        simulatedTeamsMention: JSON.parse(body) as unknown,
        acknowledgement: JSON.parse(firstResponse.body ?? '{}') as unknown,
        runId,
        agentThreadId: completed.result.agentThreadId,
        durationMs: completed.result.durationMs,
        usage: completed.result.usage,
        codexOutput: output,
        threadedReply: delivery,
      }, null, 2)}\n`);
    }

  }, realTeamsCodex ? 240_000 : 60_000);
});

async function invoke<T>(handler: unknown, event: unknown): Promise<T> {
  return await (handler as (value: unknown) => Promise<T>)(event);
}

function teamsSignature(body: string, base64Secret: string): string {
  return `HMAC ${createHmac('sha256', Buffer.from(base64Secret, 'base64'))
    .update(body, 'utf8')
    .digest('base64')}`;
}

function teamsEvent(body: string, authorization: string): APIGatewayProxyEventV2 {
  return webhookEvent('/webhooks/teams', body, { authorization });
}

function webhookEvent(
  path: string,
  body: string,
  headers: Record<string, string>,
): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: `POST ${path}`,
    rawPath: path,
    rawQueryString: '',
    headers: { ...headers, 'content-type': 'application/json' },
    requestContext: {
      accountId: '000000000000',
      apiId: 'localstack',
      domainName: 'localhost',
      domainPrefix: 'localhost',
      http: {
        method: 'POST',
        path,
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'localstack-e2e',
      },
      requestId: randomUUID(),
      routeKey: `POST ${path}`,
      stage: '$default',
      time: new Date().toISOString(),
      timeEpoch: Date.now(),
    },
    body,
    isBase64Encoded: false,
  };
}

function acceptedRunId(response: APIGatewayProxyStructuredResultV2): string {
  const body = JSON.parse(response.body ?? '{}') as { accepted?: unknown; runId?: unknown };
  if (body.accepted !== true || typeof body.runId !== 'string') {
    throw new Error(`webhook was not accepted: ${response.body ?? '<empty>'}`);
  }
  return body.runId;
}

function sqsEvent(message: Message, queueUrl: string): SQSEvent {
  const queueName = queueUrl.split('/').at(-1) ?? 'runs';
  return {
    Records: [
      {
        messageId: message.MessageId ?? randomUUID(),
        receiptHandle: message.ReceiptHandle ?? '',
        body: message.Body ?? '',
        attributes: {
          ApproximateReceiveCount: '1',
          SentTimestamp: String(Date.now()),
          SenderId: '000000000000',
          ApproximateFirstReceiveTimestamp: String(Date.now()),
        },
        messageAttributes: {},
        md5OfBody: message.MD5OfBody ?? '',
        eventSource: 'aws:sqs',
        eventSourceARN: `arn:aws:sqs:${required('AWS_REGION')}:000000000000:${queueName}`,
        awsRegion: required('AWS_REGION'),
      },
    ],
  };
}

async function receiveRequired(
  sqs: SQSClient,
  queueUrl: string,
  timeoutMs: number,
  predicate: (message: Message) => boolean = () => true,
): Promise<Message> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const received = await sqs.send(new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 1,
      MessageAttributeNames: ['All'],
      AttributeNames: ['All'],
    }));
    for (const message of received.Messages ?? []) {
      if (predicate(message)) return message;
      await deleteMessage(sqs, queueUrl, message);
    }
  }
  throw new Error(`no matching SQS message arrived on ${queueUrl}`);
}

async function receiveOptional(
  sqs: SQSClient,
  queueUrl: string,
  timeoutMs: number,
): Promise<Message | undefined> {
  try {
    return await receiveRequired(sqs, queueUrl, timeoutMs);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('no matching SQS message')) return undefined;
    throw error;
  }
}

async function deleteMessage(sqs: SQSClient, queueUrl: string, message: Message): Promise<void> {
  if (!message.ReceiptHandle) throw new Error('SQS message has no receipt handle');
  await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
}

async function objectText(
  s3: ReturnType<typeof createAwsClients>['s3'],
  bucket: string,
  key: string,
): Promise<string> {
  if (!bucket || !key) throw new Error('artifact reference is incomplete');
  const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!object.Body) throw new Error(`s3://${bucket}/${key} is empty`);
  return object.Body.transformToString('utf8');
}

async function latestStreamArn(client: DynamoDBClient, tableName: string): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const table = await client.send(new DescribeTableCommand({ TableName: tableName }));
    if (table.Table?.LatestStreamArn) return table.Table.LatestStreamArn;
    await delay(100);
  }
  throw new Error(`DynamoDB stream for ${tableName} did not become available`);
}

interface StreamCursor {
  iterator: string;
  closed: boolean;
}

async function streamRecordsForRun(
  client: DynamoDBStreamsClient,
  streamArn: string,
  runId: string,
  timeoutMs: number,
): Promise<DynamoStreamRecord[]> {
  const setupDeadline = Date.now() + Math.min(timeoutMs, 10_000);
  let shards: Shard[] = [];
  while (Date.now() < setupDeadline) {
    shards = await streamShards(client, streamArn);
    if (shards.length > 0) break;
    await delay(100);
  }
  if (shards.length === 0) throw new Error(`DynamoDB stream ${streamArn} has no shards`);
  const cursors: StreamCursor[] = [];
  for (const shard of shards) {
    if (!shard.ShardId) continue;
    const result = await client.send(new GetShardIteratorCommand({
      StreamArn: streamArn,
      ShardId: shard.ShardId,
      ShardIteratorType: 'TRIM_HORIZON',
    }));
    if (result.ShardIterator) cursors.push({ iterator: result.ShardIterator, closed: false });
  }
  if (cursors.length === 0) throw new Error(`DynamoDB stream ${streamArn} returned no iterators`);

  const records: DynamoStreamRecord[] = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const cursor of cursors.filter((item) => !item.closed)) {
      const result = await client.send(new GetRecordsCommand({ ShardIterator: cursor.iterator }));
      if (result.NextShardIterator) cursor.iterator = result.NextShardIterator;
      else cursor.closed = true;
      records.push(
        ...(result.Records ?? []).filter(
          (record) => record.dynamodb?.Keys?.runId?.S === runId,
        ),
      );
    }
    if (records.some((record) => streamStatus(record) === 'succeeded')) return records;
    await delay(100);
  }
  throw new Error(
    `DynamoDB stream did not expose succeeded run ${runId}; saw ${records.map(streamStatus).join(', ')}`,
  );
}

async function streamShards(client: DynamoDBStreamsClient, streamArn: string): Promise<Shard[]> {
  const shards: Shard[] = [];
  const seenPages = new Set<string>();
  let exclusiveStartShardId: string | undefined;
  do {
    const described = await client.send(new DescribeStreamCommand({
      StreamArn: streamArn,
      ...(exclusiveStartShardId ? { ExclusiveStartShardId: exclusiveStartShardId } : {}),
    }));
    shards.push(...(described.StreamDescription?.Shards ?? []));
    const next = described.StreamDescription?.LastEvaluatedShardId;
    if (!next || seenPages.has(next)) break;
    seenPages.add(next);
    exclusiveStartShardId = next;
  } while (exclusiveStartShardId);
  return shards;
}

function streamStatus(record: DynamoStreamRecord): string | undefined {
  return record.dynamodb?.NewImage?.status?.S;
}

function eventRunId(message: Message): string | undefined {
  try {
    const value = JSON.parse(message.Body ?? '{}') as { detail?: { runId?: unknown } };
    return typeof value.detail?.runId === 'string' ? value.detail.runId : undefined;
  } catch {
    return undefined;
  }
}

function queuedRunId(message: Message): string | undefined {
  try {
    const value = JSON.parse(message.Body ?? '{}') as { runId?: unknown };
    return typeof value.runId === 'string' ? value.runId : undefined;
  } catch {
    return undefined;
  }
}

interface WireMockRequest {
  body?: string;
}

async function resetWireMock(baseUrl: string): Promise<void> {
  const response = await fetch(`${baseUrl}/__admin/requests`, { method: 'DELETE' });
  if (!response.ok) throw new Error(`WireMock reset failed with HTTP ${response.status}`);
}

async function matchingWireMockRequests(
  baseUrl: string,
  urlPath = '/teams/workflow',
): Promise<WireMockRequest[]> {
  const response = await fetch(`${baseUrl}/__admin/requests/find`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'POST', urlPath }),
  });
  if (!response.ok) throw new Error(`WireMock request search failed with HTTP ${response.status}`);
  const result = await response.json() as { requests?: WireMockRequest[] };
  return result.requests ?? [];
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the LocalStack E2E test`);
  return value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function waitForPendingMessages(
  service: ConversationService,
  conversationId: string,
  leaseToken: string,
  count: number,
) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const pending = await service.pending(conversationId, leaseToken);
    if (pending.length === count) return pending;
    await delay(100);
  }
  throw new Error(`conversation ${conversationId} did not expose ${count} pending messages`);
}
