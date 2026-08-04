import { createHash } from 'node:crypto';
import {
  ConditionalCheckFailedException,
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type {
  ArtifactReference,
  ExecutionReference,
  ListRunsResult,
  RunError,
  RunQueueMessage,
  RunRecord,
  RunResult,
  RunStateEvent,
  RunStatus,
} from '../domain/contracts.js';
import type { ConversationWakeMessage } from '../domain/conversations.js';
import { InvalidStateTransitionError } from '../domain/state.js';
import type {
  ArtifactStore,
  CreateRunResult,
  RunQueue,
  RunStore,
} from '../core/ports.js';
import type { ConversationQueue } from '../conversation/types.js';
import type { SecretReader } from '../credentials/types.js';
import type { ResultReader } from '../delivery/types.js';

export interface AwsClients {
  dynamodb: DynamoDBDocumentClient;
  s3: S3Client;
  sqs: SQSClient;
  events: EventBridgeClient;
  secrets: SecretsManagerClient;
}

export interface AwsClientConfig {
  region?: string;
  endpoint?: string;
}

export function createAwsClientConfig(region = process.env.AWS_REGION): AwsClientConfig {
  const endpoint = process.env.AWS_ENDPOINT_URL?.trim();
  return {
    ...(region ? { region } : {}),
    ...(endpoint ? { endpoint } : {}),
  };
}

export function createAwsClients(region = process.env.AWS_REGION): AwsClients {
  const config = createAwsClientConfig(region);
  return {
    dynamodb: DynamoDBDocumentClient.from(new DynamoDBClient(config), {
      marshallOptions: { removeUndefinedValues: true },
    }),
    s3: new S3Client({
      ...config,
      forcePathStyle:
        process.env.AWS_S3_FORCE_PATH_STYLE === 'true' || Boolean(config.endpoint),
    }),
    sqs: new SQSClient(config),
    events: new EventBridgeClient(config),
    secrets: new SecretsManagerClient(config),
  };
}

export class DynamoRunStore implements RunStore {
  public constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  public async create(record: RunRecord): Promise<CreateRunResult> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: record,
          ConditionExpression: 'attribute_not_exists(runId)',
        }),
      );
      return { created: true, record };
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
      const existing = await this.get(record.runId);
      if (!existing) throw error;
      return { created: false, record: existing };
    }
  }

  public async get(runId: string): Promise<RunRecord | undefined> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { runId },
        ConsistentRead: true,
      }),
    );
    return result.Item as RunRecord | undefined;
  }

  public async list(ownerId: string, limit: number, nextToken?: string): Promise<ListRunsResult> {
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: 'owner-created-index',
        KeyConditionExpression: 'ownerId = :ownerId',
        ExpressionAttributeValues: { ':ownerId': ownerId },
        ScanIndexForward: false,
        Limit: limit,
        ...(nextToken ? { ExclusiveStartKey: decodeToken(nextToken) } : {}),
      }),
    );
    const response: ListRunsResult = { items: (result.Items ?? []) as RunRecord[] };
    if (result.LastEvaluatedKey) response.nextToken = encodeToken(result.LastEvaluatedKey);
    return response;
  }

  public transition(
    runId: string,
    from: RunStatus[],
    to: RunStatus,
    patch: Partial<RunRecord> = {},
  ): Promise<RunRecord> {
    return this.update(runId, { ...patch, status: to }, from);
  }

  public attachExecution(runId: string, execution: ExecutionReference): Promise<RunRecord> {
    return this.update(runId, { execution }, ['dispatching', 'running']);
  }

  public complete(runId: string, result: RunResult): Promise<RunRecord> {
    return this.update(runId, { status: 'succeeded', result }, ['running']);
  }

  public fail(
    runId: string,
    error: RunError,
    from: RunStatus[] = ['queued', 'dispatching', 'running', 'cancelling'],
  ): Promise<RunRecord> {
    return this.update(runId, { status: 'failed', error }, from);
  }

  private async update(
    runId: string,
    values: Partial<RunRecord>,
    expectedStatuses: RunStatus[],
  ): Promise<RunRecord> {
    const entries = Object.entries({ ...values, updatedAt: new Date().toISOString() }).filter(
      ([key, value]) => key !== 'runId' && value !== undefined,
    );
    const names: Record<string, string> = { '#status': 'status' };
    const expressionValues: Record<string, unknown> = {};
    const assignments = entries.map(([key, value], index) => {
      const name = `#field${index}`;
      const placeholder = `:value${index}`;
      names[name] = key;
      expressionValues[placeholder] = value;
      return `${name} = ${placeholder}`;
    });
    const expected = expectedStatuses.map((status, index) => {
      const placeholder = `:expected${index}`;
      expressionValues[placeholder] = status;
      return placeholder;
    });
    try {
      const result = await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { runId },
          UpdateExpression: `SET ${assignments.join(', ')}`,
          ConditionExpression: `attribute_exists(runId) AND #status IN (${expected.join(', ')})`,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: expressionValues,
          ReturnValues: 'ALL_NEW',
        }),
      );
      return result.Attributes as unknown as RunRecord;
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
      const current = await this.get(runId);
      if (!current) throw new Error(`run ${runId} not found`);
      const intended = values.status ?? current.status;
      throw new InvalidStateTransitionError(current.status, intended);
    }
  }
}

export class S3ArtifactStore implements ArtifactStore {
  public constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  public putJson(key: string, value: unknown): Promise<ArtifactReference> {
    return this.putBytes(key, Buffer.from(JSON.stringify(value)), 'application/json');
  }

  public async getJson<T>(reference: Pick<ArtifactReference, 'bucket' | 'key'>): Promise<T> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: reference.bucket, Key: reference.key }),
    );
    if (!result.Body) throw new Error(`artifact s3://${reference.bucket}/${reference.key} is empty`);
    const text = await result.Body.transformToString('utf8');
    return JSON.parse(text) as T;
  }

  public async putBytes(
    key: string,
    value: Uint8Array,
    contentType: string,
  ): Promise<ArtifactReference> {
    const digest = createHash('sha256').update(value).digest();
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: value,
        ContentType: contentType,
        ServerSideEncryption: 'AES256',
        ChecksumSHA256: digest.toString('base64'),
      }),
    );
    return { bucket: this.bucket, key, sha256: digest.toString('hex') };
  }
}

export class S3ResultReader implements ResultReader {
  public constructor(private readonly client: S3Client) {}

  public async read(reference: ArtifactReference): Promise<string | undefined> {
    const result = await this.client.send(new GetObjectCommand({
      Bucket: reference.bucket,
      Key: reference.key,
    }));
    return result.Body?.transformToString('utf8');
  }
}

export class SqsRunQueue implements RunQueue {
  public constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
  ) {}

  public async enqueue(message: RunQueueMessage): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(message),
        MessageAttributes: {
          traceId: { DataType: 'String', StringValue: message.traceId },
        },
      }),
    );
  }
}

export class SqsConversationQueue implements ConversationQueue {
  public constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
  ) {}

  public async enqueue(message: ConversationWakeMessage): Promise<void> {
    await this.client.send(new SendMessageCommand({
      QueueUrl: this.queueUrl,
      MessageBody: JSON.stringify(message),
      MessageAttributes: {
        traceId: { DataType: 'String', StringValue: message.traceId },
      },
    }));
  }
}

export class EventBridgeRunEvents {
  public constructor(
    private readonly client: EventBridgeClient,
    private readonly busName: string,
  ) {}

  public async publish(event: RunStateEvent): Promise<void> {
    const result = await this.client.send(
      new PutEventsCommand({
        Entries: [
          {
            EventBusName: this.busName,
            Source: 'indubitably.agent-runtime',
            DetailType: 'Agent Run State',
            Detail: JSON.stringify(event),
          },
        ],
      }),
    );
    if ((result.FailedEntryCount ?? 0) > 0) {
      throw new Error(`EventBridge rejected run event: ${result.Entries?.[0]?.ErrorMessage ?? 'unknown'}`);
    }
  }
}

export class CachedSecretReader implements SecretReader {
  private readonly values = new Map<string, { value: string; expiresAt: number }>();

  public constructor(
    private readonly client: SecretsManagerClient,
    private readonly ttlMs = 5 * 60_000,
  ) {}

  public async get(secretArn: string): Promise<string> {
    const cached = this.values.get(secretArn);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const result = await this.client.send(new GetSecretValueCommand({ SecretId: secretArn }));
    const value = result.SecretString ?? (result.SecretBinary ? Buffer.from(result.SecretBinary).toString('utf8') : '');
    if (!value) throw new Error(`secret ${secretArn} has no value`);
    this.values.set(secretArn, { value, expiresAt: Date.now() + this.ttlMs });
    return value;
  }
}

function isConditionalFailure(error: unknown): boolean {
  return (
    error instanceof ConditionalCheckFailedException ||
    (error instanceof Error && error.name === 'ConditionalCheckFailedException')
  );
}

function encodeToken(key: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(key)).toString('base64url');
}

function decodeToken(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error('invalid pagination token');
  }
}
