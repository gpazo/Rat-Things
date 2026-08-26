import { createHash } from 'node:crypto';
import {
  ConditionalCheckFailedException,
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { SchedulerClient } from '@aws-sdk/client-scheduler';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
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
  ConversationRunBinding,
  ExecutionLivenessObservation,
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
  AgentToolCallStore,
  CreateRunResult,
  RunQueue,
  RunStore,
} from '../core/ports.js';
import type { AgentToolCallRecord } from '../domain/interaction.js';
import type { PublicationGrantStore } from '../core/publication-publisher.js';
import type { PublicationObjectStore } from '../core/publication-service.js';
import { validateArtifactPath } from '../domain/artifacts.js';
import type {
  BlobReference,
  PublicationManifest,
  PublicationShare,
} from '../domain/publications.js';
import { validatePublicationManifest, validateShareGrant } from '../domain/publications.js';
import type { ConversationQueue } from '../conversation/types.js';
import type { SecretReader } from '../credentials/types.js';
import type { ResultReader } from '../delivery/types.js';

export interface AwsClients {
  dynamodb: DynamoDBDocumentClient;
  s3: S3Client;
  sqs: SQSClient;
  events: EventBridgeClient;
  scheduler: SchedulerClient;
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
    scheduler: new SchedulerClient(config),
    secrets: new SecretsManagerClient(config),
  };
}

export class DynamoRunStore implements RunStore, AgentToolCallStore {
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

  public prepareConversation(
    runId: string,
    executionInput: ArtifactReference,
    conversation: ConversationRunBinding,
  ): Promise<RunRecord> {
    return this.update(runId, { executionInput, conversation }, ['queued']);
  }

  public async attachExecution(runId: string, execution: ExecutionReference): Promise<RunRecord> {
    if (!execution.generation) return this.update(runId, { execution }, ['dispatching', 'running']);
    const now = new Date().toISOString();
    try {
      const result = await this.client.send(new UpdateCommand({
        TableName: this.tableName,
        Key: { runId },
        UpdateExpression: 'SET #execution = :execution, #heartbeatAt = :now, #updatedAt = :now REMOVE #liveness',
        ConditionExpression: [
          'attribute_exists(runId)',
          '#status IN (:dispatching, :running)',
          '(attribute_not_exists(#execution) OR (#execution.#id = :pending AND (attribute_not_exists(#execution.#generation) OR #execution.#generation = :generation)))',
        ].join(' AND '),
        ExpressionAttributeNames: {
          '#status': 'status',
          '#execution': 'execution',
          '#id': 'id',
          '#generation': 'generation',
          '#heartbeatAt': 'heartbeatAt',
          '#updatedAt': 'updatedAt',
          '#liveness': 'liveness',
        },
        ExpressionAttributeValues: {
          ':dispatching': 'dispatching',
          ':running': 'running',
          ':pending': 'pending',
          ':generation': execution.generation,
          ':execution': execution,
          ':now': now,
        },
        ReturnValues: 'ALL_NEW',
      }));
      return result.Attributes as unknown as RunRecord;
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
      const current = await this.get(runId);
      if (!current) throw new Error(`run ${runId} not found`);
      // RunMicrovm is idempotent by run ID. A reconciler/SQS redelivery can
      // therefore receive the same MicroVM while the first delivery is
      // attaching it. Treat an attachment that has already won as success;
      // importantly, do not rewrite it because the runner may already have
      // added startedAt or moved the Run to a terminal state.
      if (
        current.execution?.backend === execution.backend &&
        current.execution.id === execution.id &&
        current.execution.generation === execution.generation
      ) {
        return current;
      }
      throw new InvalidStateTransitionError(current.status, current.status);
    }
  }

  /** Starts only the exact execution generation that the dispatcher attached. */
  public async startExecution(
    runId: string,
    execution: ExecutionReference,
    startedAt: string,
  ): Promise<RunRecord> {
    const result = await this.updateExactExecution({
      runId,
      execution,
      expectedStatuses: ['dispatching'],
      updateExpression: [
        'SET #status = :running, #execution = :startedExecution,',
        '#heartbeatAt = :startedAt, #updatedAt = :startedAt',
        'REMOVE #liveness',
      ].join(' '),
      names: {
        '#heartbeatAt': 'heartbeatAt',
        '#updatedAt': 'updatedAt',
        '#liveness': 'liveness',
      },
      values: {
        ':running': 'running',
        ':startedAt': startedAt,
        ':startedExecution': { ...execution, startedAt },
      },
      returnValues: 'ALL_NEW',
    });
    if (!result || result === true) throw new InvalidStateTransitionError('dispatching', 'running');
    return result;
  }

  /** Refreshes liveness without changing semantic updatedAt. */
  public async heartbeatExecution(
    runId: string,
    execution: ExecutionReference,
    heartbeatAt: string,
  ): Promise<boolean> {
    return Boolean(await this.updateExactExecution({
      runId,
      execution,
      expectedStatuses: ['running'],
      updateExpression: 'SET #heartbeatAt = :heartbeatAt REMOVE #liveness',
      names: { '#heartbeatAt': 'heartbeatAt', '#liveness': 'liveness' },
      values: { ':heartbeatAt': heartbeatAt },
    }));
  }

  /** Fails a stale Run only if its attachment and observed heartbeat are unchanged. */
  public async failExecution(
    runId: string,
    execution: ExecutionReference,
    expectedHeartbeatAt: string,
    error: RunError,
  ): Promise<boolean> {
    return this.terminalizeExactExecution({
      runId,
      execution,
      expectedStatuses: ['dispatching', 'running'],
      expectedHeartbeatAt,
      status: 'failed',
      error,
    });
  }

  /** Finalizes cancellation only for the execution generation that was inspected. */
  public async cancelExecution(
    runId: string,
    execution: ExecutionReference,
  ): Promise<boolean> {
    return this.terminalizeExactExecution({
      runId,
      execution,
      expectedStatuses: ['cancelling'],
      status: 'cancelled',
    });
  }

  public async beginAgentToolCall(record: AgentToolCallRecord): Promise<AgentToolCallRecord> {
    validateToolCallRecord(record);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const run = await this.get(record.runId);
      if (!run) throw new Error(`run ${record.runId} not found`);
      assertToolCallExecution(run, record.executionId, record.executionGeneration);
      if (run.status !== 'running') throw new Error('dynamic tool call Run is not active');
      const current = run.agentToolCalls ?? [];
      const existing = current.find((candidate) => candidate.requestId === record.requestId);
      if (existing) {
        if (
          existing.argumentDigest !== record.argumentDigest ||
          existing.admittedToolsDigest !== record.admittedToolsDigest ||
          existing.namespace !== record.namespace ||
          existing.tool !== record.tool ||
          existing.executionGeneration !== record.executionGeneration
        ) throw new Error(`dynamic tool request ${record.requestId} was reused with different input`);
        return existing;
      }
      if (current.length >= 256) throw new Error('dynamic tool call ledger exceeds 256 records');
      if (await this.replaceAgentToolCalls(run, [...current, record], ['running'])) return record;
    }
    throw new Error('dynamic tool call ledger changed too frequently');
  }

  public async settleAgentToolCall(input: {
    runId: string;
    execution: ExecutionReference;
    requestId: string;
    status: 'succeeded' | 'failed';
    settledAt: string;
    resultDigest: string;
    error?: string;
  }): Promise<AgentToolCallRecord> {
    if (!input.execution.generation) throw new Error('dynamic tool settlement requires a generation');
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const run = await this.get(input.runId);
      if (!run) throw new Error(`run ${input.runId} not found`);
      assertToolCallExecution(run, input.execution.id, input.execution.generation);
      if (run.status !== 'running') throw new Error('dynamic tool call Run is not active');
      const current = run.agentToolCalls ?? [];
      const index = current.findIndex((candidate) => candidate.requestId === input.requestId);
      if (index < 0) throw new Error(`dynamic tool request ${input.requestId} is not recorded`);
      const existing = current[index]!;
      if (existing.status !== 'pending') {
        if (existing.status === input.status && existing.resultDigest === input.resultDigest) return existing;
        throw new Error(`dynamic tool request ${input.requestId} is already ${existing.status}`);
      }
      const settled: AgentToolCallRecord = {
        ...existing,
        status: input.status,
        settledAt: input.settledAt,
        resultDigest: input.resultDigest,
        ...(input.error ? { error: input.error.replace(/[\r\n]+/g, ' ').slice(0, 500) } : {}),
      };
      const next = current.slice();
      next[index] = settled;
      if (await this.replaceAgentToolCalls(run, next, ['running'])) return settled;
    }
    throw new Error('dynamic tool call settlement raced too frequently');
  }

  /** Records bounded repair evidence without making the Run look semantically updated. */
  public async recordLivenessInspection(
    runId: string,
    execution: ExecutionReference,
    expectedHeartbeatAt: string,
    observation: ExecutionLivenessObservation,
  ): Promise<boolean> {
    return Boolean(await this.updateExactExecution({
      runId,
      execution,
      expectedStatuses: ['dispatching', 'running', 'cancelling'],
      expectedHeartbeatAt,
      updateExpression: 'SET #liveness = :liveness',
      names: { '#liveness': 'liveness' },
      values: { ':liveness': observation },
    }));
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

  /**
   * Commits terminal Run state and marks every exact-generation pending tool
   * call interrupted in the same conditional item update. Conversation
   * completion can therefore never observe a terminal Run with a stale
   * pending call.
   */
  private async terminalizeExactExecution(options: {
    runId: string;
    execution: ExecutionReference;
    expectedStatuses: RunStatus[];
    expectedHeartbeatAt?: string;
    status: 'failed' | 'cancelled';
    error?: RunError;
  }): Promise<boolean> {
    const generation = options.execution.generation;
    if (!generation) return false;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const run = await this.get(options.runId);
      if (
        !run ||
        !options.expectedStatuses.includes(run.status) ||
        run.execution?.backend !== options.execution.backend ||
        run.execution.id !== options.execution.id ||
        run.execution.generation !== generation ||
        (options.expectedHeartbeatAt !== undefined && run.heartbeatAt !== options.expectedHeartbeatAt)
      ) return false;
      const settledAt = new Date().toISOString();
      const currentCalls = run.agentToolCalls ?? [];
      const nextCalls = currentCalls.map((call): AgentToolCallRecord => (
        call.status === 'pending' &&
        call.executionId === options.execution.id &&
        call.executionGeneration === generation
          ? {
              ...call,
              status: 'interrupted',
              settledAt,
              error: 'execution ended before the tool result was durably settled; outcome is unknown and the call must not be replayed automatically',
            }
          : call
      ));
      const values: Record<string, unknown> = {
        ':backend': options.execution.backend,
        ':executionId': options.execution.id,
        ':generation': generation,
        ':status': options.status,
        ':updatedAt': settledAt,
        ':nextCalls': nextCalls,
        ...(run.agentToolCalls ? { ':currentCalls': currentCalls } : {}),
        ...(options.error ? { ':error': options.error } : {}),
      };
      const names: Record<string, string> = {
        '#status': 'status',
        '#execution': 'execution',
        '#backend': 'backend',
        '#id': 'id',
        '#generation': 'generation',
        '#updatedAt': 'updatedAt',
        '#agentToolCalls': 'agentToolCalls',
        ...(options.error ? { '#error': 'error' } : {}),
      };
      const statusValues = options.expectedStatuses.map((status, index) => {
        values[`:expectedStatus${index}`] = status;
        return `:expectedStatus${index}`;
      });
      const conditions = [
        'attribute_exists(runId)',
        `#status IN (${statusValues.join(', ')})`,
        '#execution.#backend = :backend',
        '#execution.#id = :executionId',
        '#execution.#generation = :generation',
        run.agentToolCalls
          ? '#agentToolCalls = :currentCalls'
          : 'attribute_not_exists(#agentToolCalls)',
      ];
      if (options.expectedHeartbeatAt !== undefined) {
        names['#heartbeatAt'] = 'heartbeatAt';
        values[':expectedHeartbeatAt'] = options.expectedHeartbeatAt;
        conditions.push('#heartbeatAt = :expectedHeartbeatAt');
      }
      try {
        await this.client.send(new UpdateCommand({
          TableName: this.tableName,
          Key: { runId: options.runId },
          UpdateExpression: [
            'SET #status = :status, #updatedAt = :updatedAt, #agentToolCalls = :nextCalls',
            ...(options.error ? [', #error = :error'] : []),
          ].join(''),
          ConditionExpression: conditions.join(' AND '),
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        }));
        return true;
      } catch (error) {
        if (!isConditionalFailure(error)) throw error;
      }
    }
    return false;
  }

  private async replaceAgentToolCalls(
    run: RunRecord,
    next: AgentToolCallRecord[],
    statuses: RunStatus[],
  ): Promise<boolean> {
    const execution = run.execution;
    if (!execution?.generation) return false;
    const values: Record<string, unknown> = {
      ':backend': execution.backend,
      ':executionId': execution.id,
      ':generation': execution.generation,
      ':next': next,
      ...(run.agentToolCalls ? { ':current': run.agentToolCalls } : {}),
    };
    const expected = statuses.map((status, index) => {
      values[`:status${index}`] = status;
      return `:status${index}`;
    });
    try {
      await this.client.send(new UpdateCommand({
        TableName: this.tableName,
        Key: { runId: run.runId },
        UpdateExpression: 'SET #agentToolCalls = :next',
        ConditionExpression: [
          `#status IN (${expected.join(', ')})`,
          '#execution.#backend = :backend',
          '#execution.#id = :executionId',
          '#execution.#generation = :generation',
          run.agentToolCalls
            ? '#agentToolCalls = :current'
            : 'attribute_not_exists(#agentToolCalls)',
        ].join(' AND '),
        ExpressionAttributeNames: {
          '#status': 'status',
          '#execution': 'execution',
          '#backend': 'backend',
          '#id': 'id',
          '#generation': 'generation',
          '#agentToolCalls': 'agentToolCalls',
        },
        ExpressionAttributeValues: values,
      }));
      return true;
    } catch (error) {
      if (isConditionalFailure(error)) return false;
      throw error;
    }
  }

  private async updateExactExecution(options: {
    runId: string;
    execution: ExecutionReference;
    expectedStatuses: RunStatus[];
    expectedHeartbeatAt?: string;
    updateExpression: string;
    names?: Record<string, string>;
    values?: Record<string, unknown>;
    returnValues?: 'ALL_NEW';
  }): Promise<RunRecord | true | undefined> {
    if (!options.execution.generation) return undefined;
    const names: Record<string, string> = {
      '#status': 'status',
      '#execution': 'execution',
      '#backend': 'backend',
      '#id': 'id',
      '#generation': 'generation',
      ...options.names,
    };
    const values: Record<string, unknown> = {
      ':backend': options.execution.backend,
      ':executionId': options.execution.id,
      ':generation': options.execution.generation,
      ...options.values,
    };
    const statuses = options.expectedStatuses.map((status, index) => {
      values[`:expectedStatus${index}`] = status;
      return `:expectedStatus${index}`;
    });
    const conditions = [
      'attribute_exists(runId)',
      `#status IN (${statuses.join(', ')})`,
      '#execution.#backend = :backend',
      '#execution.#id = :executionId',
      '#execution.#generation = :generation',
    ];
    if (options.expectedHeartbeatAt !== undefined) {
      names['#heartbeatAt'] = 'heartbeatAt';
      values[':expectedHeartbeatAt'] = options.expectedHeartbeatAt;
      conditions.push('#heartbeatAt = :expectedHeartbeatAt');
    }
    try {
      const result = await this.client.send(new UpdateCommand({
        TableName: this.tableName,
        Key: { runId: options.runId },
        UpdateExpression: options.updateExpression,
        ConditionExpression: conditions.join(' AND '),
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ...(options.returnValues ? { ReturnValues: options.returnValues } : {}),
      }));
      return options.returnValues ? result.Attributes as unknown as RunRecord : true;
    } catch (error) {
      if (isConditionalFailure(error)) return undefined;
      throw error;
    }
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
    private readonly encryption: S3ArtifactEncryption = { algorithm: 'AES256' },
  ) {
    if (encryption.algorithm === 'aws:kms' && !encryption.kmsKeyId) {
      throw new Error('aws:kms artifact encryption requires a KMS key ID');
    }
  }

  public putJson(key: string, value: unknown): Promise<ArtifactReference> {
    return this.putBytes(key, Buffer.from(JSON.stringify(value)), 'application/json');
  }

  public async getJson<T>(reference: Pick<ArtifactReference, 'bucket' | 'key'>): Promise<T> {
    return JSON.parse(Buffer.from(await this.getBytes(reference)).toString('utf8')) as T;
  }

  public async getBytes(
    reference: Pick<ArtifactReference, 'bucket' | 'key'>,
  ): Promise<Uint8Array> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: reference.bucket, Key: reference.key }),
    );
    if (!result.Body) throw new Error(`artifact s3://${reference.bucket}/${reference.key} is empty`);
    return result.Body.transformToByteArray();
  }

  public async getStream(
    reference: Pick<ArtifactReference, 'bucket' | 'key'>,
  ): Promise<AsyncIterable<Uint8Array>> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: reference.bucket, Key: reference.key }),
    );
    if (!result.Body) throw new Error(`artifact s3://${reference.bucket}/${reference.key} is empty`);
    const body = result.Body as unknown as AsyncIterable<Uint8Array>;
    if (typeof body[Symbol.asyncIterator] !== 'function') {
      throw new Error(`artifact s3://${reference.bucket}/${reference.key} is not streamable`);
    }
    return body;
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
        ...encryptionHeaders(this.encryption),
        ChecksumSHA256: digest.toString('base64'),
      }),
    );
    return { bucket: this.bucket, key, sha256: digest.toString('hex') };
  }

  public async putStream(
    key: string,
    value: AsyncIterable<Uint8Array>,
    contentType: string,
  ): Promise<ArtifactReference> {
    const created = await this.client.send(new CreateMultipartUploadCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
      ...encryptionHeaders(this.encryption),
    }));
    if (!created.UploadId) throw new Error(`S3 did not create multipart upload for ${key}`);
    const uploadId = created.UploadId;
    const parts: Array<{ ETag: string; PartNumber: number }> = [];
    const digest = createHash('sha256');
    const pending: Buffer[] = [];
    let pendingBytes = 0;
    let received = false;
    try {
      for await (const rawChunk of value) {
        const chunk = Buffer.from(rawChunk);
        if (chunk.length === 0) continue;
        received = true;
        digest.update(chunk);
        pending.push(chunk);
        pendingBytes += chunk.length;
        while (pendingBytes >= MULTIPART_PART_BYTES) {
          const part = takeBytes(pending, MULTIPART_PART_BYTES);
          pendingBytes -= part.length;
          parts.push(await uploadPart(this.client, this.bucket, key, uploadId, parts.length + 1, part));
        }
      }
      if (!received) {
        await this.client.send(new AbortMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
        }));
        return this.putBytes(key, new Uint8Array(), contentType);
      }
      if (pendingBytes > 0) {
        const finalPart = takeBytes(pending, pendingBytes);
        parts.push(await uploadPart(this.client, this.bucket, key, uploadId, parts.length + 1, finalPart));
      }
      await this.client.send(new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts },
      }));
      return { bucket: this.bucket, key, sha256: digest.digest('hex') };
    } catch (error) {
      await this.client.send(new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
      })).catch(() => undefined);
      throw error;
    }
  }

  public async copy(
    source: ArtifactReference,
    key: string,
    contentType: string,
  ): Promise<ArtifactReference> {
    await this.client.send(new CopyObjectCommand({
      Bucket: this.bucket,
      Key: key,
      CopySource: encodeCopySource(source.bucket, source.key),
      ContentType: contentType,
      MetadataDirective: 'REPLACE',
      ...encryptionHeaders(this.encryption),
    }));
    return { bucket: this.bucket, key, sha256: source.sha256 };
  }
}

export type S3ArtifactEncryption =
  | { algorithm: 'AES256' }
  | { algorithm: 'aws:kms'; kmsKeyId: string };

function encryptionHeaders(encryption: S3ArtifactEncryption): {
  ServerSideEncryption: 'AES256' | 'aws:kms';
  SSEKMSKeyId?: string;
} {
  return encryption.algorithm === 'aws:kms'
    ? { ServerSideEncryption: 'aws:kms', SSEKMSKeyId: encryption.kmsKeyId }
    : { ServerSideEncryption: 'AES256' };
}

const MULTIPART_PART_BYTES = 8 * 1024 * 1024;

function takeBytes(chunks: Buffer[], size: number): Buffer {
  const result = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const chunk = chunks[0];
    if (!chunk) throw new Error('multipart stream ended before a complete buffered part');
    const length = Math.min(chunk.length, size - offset);
    chunk.copy(result, offset, 0, length);
    offset += length;
    if (length === chunk.length) chunks.shift();
    else chunks[0] = chunk.subarray(length);
  }
  return result;
}

async function uploadPart(
  client: S3Client,
  bucket: string,
  key: string,
  uploadId: string,
  partNumber: number,
  body: Uint8Array,
): Promise<{ ETag: string; PartNumber: number }> {
  if (partNumber > 10_000) throw new Error(`artifact ${key} exceeds the S3 multipart part limit`);
  const uploaded = await client.send(new UploadPartCommand({
    Bucket: bucket,
    Key: key,
    UploadId: uploadId,
    PartNumber: partNumber,
    Body: body,
  }));
  if (!uploaded.ETag) throw new Error(`S3 returned no ETag for ${key} part ${partNumber}`);
  return { ETag: uploaded.ETag, PartNumber: partNumber };
}

export class S3PublicationObjectStore implements PublicationObjectStore {
  private readonly artifacts: S3ArtifactStore;

  public constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {
    this.artifacts = new S3ArtifactStore(client, bucket);
  }

  public async getCommitted(input: {
    ownerId: string;
    publicationId: string;
  }): Promise<{ manifest: PublicationManifest; manifestBlob: BlobReference } | undefined> {
    const ownerHash = ownerHashFor(input.ownerId);
    const key = publicationObjectKey(ownerHash, input.publicationId, '_rat/manifest.json');
    let result;
    try {
      result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (error) {
      if (isMissingS3Object(error)) return undefined;
      throw error;
    }
    if (!result.Body) throw new Error(`publication manifest s3://${this.bucket}/${key} is empty`);
    const bytes = Buffer.from(await result.Body.transformToByteArray());
    const manifest = JSON.parse(bytes.toString('utf8')) as PublicationManifest;
    validatePublicationManifest(manifest);
    if (manifest.publicationId !== input.publicationId) {
      throw new Error('committed publication identity does not match its storage key');
    }
    return {
      manifest,
      manifestBlob: {
        id: key,
        digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        size: bytes.byteLength,
        mediaType: 'application/json',
      },
    };
  }

  public async stageBlob(input: {
    ownerId: string;
    publicationId: string;
    path: string;
    source: BlobReference;
  }): Promise<BlobReference> {
    validateArtifactPath(input.path);
    const ownerHash = ownerHashFor(input.ownerId);
    if (!input.source.id.startsWith(`owners/${ownerHash}/`)) {
      throw new Error('publication source blob is outside its owner scope');
    }
    const key = publicationObjectKey(ownerHash, input.publicationId, input.path);
    await this.client.send(new CopyObjectCommand({
      Bucket: this.bucket,
      Key: key,
      CopySource: encodeCopySource(this.bucket, input.source.id),
      ContentType: input.source.mediaType,
      CacheControl: 'public, max-age=31536000, immutable',
      MetadataDirective: 'REPLACE',
      ServerSideEncryption: 'AES256',
    }));
    return { ...input.source, id: key };
  }

  public async stageBytes(input: {
    ownerId: string;
    publicationId: string;
    path: string;
    bytes: Uint8Array;
    mediaType: string;
  }): Promise<BlobReference> {
    validateArtifactPath(input.path);
    const ownerHash = ownerHashFor(input.ownerId);
    const reference = await this.artifacts.putBytes(
      publicationObjectKey(ownerHash, input.publicationId, input.path),
      input.bytes,
      input.mediaType,
    );
    return {
      id: reference.key,
      digest: `sha256:${reference.sha256}`,
      size: input.bytes.byteLength,
      mediaType: input.mediaType,
    };
  }

  public async commit(input: {
    ownerId: string;
    manifest: PublicationManifest;
  }): Promise<BlobReference> {
    const ownerHash = ownerHashFor(input.ownerId);
    const bytes = Buffer.from(JSON.stringify(input.manifest));
    const reference = await this.artifacts.putBytes(
      publicationObjectKey(ownerHash, input.manifest.publicationId, '_rat/manifest.json'),
      bytes,
      'application/json',
    );
    return {
      id: reference.key,
      digest: `sha256:${reference.sha256}`,
      size: bytes.byteLength,
      mediaType: 'application/json',
    };
  }
}

function isMissingS3Object(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const value = error as {
    name?: unknown;
    Code?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  // S3 deliberately returns 403 for an absent key when the caller has
  // GetObject but not ListBucket. Keep the control plane on object-scoped IAM:
  // a genuine authorization failure still fails closed on the subsequent
  // owner-scoped stage/commit operation.
  return ['NoSuchKey', 'NotFound', '404', 'AccessDenied'].includes(String(value.name)) ||
    ['NoSuchKey', 'NotFound', '404', 'AccessDenied'].includes(String(value.Code)) ||
    [403, 404].includes(Number(value.$metadata?.httpStatusCode));
}

export class S3PublicationGrantStore implements PublicationGrantStore {
  public constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  public async put(share: PublicationShare): Promise<void> {
    validateShareGrant(share.grant);
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: publicationShareObjectKey(share.grant.id),
      Body: JSON.stringify(share),
      ContentType: 'application/json',
      ServerSideEncryption: 'AES256',
    }));
  }
}

export function publicationShareObjectKey(token: string): string {
  if (!/^[a-f0-9]{32}-[a-f0-9]{64}$/.test(token)) {
    throw new Error('publication share token is invalid');
  }
  const ownerHash = token.slice(0, 32);
  const digest = createHash('sha256').update(token).digest('hex');
  return `owners/${ownerHash}/shares/${digest}.json`;
}

function ownerHashFor(ownerId: string): string {
  return createHash('sha256').update(ownerId).digest('hex').slice(0, 32);
}

function publicationObjectKey(ownerHash: string, publicationId: string, path: string): string {
  return `owners/${ownerHash}/publications/${publicationId}/${path}`;
}

function encodeCopySource(bucket: string, key: string): string {
  return `${encodeURIComponent(bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`;
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
            Source: 'rat-things.agent-runtime',
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

function validateToolCallRecord(record: AgentToolCallRecord): void {
  if (
    record.version !== '1' ||
    record.method !== 'item/tool/call' ||
    record.status !== 'pending' ||
    !record.runId ||
    !record.requestId ||
    Buffer.byteLength(record.requestId, 'utf8') > 256 ||
    !record.executionId ||
    !/^[a-f0-9]{64}$/.test(record.executionGeneration) ||
    (record.namespace !== null && (!record.namespace || Buffer.byteLength(record.namespace, 'utf8') > 128)) ||
    !record.tool ||
    Buffer.byteLength(record.tool, 'utf8') > 128 ||
    !/^[a-f0-9]{64}$/.test(record.argumentDigest) ||
    !/^[a-f0-9]{64}$/.test(record.admittedToolsDigest) ||
    !Number.isFinite(Date.parse(record.startedAt))
  ) throw new Error('dynamic tool call record is invalid');
}

function assertToolCallExecution(
  run: RunRecord,
  executionId: string,
  executionGeneration: string,
): void {
  if (
    run.execution?.backend !== 'microvm' ||
    run.execution.id !== executionId ||
    run.execution.generation !== executionGeneration
  ) throw new Error('dynamic tool call lost its execution authority');
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
