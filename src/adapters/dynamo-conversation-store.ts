import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { createHash } from 'node:crypto';
import type {
  ConversationEventRecord,
  ConversationLease,
  ConversationMessageRecord,
  ConversationExecutionPolicy,
  ConversationRecord,
  ConversationTurnRecord,
} from '../domain/conversations.js';
import {
  ConversationConflictError,
  ConversationLeaseError,
  ConversationStateError,
  type AcquireConversationLeaseResult,
  type AppendConversationMessageResult,
  type ConversationStore,
  type PendingMessageOptions,
} from '../conversation/types.js';

const WORK_INDEX = 'conversation-work-index';
const MAX_OPTIMISTIC_ATTEMPTS = 5;

export class DynamoConversationStore implements ConversationStore {
  public constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  public async getConversation(conversationId: string): Promise<ConversationRecord | undefined> {
    const result = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: metaKey(conversationId),
      ConsistentRead: true,
    }));
    return storedRecord<ConversationRecord>(result.Item);
  }

  public getMessage(
    conversationId: string,
    messageId: string,
  ): Promise<ConversationMessageRecord | undefined> {
    return this.getItem<ConversationMessageRecord>(mailboxKey(conversationId, messageId));
  }

  public async appendMessage(input: {
    conversation: ConversationRecord;
    message: ConversationMessageRecord;
    event: ConversationEventRecord;
  }): Promise<AppendConversationMessageResult> {
    const pk = partitionKey(input.conversation.conversationId);
    const messageKey = mailboxKey(input.conversation.conversationId, input.message.messageId);
    for (let attempt = 0; attempt < MAX_OPTIMISTIC_ATTEMPTS; attempt += 1) {
      const current = await this.getConversation(input.conversation.conversationId);
      if (current && current.ownerId !== input.conversation.ownerId) {
        throw new ConversationConflictError('conversation belongs to another owner');
      }
      if (
        current?.executionPolicy &&
        input.conversation.executionPolicy &&
        !sameExecutionPolicy(current.executionPolicy, input.conversation.executionPolicy)
      ) {
        throw new ConversationConflictError('conversation execution policy cannot change');
      }
      const status = current?.status === 'running' || current?.status === 'awaiting_resume'
        ? current.status
        : 'pending';
      try {
        await this.client.send(new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  ...input.message,
                  ...messageKey,
                  workPartition: pk,
                  workOrder: workOrder(input.message),
                },
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
            eventPut(this.tableName, input.event),
            {
              Update: {
                TableName: this.tableName,
                Key: metaKey(input.conversation.conversationId),
                UpdateExpression: [
                  'SET #version = :version',
                  'itemType = :itemType',
                  'conversationId = if_not_exists(conversationId, :conversationId)',
                  'ownerId = if_not_exists(ownerId, :ownerId)',
                  'createdAt = if_not_exists(createdAt, :createdAt)',
                  'updatedAt = :updatedAt',
                  'expiresAt = :expiresAt',
                  '#status = :status',
                  'pendingCount = if_not_exists(pendingCount, :zero) + :one',
                  '#source = :source',
                  'destination = :destination',
                  'actor = :actor',
                  'credentialSubject = :credentialSubject',
                  ...(input.conversation.executionPolicy
                    ? ['executionPolicy = if_not_exists(executionPolicy, :executionPolicy)']
                    : []),
                ].join(', '),
                ConditionExpression: current
                  ? 'ownerId = :ownerId AND #status = :expectedStatus AND pendingCount = :expectedPendingCount'
                  : 'attribute_not_exists(ownerId)',
                ExpressionAttributeNames: {
                  '#version': 'version',
                  '#status': 'status',
                  '#source': 'source',
                },
                ExpressionAttributeValues: {
                  ':version': '1',
                  ':itemType': 'conversation',
                  ':conversationId': input.conversation.conversationId,
                  ':ownerId': input.conversation.ownerId,
                  ':createdAt': input.conversation.createdAt,
                  ':updatedAt': input.conversation.updatedAt,
                  ':expiresAt': input.conversation.expiresAt,
                  ':status': status,
                  ':zero': 0,
                  ':one': 1,
                  ':source': input.conversation.source,
                  ':destination': input.conversation.destination,
                  ':actor': input.conversation.actor,
                  ':credentialSubject': input.conversation.credentialSubject,
                  ...(input.conversation.executionPolicy
                    ? { ':executionPolicy': input.conversation.executionPolicy }
                    : {}),
                  ...(current ? {
                    ':expectedStatus': current.status,
                    ':expectedPendingCount': current.pendingCount,
                  } : {}),
                },
              },
            },
          ],
        }));
        const conversation = await this.requiredConversation(input.conversation.conversationId);
        return { status: 'appended', conversation, message: input.message };
      } catch (error) {
        if (!isConditionalFailure(error)) throw error;
        const existing = await this.getItem<ConversationMessageRecord>(messageKey);
        if (existing) {
          if (
            existing.messageId !== input.message.messageId ||
            existing.contentHash !== input.message.contentHash ||
            existing.delivery !== input.message.delivery
          ) {
            throw new ConversationConflictError('message id was reused with different content');
          }
          return {
            status: 'duplicate',
            conversation: await this.requiredConversation(input.conversation.conversationId),
            message: existing,
          };
        }
      }
    }
    throw new ConversationStateError('conversation changed too frequently while appending work');
  }

  public async listPending(
    conversationId: string,
    options: PendingMessageOptions = {},
  ): Promise<ConversationMessageRecord[]> {
    const pk = partitionKey(conversationId);
    const deliveryPrefix = options.delivery ? `${priority(options.delivery)}#` : undefined;
    const result = await this.client.send(new QueryCommand({
      TableName: this.tableName,
      IndexName: WORK_INDEX,
      KeyConditionExpression: deliveryPrefix
        ? 'workPartition = :pk AND begins_with(workOrder, :order)'
        : 'workPartition = :pk',
      ExpressionAttributeValues: {
        ':pk': pk,
        ...(deliveryPrefix ? { ':order': deliveryPrefix } : {}),
      },
      ScanIndexForward: true,
      Limit: options.limit ?? 25,
    }));
    return (result.Items ?? []).map((item) => storedRecord<ConversationMessageRecord>(item))
      .filter((item): item is ConversationMessageRecord => Boolean(item));
  }

  public async acquireLease(input: {
    conversationId: string;
    lease: ConversationLease;
    now: string;
  }): Promise<AcquireConversationLeaseResult> {
    for (let attempt = 0; attempt < MAX_OPTIMISTIC_ATTEMPTS; attempt += 1) {
      const current = await this.getConversation(input.conversationId);
      if (!current) return { status: 'no_work' };
      const hasWork = current.pendingCount > 0 || Boolean(current.activeTurnId);
      if (!hasWork) return { status: 'no_work', conversation: current };
      if (current.lease && current.lease.expiresAt > input.now) {
        return { status: 'active', conversation: current };
      }
      try {
        const result = await this.client.send(new UpdateCommand({
          TableName: this.tableName,
          Key: metaKey(input.conversationId),
          UpdateExpression: 'SET lease = :lease, #status = :running, updatedAt = :now',
          ConditionExpression: [
            'attribute_exists(pk)',
            'pendingCount = :pendingCount',
            '#status = :expectedStatus',
            '(attribute_not_exists(lease) OR lease.expiresAt <= :now)',
          ].join(' AND '),
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':lease': input.lease,
            ':running': 'running',
            ':now': input.now,
            ':pendingCount': current.pendingCount,
            ':expectedStatus': current.status,
          },
          ReturnValues: 'ALL_NEW',
        }));
        const conversation = requiredStoredRecord<ConversationRecord>(result.Attributes);
        return { status: 'acquired', conversation, lease: input.lease };
      } catch (error) {
        if (!isConditionalFailure(error)) throw error;
      }
    }
    const current = await this.requiredConversation(input.conversationId);
    if (current.lease && current.lease.expiresAt > input.now) {
      return { status: 'active', conversation: current };
    }
    if (current.pendingCount === 0 && !current.activeTurnId) {
      return { status: 'no_work', conversation: current };
    }
    throw new ConversationStateError('conversation changed too frequently while acquiring its lease');
  }

  public async checkIn(input: {
    conversationId: string;
    lease: ConversationLease;
    expectedToken: string;
    now: string;
  }): Promise<ConversationRecord> {
    try {
      const result = await this.client.send(new UpdateCommand({
        TableName: this.tableName,
        Key: metaKey(input.conversationId),
        UpdateExpression: 'SET lease = :lease, updatedAt = :now',
        ConditionExpression: 'lease.#token = :token AND lease.expiresAt > :now',
        ExpressionAttributeNames: { '#token': 'token' },
        ExpressionAttributeValues: {
          ':lease': input.lease,
          ':token': input.expectedToken,
          ':now': input.now,
        },
        ReturnValues: 'ALL_NEW',
      }));
      return requiredStoredRecord<ConversationRecord>(result.Attributes);
    } catch (error) {
      if (isConditionalFailure(error)) throw new ConversationLeaseError('conversation lease was lost');
      throw error;
    }
  }

  public async releaseLease(input: {
    conversationId: string;
    expectedToken: string;
    updatedAt: string;
  }): Promise<ConversationRecord> {
    try {
      const result = await this.client.send(new UpdateCommand({
        TableName: this.tableName,
        Key: metaKey(input.conversationId),
        UpdateExpression: 'SET updatedAt = :now REMOVE lease',
        ConditionExpression: 'lease.#token = :token',
        ExpressionAttributeNames: { '#token': 'token' },
        ExpressionAttributeValues: {
          ':token': input.expectedToken,
          ':now': input.updatedAt,
        },
        ReturnValues: 'ALL_NEW',
      }));
      return requiredStoredRecord<ConversationRecord>(result.Attributes);
    } catch (error) {
      if (isConditionalFailure(error)) throw new ConversationLeaseError('conversation lease was lost');
      throw error;
    }
  }

  public async beginTurn(input: {
    turn: ConversationTurnRecord;
    event: ConversationEventRecord;
    leaseToken: string;
  }): Promise<ConversationTurnRecord> {
    try {
      await this.client.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.tableName,
              Item: { ...input.turn, ...turnKey(input.turn.conversationId, input.turn.turnId) },
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
          eventPut(this.tableName, input.event),
          {
            Update: {
              TableName: this.tableName,
              Key: metaKey(input.turn.conversationId),
              UpdateExpression: 'SET activeTurnId = :turnId, #status = :running, updatedAt = :now',
              ConditionExpression: 'lease.#token = :token AND attribute_not_exists(activeTurnId)',
              ExpressionAttributeNames: { '#status': 'status', '#token': 'token' },
              ExpressionAttributeValues: {
                ':turnId': input.turn.turnId,
                ':running': 'running',
                ':now': input.turn.updatedAt,
                ':token': input.leaseToken,
              },
            },
          },
        ],
      }));
      return input.turn;
    } catch (error) {
      if (isConditionalFailure(error)) throw new ConversationStateError('turn could not acquire conversation ownership');
      throw error;
    }
  }

  public async attachRun(input: {
    conversationId: string;
    turnId: string;
    runId: string;
    event: ConversationEventRecord;
    leaseToken: string;
    updatedAt: string;
  }): Promise<ConversationTurnRecord> {
    try {
      await this.client.send(new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: this.tableName,
              Key: turnKey(input.conversationId, input.turnId),
              UpdateExpression: 'SET runId = :runId, updatedAt = :now',
              ConditionExpression: '#state = :running AND attribute_not_exists(runId)',
              ExpressionAttributeNames: { '#state': 'state' },
              ExpressionAttributeValues: {
                ':runId': input.runId,
                ':running': 'running',
                ':now': input.updatedAt,
              },
            },
          },
          eventPut(this.tableName, input.event),
          {
            Update: {
              TableName: this.tableName,
              Key: metaKey(input.conversationId),
              UpdateExpression: 'SET updatedAt = :now',
              ConditionExpression: 'lease.#token = :token AND activeTurnId = :turnId',
              ExpressionAttributeNames: { '#token': 'token' },
              ExpressionAttributeValues: {
                ':token': input.leaseToken,
                ':turnId': input.turnId,
                ':now': input.updatedAt,
              },
            },
          },
        ],
      }));
      return this.requiredTurn(input.conversationId, input.turnId);
    } catch (error) {
      if (isConditionalFailure(error)) {
        throw new ConversationStateError('run could not be attached to the active turn');
      }
      throw error;
    }
  }

  public async scheduleRun(input: {
    conversationId: string;
    turnId: string;
    runId: string;
    messageIds: string[];
    runEvent: ConversationEventRecord;
    consumeEvent: ConversationEventRecord;
    leaseToken: string;
    updatedAt: string;
  }): Promise<ConversationTurnRecord> {
    const messageUpdates = input.messageIds.map((messageId) => ({
      Update: {
        TableName: this.tableName,
        Key: mailboxKey(input.conversationId, messageId),
        UpdateExpression: [
          'SET #state = :consumed',
          'consumedAt = :now',
          'turnId = :turnId',
          'runId = :runId',
        ].join(', ') + ' REMOVE workPartition, workOrder',
        ConditionExpression: '#state = :pending AND messageId = :messageId',
        ExpressionAttributeNames: { '#state': 'state' },
        ExpressionAttributeValues: {
          ':consumed': 'consumed',
          ':pending': 'pending',
          ':now': input.updatedAt,
          ':messageId': messageId,
          ':turnId': input.turnId,
          ':runId': input.runId,
        },
      },
    }));
    try {
      await this.client.send(new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: this.tableName,
              Key: turnKey(input.conversationId, input.turnId),
              UpdateExpression: 'SET runId = :runId, updatedAt = :now',
              ConditionExpression: '#state = :running AND attribute_not_exists(runId)',
              ExpressionAttributeNames: { '#state': 'state' },
              ExpressionAttributeValues: {
                ':runId': input.runId,
                ':running': 'running',
                ':now': input.updatedAt,
              },
            },
          },
          ...messageUpdates,
          eventPut(this.tableName, input.runEvent),
          eventPut(this.tableName, input.consumeEvent),
          {
            Update: {
              TableName: this.tableName,
              Key: metaKey(input.conversationId),
              UpdateExpression: 'SET pendingCount = pendingCount - :count, updatedAt = :now',
              ConditionExpression: [
                'lease.#token = :token',
                'activeTurnId = :turnId',
                'pendingCount >= :count',
              ].join(' AND '),
              ExpressionAttributeNames: { '#token': 'token' },
              ExpressionAttributeValues: {
                ':count': input.messageIds.length,
                ':token': input.leaseToken,
                ':turnId': input.turnId,
                ':now': input.updatedAt,
              },
            },
          },
        ],
      }));
      return this.requiredTurn(input.conversationId, input.turnId);
    } catch (error) {
      if (isConditionalFailure(error)) {
        throw new ConversationStateError('run scheduling lost its turn, messages, or lease');
      }
      throw error;
    }
  }

  public async resumeTurn(input: {
    conversationId: string;
    turnId: string;
    event: ConversationEventRecord;
    leaseToken: string;
    updatedAt: string;
  }): Promise<ConversationTurnRecord> {
    const current = await this.requiredTurn(input.conversationId, input.turnId);
    if (current.state !== 'awaiting_resume') throw new ConversationStateError('turn is not awaiting resume');
    try {
      await this.client.send(new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: this.tableName,
              Key: turnKey(input.conversationId, input.turnId),
              UpdateExpression: [
                'SET #state = :running',
                'slice = :nextSlice',
                'resumedFromSlice = :previousSlice',
                'updatedAt = :now',
              ].join(', ') + ' REMOVE runId',
              ConditionExpression: '#state = :awaiting AND slice = :previousSlice',
              ExpressionAttributeNames: { '#state': 'state' },
              ExpressionAttributeValues: {
                ':running': 'running',
                ':awaiting': 'awaiting_resume',
                ':nextSlice': current.slice + 1,
                ':previousSlice': current.slice,
                ':now': input.updatedAt,
              },
            },
          },
          eventPut(this.tableName, input.event),
          {
            Update: {
              TableName: this.tableName,
              Key: metaKey(input.conversationId),
              UpdateExpression: 'SET #status = :running, updatedAt = :now',
              ConditionExpression: 'lease.#token = :token AND activeTurnId = :turnId',
              ExpressionAttributeNames: { '#status': 'status', '#token': 'token' },
              ExpressionAttributeValues: {
                ':running': 'running',
                ':now': input.updatedAt,
                ':token': input.leaseToken,
                ':turnId': input.turnId,
              },
            },
          },
        ],
      }));
      return this.requiredTurn(input.conversationId, input.turnId);
    } catch (error) {
      if (isConditionalFailure(error)) throw new ConversationLeaseError('turn resume lost its lease or state');
      throw error;
    }
  }

  public async checkpointTurn(input: {
    conversationId: string;
    turnId: string;
    checkpoint: ConversationTurnRecord['checkpoint'];
    resumeReason: NonNullable<ConversationTurnRecord['resumeReason']>;
    event: ConversationEventRecord;
    leaseToken: string;
    updatedAt: string;
  }): Promise<ConversationTurnRecord> {
    try {
      await this.client.send(new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: this.tableName,
              Key: turnKey(input.conversationId, input.turnId),
              UpdateExpression: 'SET #state = :awaiting, checkpoint = :checkpoint, resumeReason = :reason, updatedAt = :now',
              ConditionExpression: '#state = :running',
              ExpressionAttributeNames: { '#state': 'state' },
              ExpressionAttributeValues: {
                ':awaiting': 'awaiting_resume',
                ':running': 'running',
                ':checkpoint': input.checkpoint,
                ':reason': input.resumeReason,
                ':now': input.updatedAt,
              },
            },
          },
          eventPut(this.tableName, input.event),
          {
            Update: {
              TableName: this.tableName,
              Key: metaKey(input.conversationId),
              UpdateExpression: 'SET #status = :awaiting, updatedAt = :now REMOVE lease',
              ConditionExpression: 'lease.#token = :token AND activeTurnId = :turnId',
              ExpressionAttributeNames: { '#status': 'status', '#token': 'token' },
              ExpressionAttributeValues: {
                ':awaiting': 'awaiting_resume',
                ':now': input.updatedAt,
                ':token': input.leaseToken,
                ':turnId': input.turnId,
              },
            },
          },
        ],
      }));
      return this.requiredTurn(input.conversationId, input.turnId);
    } catch (error) {
      if (isConditionalFailure(error)) throw new ConversationLeaseError('turn checkpoint lost its lease or state');
      throw error;
    }
  }

  public async reportProgress(input: {
    conversationId: string;
    turnId: string;
    progress: NonNullable<ConversationRecord['latestProgress']>;
    event: ConversationEventRecord;
    leaseToken: string;
  }): Promise<ConversationRecord> {
    try {
      await this.client.send(new TransactWriteCommand({
        TransactItems: [
          eventPut(this.tableName, input.event),
          {
            Update: {
              TableName: this.tableName,
              Key: metaKey(input.conversationId),
              UpdateExpression: 'SET latestProgress = :progress, updatedAt = :now',
              ConditionExpression: 'lease.#token = :token AND activeTurnId = :turnId',
              ExpressionAttributeNames: { '#token': 'token' },
              ExpressionAttributeValues: {
                ':progress': input.progress,
                ':now': input.progress.reportedAt,
                ':token': input.leaseToken,
                ':turnId': input.turnId,
              },
            },
          },
        ],
      }));
      return this.requiredConversation(input.conversationId);
    } catch (error) {
      if (isConditionalFailure(error)) throw new ConversationLeaseError('progress update lost its conversation lease');
      throw error;
    }
  }

  public async consumeMessages(input: {
    conversationId: string;
    messageIds: string[];
    event: ConversationEventRecord;
    leaseToken: string;
    consumedAt: string;
  }): Promise<ConversationRecord> {
    const messageUpdates = input.messageIds.map((messageId) => ({
      Update: {
        TableName: this.tableName,
        Key: mailboxKey(input.conversationId, messageId),
        UpdateExpression: 'SET #state = :consumed, consumedAt = :now REMOVE workPartition, workOrder',
        ConditionExpression: '#state = :pending AND messageId = :messageId',
        ExpressionAttributeNames: { '#state': 'state' },
        ExpressionAttributeValues: {
          ':consumed': 'consumed',
          ':pending': 'pending',
          ':now': input.consumedAt,
          ':messageId': messageId,
        },
      },
    }));
    try {
      await this.client.send(new TransactWriteCommand({
        TransactItems: [
          ...messageUpdates,
          eventPut(this.tableName, input.event),
          {
            Update: {
              TableName: this.tableName,
              Key: metaKey(input.conversationId),
              UpdateExpression: 'SET pendingCount = pendingCount - :count, updatedAt = :now',
              ConditionExpression: 'lease.#token = :token AND pendingCount >= :count',
              ExpressionAttributeNames: { '#token': 'token' },
              ExpressionAttributeValues: {
                ':count': input.messageIds.length,
                ':now': input.consumedAt,
                ':token': input.leaseToken,
              },
            },
          },
        ],
      }));
      return this.requiredConversation(input.conversationId);
    } catch (error) {
      if (isConditionalFailure(error)) throw new ConversationStateError('messages were already consumed or the lease was lost');
      throw error;
    }
  }

  public completeTurn(input: {
    conversationId: string;
    turnId: string;
    result?: ConversationTurnRecord['result'];
    context?: ConversationRecord['context'];
    artifacts?: ConversationRecord['artifacts'];
    session?: ConversationRecord['session'];
    event: ConversationEventRecord;
    leaseToken: string;
    completedAt: string;
  }): Promise<ConversationTurnRecord> {
    return this.finishTurn({ ...input, state: 'completed' });
  }

  public failTurn(input: {
    conversationId: string;
    turnId: string;
    error: NonNullable<ConversationTurnRecord['error']>;
    event: ConversationEventRecord;
    leaseToken: string;
    failedAt: string;
  }): Promise<ConversationTurnRecord> {
    return this.finishTurn({
      conversationId: input.conversationId,
      turnId: input.turnId,
      error: input.error,
      event: input.event,
      leaseToken: input.leaseToken,
      completedAt: input.failedAt,
      state: 'failed',
    });
  }

  public async getTurn(
    conversationId: string,
    turnId: string,
  ): Promise<ConversationTurnRecord | undefined> {
    return this.getItem<ConversationTurnRecord>(turnKey(conversationId, turnId));
  }

  public async listEvents(conversationId: string, limit = 100): Promise<ConversationEventRecord[]> {
    const result = await this.client.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :event)',
      ExpressionAttributeValues: {
        ':pk': partitionKey(conversationId),
        ':event': 'EVENT#',
      },
      ScanIndexForward: true,
      Limit: limit,
    }));
    return (result.Items ?? []).map((item) => storedRecord<ConversationEventRecord>(item))
      .filter((item): item is ConversationEventRecord => Boolean(item));
  }

  private async finishTurn(input: {
    conversationId: string;
    turnId: string;
    result?: ConversationTurnRecord['result'];
    context?: ConversationRecord['context'];
    artifacts?: ConversationRecord['artifacts'];
    session?: ConversationRecord['session'];
    error?: ConversationTurnRecord['error'];
    event: ConversationEventRecord;
    leaseToken: string;
    completedAt: string;
    state: 'completed' | 'failed';
  }): Promise<ConversationTurnRecord> {
    for (let attempt = 0; attempt < MAX_OPTIMISTIC_ATTEMPTS; attempt += 1) {
      const conversation = await this.requiredConversation(input.conversationId);
      const nextStatus = input.state === 'failed'
        ? 'failed'
        : conversation.pendingCount > 0 ? 'pending' : 'idle';
      const turnValues: Record<string, unknown> = {
        ':state': input.state,
        ':running': 'running',
        ':now': input.completedAt,
        ...(input.result ? { ':result': input.result } : {}),
        ...(input.error ? { ':error': input.error } : {}),
      };
      const turnAssignments = [
        '#state = :state',
        'updatedAt = :now',
        'completedAt = :now',
        ...(input.result ? ['#result = :result'] : []),
        ...(input.error ? ['#error = :error'] : []),
      ];
      try {
        await this.client.send(new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.tableName,
                Key: turnKey(input.conversationId, input.turnId),
                UpdateExpression: `SET ${turnAssignments.join(', ')}`,
                ConditionExpression: '#state = :running',
                ExpressionAttributeNames: {
                  '#state': 'state',
                  ...(input.result ? { '#result': 'result' } : {}),
                  ...(input.error ? { '#error': 'error' } : {}),
                },
                ExpressionAttributeValues: turnValues,
              },
            },
            eventPut(this.tableName, input.event),
            {
              Update: {
                TableName: this.tableName,
                Key: metaKey(input.conversationId),
                UpdateExpression: [
                  'SET #status = :status, updatedAt = :now',
                  ...(input.context ? [', #context = :context'] : []),
                  ...(input.artifacts ? [', artifacts = :artifacts'] : []),
                  ...(input.session ? [', #session = :session'] : []),
                  ' REMOVE lease, activeTurnId, latestProgress',
                ].join(''),
                ConditionExpression: [
                  'lease.#token = :token',
                  'activeTurnId = :turnId',
                  'pendingCount = :pendingCount',
                ].join(' AND '),
                ExpressionAttributeNames: {
                  '#status': 'status',
                  '#token': 'token',
                  ...(input.context ? { '#context': 'context' } : {}),
                  ...(input.session ? { '#session': 'session' } : {}),
                },
                ExpressionAttributeValues: {
                  ':status': nextStatus,
                  ':now': input.completedAt,
                  ':token': input.leaseToken,
                  ':turnId': input.turnId,
                  ':pendingCount': conversation.pendingCount,
                  ...(input.context ? { ':context': input.context } : {}),
                  ...(input.artifacts ? { ':artifacts': input.artifacts } : {}),
                  ...(input.session ? { ':session': input.session } : {}),
                },
              },
            },
          ],
        }));
        return this.requiredTurn(input.conversationId, input.turnId);
      } catch (error) {
        if (!isConditionalFailure(error)) throw error;
        const latest = await this.requiredConversation(input.conversationId);
        if (latest.lease?.token !== input.leaseToken || latest.activeTurnId !== input.turnId) {
          throw new ConversationLeaseError('turn completion lost its conversation lease');
        }
      }
    }
    throw new ConversationStateError('conversation changed too frequently while completing the turn');
  }

  private async requiredConversation(conversationId: string): Promise<ConversationRecord> {
    const conversation = await this.getConversation(conversationId);
    if (!conversation) throw new ConversationStateError(`conversation ${conversationId} was not found`);
    return conversation;
  }

  private async requiredTurn(conversationId: string, turnId: string): Promise<ConversationTurnRecord> {
    const turn = await this.getTurn(conversationId, turnId);
    if (!turn) throw new ConversationStateError(`turn ${turnId} was not found`);
    return turn;
  }

  private async getItem<T>(key: { pk: string; sk: string }): Promise<T | undefined> {
    const result = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: key,
      ConsistentRead: true,
    }));
    return storedRecord<T>(result.Item);
  }
}

function sameExecutionPolicy(
  left: ConversationExecutionPolicy,
  right: ConversationExecutionPolicy,
): boolean {
  return left.driver === right.driver &&
    left.model === right.model &&
    left.sandbox === right.sandbox &&
    left.reasoningEffort === right.reasoningEffort;
}

function partitionKey(conversationId: string): string {
  return `CONVERSATION#${hash(conversationId)}`;
}

function metaKey(conversationId: string): { pk: string; sk: string } {
  return { pk: partitionKey(conversationId), sk: 'META' };
}

function mailboxKey(conversationId: string, messageId: string): { pk: string; sk: string } {
  return { pk: partitionKey(conversationId), sk: `MAILBOX#${hash(messageId)}` };
}

function turnKey(conversationId: string, turnId: string): { pk: string; sk: string } {
  return { pk: partitionKey(conversationId), sk: `TURN#${hash(turnId)}` };
}

function eventKey(event: ConversationEventRecord): { pk: string; sk: string } {
  return {
    pk: partitionKey(event.conversationId),
    sk: `EVENT#${event.occurredAt}#${hash(event.eventId)}`,
  };
}

function eventPut(tableName: string, event: ConversationEventRecord) {
  return {
    Put: {
      TableName: tableName,
      Item: { ...event, ...eventKey(event) },
      ConditionExpression: 'attribute_not_exists(pk)',
    },
  };
}

function workOrder(message: ConversationMessageRecord): string {
  return `${priority(message.delivery)}#${message.createdAt}#${hash(message.messageId)}`;
}

function priority(delivery: ConversationMessageRecord['delivery']): '0' | '1' {
  return delivery === 'interrupt' ? '0' : '1';
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function storedRecord<T>(item: Record<string, unknown> | undefined): T | undefined {
  if (!item) return undefined;
  const {
    pk: _pk,
    sk: _sk,
    workPartition: _workPartition,
    workOrder: _workOrder,
    ...record
  } = item;
  return record as T;
}

function requiredStoredRecord<T>(item: Record<string, unknown> | undefined): T {
  const record = storedRecord<T>(item);
  if (!record) throw new ConversationStateError('DynamoDB did not return the updated record');
  return record;
}

function isConditionalFailure(error: unknown): boolean {
  return error instanceof Error && (
    error.name === 'ConditionalCheckFailedException' ||
    error.name === 'TransactionCanceledException'
  );
}
