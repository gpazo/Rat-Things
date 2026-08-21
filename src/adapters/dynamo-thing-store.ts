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
  ThingStatus,
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

  public async listDue(cutoff: string, limit: number): Promise<ThingRecord[]> {
    const result = await this.client.send(new QueryCommand({
      TableName: this.tableName,
      IndexName: 'status-next-run-index',
      KeyConditionExpression: '#status = :enabled AND nextRunAt <= :cutoff',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':enabled': 'enabled', ':cutoff': cutoff },
      ScanIndexForward: true,
      Limit: limit,
    }));
    return (result.Items ?? []).map(rootRecord);
  }

  public async addVersion(
    record: ThingRecord,
    version: ThingVersionRecord,
    expectedRevision: number,
  ): Promise<ThingRecord> {
    try {
      await this.client.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.tableName,
              Item: rootItem(record),
              ConditionExpression: 'ownerId = :ownerId AND revision = :expected AND #status = :expectedStatus',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: {
                ':ownerId': record.ownerId,
                ':expected': expectedRevision,
                ':expectedStatus': record.status,
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
      return structuredClone(record);
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
    nextRunAt: string | undefined,
    updatedAt: string,
  ): Promise<ThingRecord> {
    const fromValues = Object.fromEntries(from.map((value, index) => [`:from${index}`, value]));
    try {
      const result = await this.client.send(new UpdateCommand({
        TableName: this.tableName,
        Key: { thingId, recordKey: ROOT_KEY },
        UpdateExpression: nextRunAt
          ? 'SET #status = :status, nextRunAt = :nextRunAt, updatedAt = :updatedAt'
          : 'SET #status = :status, updatedAt = :updatedAt REMOVE nextRunAt',
        ConditionExpression: `ownerId = :ownerId AND #status IN (${from.map((_, index) => `:from${index}`).join(', ')})`,
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':ownerId': ownerId,
          ':status': status,
          ':updatedAt': updatedAt,
          ...fromValues,
          ...(nextRunAt ? { ':nextRunAt': nextRunAt } : {}),
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

  public async advance(
    thingId: string,
    expectedRevision: number,
    expectedRunAt: string,
    nextRunAt: string,
    runId: string,
    updatedAt: string,
  ): Promise<boolean> {
    try {
      await this.client.send(new UpdateCommand({
        TableName: this.tableName,
        Key: { thingId, recordKey: ROOT_KEY },
        UpdateExpression: 'SET nextRunAt = :nextRunAt, lastRunAt = :lastRunAt, lastRunId = :runId, updatedAt = :updatedAt',
        ConditionExpression: '#status = :enabled AND revision = :revision AND nextRunAt = :expectedRunAt',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':enabled': 'enabled',
          ':revision': expectedRevision,
          ':expectedRunAt': expectedRunAt,
          ':nextRunAt': nextRunAt,
          ':lastRunAt': expectedRunAt,
          ':runId': runId,
          ':updatedAt': updatedAt,
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
