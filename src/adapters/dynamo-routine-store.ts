import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { RoutineStore } from '../core/ports.js';
import type {
  ListRoutinesResult,
  RoutineRecord,
  RoutineStatus,
} from '../domain/routines.js';

export class DynamoRoutineStore implements RoutineStore {
  public constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  public async create(record: RoutineRecord): Promise<void> {
    await this.client.send(new PutCommand({
      TableName: this.tableName,
      Item: record,
      ConditionExpression: 'attribute_not_exists(routineId)',
    }));
  }

  public async get(routineId: string): Promise<RoutineRecord | undefined> {
    const result = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: { routineId },
      ConsistentRead: true,
    }));
    return result.Item as RoutineRecord | undefined;
  }

  public async list(ownerId: string, limit: number, nextToken?: string): Promise<ListRoutinesResult> {
    const items: RoutineRecord[] = [];
    let startKey = nextToken ? decodeToken(nextToken) : undefined;
    do {
      const result = await this.client.send(new QueryCommand({
        TableName: this.tableName,
        IndexName: 'owner-created-index',
        KeyConditionExpression: 'ownerId = :ownerId',
        FilterExpression: '#status <> :deleted',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':ownerId': ownerId, ':deleted': 'deleted' },
        ScanIndexForward: false,
        Limit: limit - items.length,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }));
      items.push(...(result.Items ?? []) as RoutineRecord[]);
      startKey = result.LastEvaluatedKey;
    } while (startKey && items.length < limit);
    const response: ListRoutinesResult = { items };
    if (startKey) response.nextToken = encodeToken(startKey);
    return response;
  }

  public async listDue(cutoff: string, limit: number): Promise<RoutineRecord[]> {
    const result = await this.client.send(new QueryCommand({
      TableName: this.tableName,
      IndexName: 'status-next-run-index',
      KeyConditionExpression: '#status = :enabled AND nextRunAt <= :cutoff',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':enabled': 'enabled', ':cutoff': cutoff },
      ScanIndexForward: true,
      Limit: limit,
    }));
    return (result.Items ?? []) as RoutineRecord[];
  }

  public async setStatus(
    ownerId: string,
    routineId: string,
    status: Exclude<RoutineStatus, 'deleted'>,
    nextRunAt: string,
    updatedAt: string,
  ): Promise<RoutineRecord> {
    try {
      const result = await this.client.send(new UpdateCommand({
        TableName: this.tableName,
        Key: { routineId },
        UpdateExpression: 'SET #status = :status, nextRunAt = :nextRunAt, updatedAt = :updatedAt',
        ConditionExpression: 'ownerId = :ownerId AND #status <> :deleted',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':ownerId': ownerId,
          ':status': status,
          ':deleted': 'deleted',
          ':nextRunAt': nextRunAt,
          ':updatedAt': updatedAt,
        },
        ReturnValues: 'ALL_NEW',
      }));
      return result.Attributes as unknown as RoutineRecord;
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) throw error;
      throw new Error('routine changed concurrently');
    }
  }

  public async softDelete(
    ownerId: string,
    routineId: string,
    updatedAt: string,
    expiresAt: number,
  ): Promise<RoutineRecord> {
    try {
      const result = await this.client.send(new UpdateCommand({
        TableName: this.tableName,
        Key: { routineId },
        UpdateExpression: 'SET #status = :deleted, updatedAt = :updatedAt, expiresAt = :expiresAt',
        ConditionExpression: 'ownerId = :ownerId AND #status <> :deleted',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':ownerId': ownerId,
          ':deleted': 'deleted',
          ':updatedAt': updatedAt,
          ':expiresAt': expiresAt,
        },
        ReturnValues: 'ALL_NEW',
      }));
      return result.Attributes as unknown as RoutineRecord;
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) throw error;
      throw new Error('routine changed concurrently');
    }
  }

  public async recordLastRun(
    ownerId: string,
    routineId: string,
    runAt: string,
    runId: string,
    updatedAt: string,
  ): Promise<boolean> {
    try {
      await this.client.send(new UpdateCommand({
        TableName: this.tableName,
        Key: { routineId },
        UpdateExpression: 'SET lastRunAt = :runAt, lastRunId = :runId, updatedAt = :updatedAt',
        ConditionExpression: 'ownerId = :ownerId AND #status <> :deleted AND (attribute_not_exists(lastRunAt) OR lastRunAt <= :runAt)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':ownerId': ownerId,
          ':deleted': 'deleted',
          ':runAt': runAt,
          ':runId': runId,
          ':updatedAt': updatedAt,
        },
      }));
      return true;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) return false;
      throw error;
    }
  }

  public async advance(
    routineId: string,
    expectedRunAt: string,
    nextRunAt: string,
    runId: string,
    updatedAt: string,
  ): Promise<boolean> {
    try {
      await this.client.send(new UpdateCommand({
        TableName: this.tableName,
        Key: { routineId },
        UpdateExpression: 'SET nextRunAt = :nextRunAt, lastRunAt = :lastRunAt, lastRunId = :runId, updatedAt = :updatedAt',
        ConditionExpression: '#status = :enabled AND nextRunAt = :expectedRunAt',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':enabled': 'enabled',
          ':expectedRunAt': expectedRunAt,
          ':nextRunAt': nextRunAt,
          ':lastRunAt': expectedRunAt,
          ':runId': runId,
          ':updatedAt': updatedAt,
        },
      }));
      return true;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) return false;
      throw error;
    }
  }
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
