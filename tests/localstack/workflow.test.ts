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
} from '../../src/adapters/aws-runtime.js';
import {
  ExecutorRegistry,
  type RunExecutor,
} from '../../src/adapters/executors.js';
import { createDispatcher } from '../../src/lambdas/dispatcher.js';
import { runAgentWorker } from '../../src/runner/main.js';
import type { RunRequest, RunStateEvent } from '../../src/domain/contracts.js';

const integration = process.env.LOCALSTACK_E2E === 'true' ? describe : describe.skip;

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

  it('runs a signed Teams request through durable state, events, and Teams delivery', async () => {
    const tableName = required('RUNS_TABLE_NAME');
    const artifactBucket = required('ARTIFACT_BUCKET');
    const runQueueUrl = required('RUN_QUEUE_URL');
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
    const prompt = `Return LocalStack workflow marker ${activityId}`;
    const body = JSON.stringify({
      type: 'message',
      id: activityId,
      text: `<at>Indubitably</at> ${prompt}`,
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
    const runId = acknowledgement.text?.match(/[0-9a-f]{8}-[0-9a-f-]{27}/i)?.[0];
    expect(runId).toBeTruthy();
    if (!runId) throw new Error('Teams acknowledgement did not contain a run ID');

    const queued = await store.get(runId);
    expect(queued).toMatchObject({
      runId,
      ownerId: 'teams:local-tenant:local-user',
      sourceKind: 'teams',
      status: 'queued',
    });
    if (!queued) throw new Error('queued run was not persisted');
    const storedRequest = await artifacts.getJson<RunRequest>(queued.input);
    expect(storedRequest).toMatchObject({
      version: '1',
      prompt,
      source: { kind: 'teams', activityId },
    });

    const wakeUp = await receiveRequired(clients.sqs, runQueueUrl, 10_000);
    const queueMessage = JSON.parse(wakeUp.Body ?? '{}') as {
      version?: string;
      runId?: string;
      traceId?: string;
    };
    expect(queueMessage).toEqual({ version: '1', runId, traceId: activityId });

    let launches = 0;
    const localExecutor: RunExecutor = {
      backend: 'ecs',
      start: async (record) => {
        launches += 1;
        return { backend: 'ecs', id: `localstack:${record.runId}` };
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
      execution: { backend: 'ecs', id: `localstack:${runId}` },
    });
    if (!dispatched) throw new Error('dispatcher did not persist the execution reference');

    process.env.RUN_ID = runId;
    process.env.RUN_INPUT_BUCKET = dispatched.input.bucket;
    process.env.RUN_INPUT_KEY = dispatched.input.key;
    process.env.RUN_TIMEOUT_SECONDS = '30';
    delete process.env.RUN_AGENT_UID;
    delete process.env.RUN_AGENT_GID;
    await runAgentWorker();

    const completed = await store.get(runId);
    expect(completed).toMatchObject({
      status: 'succeeded',
      execution: { backend: 'ecs', id: `localstack:${runId}` },
      result: {
        exitCode: 0,
        agentThreadId: 'mock-thread',
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    });
    if (!completed?.result) throw new Error('worker did not persist a result');

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
    expect(output).toBe(`mock-agent: ${prompt}`);
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
      source: 'indubitably.agent-runtime',
      'detail-type': 'Agent Run State',
      detail: { runId, status: 'succeeded', sourceKind: 'teams' },
    });

    const notifier = await import('../../src/lambdas/notifier.js');
    await invoke<void>(notifier.handler, terminalEvent);
    await deleteMessage(clients.sqs, terminalQueueUrl, terminalMessage);

    const deliveries = await matchingWireMockRequests(wiremockBaseUrl);
    expect(deliveries).toHaveLength(1);
    const card = JSON.parse(deliveries[0]?.body ?? '{}') as {
      attachments?: Array<{ content?: { body?: Array<{ text?: string }> } }>;
    };
    const cardText = card.attachments?.[0]?.content?.body?.map((item) => item.text).join('\n');
    expect(cardText).toContain('Agent run succeeded');
    expect(cardText).toContain(`mock-agent: ${prompt}`);
    expect(JSON.stringify(card)).toContain(runId);

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
    expect(await matchingWireMockRequests(wiremockBaseUrl)).toHaveLength(1);

    const repeatedResponse = await invoke<APIGatewayProxyStructuredResultV2>(teamsWebhook.handler, event);
    expect(repeatedResponse.statusCode).toBe(200);
    expect(repeatedResponse.body).toBe(firstResponse.body);
    expect(await receiveOptional(clients.sqs, runQueueUrl, 1_500)).toBeUndefined();

  }, 60_000);
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

async function matchingWireMockRequests(baseUrl: string): Promise<WireMockRequest[]> {
  const response = await fetch(`${baseUrl}/__admin/requests/find`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'POST', urlPath: '/teams/workflow' }),
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
