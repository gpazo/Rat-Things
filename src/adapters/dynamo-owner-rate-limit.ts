import { createHash } from 'node:crypto';
import { GetCommand, TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { AgentsApiError } from '../domain/agents-api-validation.js';
import type { OwnerRateLimit } from '../core/owner-rate-limiter.js';
import { measuredDynamo } from './aws-performance.js';

/** Compact counter and idempotency receipts kept in DynamoDB metadata, never S3. */
export class DynamoOwnerRateLimit implements OwnerRateLimit {
  public constructor(private readonly client: DynamoDBDocumentClient, private readonly tableName: string,
    private readonly limit: (ownerId: string) => number = () => 60,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000)) {}

  public async admit(ownerId: string, operationId: string, requests = 1): Promise<void> {
    const maximum = this.limit(ownerId);
    if (!Number.isSafeInteger(maximum) || maximum < 0 || !Number.isSafeInteger(requests) || requests < 1) throw new Error('Invalid owner rate limit');
    const owner = hash(ownerId), operation = hash(operationId);
    const counterKey = { scope: `owner-rate:${owner}`, key: 'current' };
    const receiptKey = { scope: `owner-rate:${owner}`, key: `receipt:${operation}` };
    const receipt = await this.read(receiptKey);
    if (receipt) { same(receipt.requests, requests); return; }
    for (let attempt = 0; attempt < 20; attempt++) {
      const now = this.now(), minute = Math.floor(now / 60);
      const current = await this.read(counterKey);
      const currentMinute = Number(current?.minute ?? -1);
      // Skewed clocks can use the current bucket, but can never move a newer bucket backward.
      const bucket = Math.max(minute, currentMinute);
      const count = (currentMinute === bucket ? Number(current?.requests ?? 0) : 0) + requests;
      if (count > maximum) throw new AgentsApiError(429, 'The owner execution rate limit is exhausted. Retry later.', 'owner_rate_limit_exceeded', null, (bucket + 1) * 60 - now);
      const counterUpdate = currentMinute === bucket
        ? { Update: { TableName: this.tableName, Key: counterKey, UpdateExpression: 'SET #minute = :minute ADD #requests :requests', ConditionExpression: '#minute = :minute AND #requests <= :remaining', ExpressionAttributeNames: { '#minute': 'minute', '#requests': 'requests' }, ExpressionAttributeValues: { ':minute': bucket, ':requests': requests, ':remaining': maximum - requests } } }
        : { Update: { TableName: this.tableName, Key: counterKey, UpdateExpression: 'SET #minute = :minute, #requests = :requests', ConditionExpression: 'attribute_not_exists(#minute) OR #minute < :minute', ExpressionAttributeNames: { '#minute': 'minute', '#requests': 'requests' }, ExpressionAttributeValues: { ':minute': bucket, ':requests': requests } } };
      try {
        await measuredDynamo(() => this.client.send(new TransactWriteCommand({ TransactItems: [counterUpdate, { Put: { TableName: this.tableName,
          Item: { ...receiptKey, kind: 'owner-rate-receipt', requests, revision: 1, createdAt: now },
          ConditionExpression: 'attribute_not_exists(#key)', ExpressionAttributeNames: { '#key': 'key' },
        } }], ReturnConsumedCapacity: 'TOTAL' })), 'write');
        return;
      } catch (error) {
        const committed = await this.read(receiptKey);
        if (committed) { same(committed.requests, requests); return; }
        if (!confirmedContention(error) || attempt === 19) throw error;
      }
    }
  }

  private async read(key: { scope: string; key: string }): Promise<{ minute?: number; requests: number } | undefined> {
    const response = await measuredDynamo(() => this.client.send(new GetCommand({ TableName: this.tableName, Key: key, ConsistentRead: true, ReturnConsumedCapacity: 'TOTAL' })), 'read');
    return response.Item as { minute?: number; requests: number } | undefined;
  }
}

function same(previous: number, requested: number) {
  if (previous !== requested) throw new AgentsApiError(409, 'Admission changed on retry.', 'idempotency_conflict');
}
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function confirmedContention(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'ConditionalCheckFailedException' || error.name === 'TransactionConflictException') return true;
  if (error.name !== 'TransactionCanceledException' || !('CancellationReasons' in error) || !Array.isArray(error.CancellationReasons)) return false;
  const codes = error.CancellationReasons.map((reason: unknown) => typeof reason === 'object' && reason !== null && 'Code' in reason ? reason.Code : undefined);
  return codes.some(code => code === 'ConditionalCheckFailed' || code === 'TransactionConflict')
    && codes.every(code => code === 'None' || code === 'ConditionalCheckFailed' || code === 'TransactionConflict');
}
