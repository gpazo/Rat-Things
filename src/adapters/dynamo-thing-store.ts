import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { ThingStore } from '../core/ports.js';
import type {
  ListThingsResult,
  ThingRecord,
  ThingRevision,
  ThingStatus,
  ThingTriggerState,
  ThingVersionRecord,
} from '../domain/things.js';

const ROOT_KEY = 'THING';
const VERSION_PREFIX = 'VERSION#';

export class DynamoThingStore implements ThingStore {
  public constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  public async create(record: ThingRecord, version: ThingVersionRecord): Promise<void> {
    await this.client.send(new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: this.tableName,
            Item: rootItem(record),
            ConditionExpression: 'attribute_not_exists(thingId)',
          },
        },
        {
          Put: {
            TableName: this.tableName,
            Item: versionItem(version),
            ConditionExpression: 'attribute_not_exists(thingId)',
          },
        },
      ],
    }));
  }

  public async get(thingId: string): Promise<ThingRecord | undefined> {
    const result = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: { thingId, recordKey: ROOT_KEY },
      ConsistentRead: true,
    }));
    return result.Item ? rootRecord(result.Item) : undefined;
  }

  public async getVersion(thingId: string, revision: number): Promise<ThingVersionRecord | undefined> {
    const result = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: { thingId, recordKey: versionKey(revision) },
      ConsistentRead: true,
    }));
    return result.Item ? versionRecord(result.Item) : undefined;
  }

  public async listVersions(thingId: string): Promise<ThingVersionRecord[]> {
    const result = await this.client.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: 'thingId = :thingId AND begins_with(recordKey, :prefix)',
      ExpressionAttributeValues: { ':thingId': thingId, ':prefix': VERSION_PREFIX },
      ConsistentRead: true,
      ScanIndexForward: true,
    }));
    return (result.Items ?? []).map(versionRecord);
  }

  public async list(
    ownerId: string,
    limit: number,
    nextToken?: string,
    includeArchived = false,
  ): Promise<ListThingsResult> {
    const items: ThingRecord[] = [];
    let startKey = nextToken ? decodeToken(nextToken) : undefined;
    do {
      const result = await this.client.send(new QueryCommand({
        TableName: this.tableName,
        IndexName: 'owner-created-index',
        KeyConditionExpression: 'ownerId = :ownerId',
        ...(includeArchived ? {} : {
          FilterExpression: '#status <> :archived',
          ExpressionAttributeNames: { '#status': 'status' },
        }),
        ExpressionAttributeValues: {
          ':ownerId': ownerId,
          ...(includeArchived ? {} : { ':archived': 'archived' }),
        },
        ScanIndexForward: false,
        Limit: limit - items.length,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }));
      items.push(...(result.Items ?? []).map(rootRecord));
      startKey = result.LastEvaluatedKey;
    } while (startKey && items.length < limit);
    return {
      items,
      ...(startKey ? { nextToken: encodeToken(startKey) } : {}),
    };
  }

  public async addVersion(
    ownerId: string,
    thingId: string,
    draft: ThingRevision,
    version: ThingVersionRecord,
    expectedDraftRevision: number,
    updatedAt: string,
  ): Promise<ThingRecord> {
    try {
      await this.client.send(new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: this.tableName,
              Key: { thingId, recordKey: ROOT_KEY },
              UpdateExpression: 'SET #draft = :draft, updatedAt = :updatedAt',
              ConditionExpression: 'ownerId = :ownerId AND #draft.revision = :expected AND #status <> :archived',
              ExpressionAttributeNames: { '#draft': 'draft', '#status': 'status' },
              ExpressionAttributeValues: {
                ':ownerId': ownerId,
                ':draft': draft,
                ':updatedAt': updatedAt,
                ':expected': expectedDraftRevision,
                ':archived': 'archived',
              },
            },
          },
          {
            Put: {
              TableName: this.tableName,
              Item: versionItem(version),
              ConditionExpression: 'attribute_not_exists(thingId)',
            },
          },
        ],
      }));
      const updated = await this.get(thingId);
      if (!updated) throw new Error('Thing version update returned no record');
      return updated;
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
      throw new Error('Thing changed concurrently');
    }
  }

  public async publish(
    ownerId: string,
    thingId: string,
    draft: ThingRevision,
    expectedStatus: ThingStatus,
    triggerState: ThingTriggerState,
    updatedAt: string,
  ): Promise<ThingRecord> {
    try {
      const result = await this.client.send(new UpdateCommand({
        TableName: this.tableName,
        Key: { thingId, recordKey: ROOT_KEY },
        UpdateExpression: 'SET #active = :draft, #status = :activeStatus, triggerState = :triggerState, updatedAt = :updatedAt',
        ConditionExpression: 'ownerId = :ownerId AND #draft.revision = :revision AND #status = :expectedStatus',
        ExpressionAttributeNames: {
          '#active': 'active',
          '#draft': 'draft',
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':ownerId': ownerId,
          ':draft': draft,
          ':revision': draft.revision,
          ':activeStatus': 'active',
          ':expectedStatus': expectedStatus,
          ':triggerState': triggerState,
          ':updatedAt': updatedAt,
        },
        ReturnValues: 'ALL_NEW',
      }));
      if (!result.Attributes) throw new Error('Thing publish returned no record');
      return rootRecord(result.Attributes);
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
      throw new Error('Thing changed concurrently');
    }
  }

  public async setStatus(
    ownerId: string,
    thingId: string,
    from: ThingStatus[],
    status: ThingStatus,
    triggerState: ThingTriggerState,
    updatedAt: string,
  ): Promise<ThingRecord> {
    const fromValues = Object.fromEntries(from.map((value, index) => [`:from${index}`, value]));
    try {
      const result = await this.client.send(new UpdateCommand({
        TableName: this.tableName,
        Key: { thingId, recordKey: ROOT_KEY },
        UpdateExpression: 'SET #status = :status, triggerState = :triggerState, updatedAt = :updatedAt',
        ConditionExpression: `ownerId = :ownerId AND #status IN (${from.map((_, index) => `:from${index}`).join(', ')})`,
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':ownerId': ownerId,
          ':status': status,
          ':triggerState': triggerState,
          ':updatedAt': updatedAt,
          ...fromValues,
        },
        ReturnValues: 'ALL_NEW',
      }));
      if (!result.Attributes) throw new Error('Thing status update returned no record');
      return rootRecord(result.Attributes);
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
      throw new Error('Thing changed concurrently');
    }
  }

  public async setTriggerState(
    thingId: string,
    expectedRevision: number | undefined,
    state: ThingTriggerState,
    updatedAt: string,
  ): Promise<ThingRecord> {
    try {
      const result = await this.client.send(new UpdateCommand({
        TableName: this.tableName,
        Key: { thingId, recordKey: ROOT_KEY },
        UpdateExpression: 'SET triggerState = :state, updatedAt = :updatedAt',
        ConditionExpression: expectedRevision === undefined
          ? 'attribute_not_exists(#active)'
          : '#active.revision = :revision',
        ExpressionAttributeNames: { '#active': 'active' },
        ExpressionAttributeValues: {
          ':state': state,
          ':updatedAt': updatedAt,
          ...(expectedRevision === undefined ? {} : { ':revision': expectedRevision }),
        },
        ReturnValues: 'ALL_NEW',
      }));
      if (!result.Attributes) throw new Error('Thing trigger-state update returned no record');
      return rootRecord(result.Attributes);
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
      throw new Error('Thing changed concurrently');
    }
  }

  public async recordRun(
    thingId: string,
    expectedActiveRevision: number,
    allowedStatuses: ThingStatus[],
    runAt: string,
    runId: string,
    updatedAt: string,
  ): Promise<boolean> {
    const statusValues = Object.fromEntries(
      allowedStatuses.map((value, index) => [`:status${index}`, value]),
    );
    try {
      await this.client.send(new UpdateCommand({
        TableName: this.tableName,
        Key: { thingId, recordKey: ROOT_KEY },
        UpdateExpression: 'SET lastRunAt = :runAt, lastRunId = :runId, updatedAt = :updatedAt',
        ConditionExpression: `#active.revision = :revision AND #status IN (${allowedStatuses.map((_, index) => `:status${index}`).join(', ')})`,
        ExpressionAttributeNames: { '#active': 'active', '#status': 'status' },
        ExpressionAttributeValues: {
          ':revision': expectedActiveRevision,
          ':runAt': runAt,
          ':runId': runId,
          ':updatedAt': updatedAt,
          ...statusValues,
        },
      }));
      return true;
    } catch (error) {
      if (isConditionalFailure(error)) return false;
      throw error;
    }
  }
}

function rootItem(record: ThingRecord): ThingRecord & { recordKey: string } {
  return { ...structuredClone(record), recordKey: ROOT_KEY };
}

function versionItem(record: ThingVersionRecord): ThingVersionRecord & { recordKey: string } {
  return { ...structuredClone(record), recordKey: versionKey(record.revision) };
}

function rootRecord(item: Record<string, unknown>): ThingRecord {
  const { recordKey: _recordKey, ...record } = item;
  return structuredClone(record) as unknown as ThingRecord;
}

function versionRecord(item: Record<string, unknown>): ThingVersionRecord {
  const { recordKey: _recordKey, ...record } = item;
  return structuredClone(record) as unknown as ThingVersionRecord;
}

function versionKey(revision: number): string {
  return `${VERSION_PREFIX}${String(revision).padStart(12, '0')}`;
}

function isConditionalFailure(error: unknown): boolean {
  if (error instanceof ConditionalCheckFailedException) return true;
  if (!error || typeof error !== 'object') return false;
  if ((error as { name?: string }).name === 'ConditionalCheckFailedException') return true;
  const cancellationReasons = (error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons;
  if (cancellationReasons) {
    return cancellationReasons.some((reason) => reason.Code === 'ConditionalCheckFailed');
  }
  return (error as { name?: string; message?: string }).name === 'TransactionCanceledException' &&
    /ConditionalCheckFailed/.test((error as { message?: string }).message ?? '');
}

function encodeToken(key: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

function decodeToken(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error('invalid pagination token');
  }
}
