import { createHash } from 'node:crypto';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { RunRecord } from '../domain/contracts.js';

const DEFAULT_LEASE_SECONDS = 120;

export class DeliveryInProgressError extends Error {
  public constructor(destination: string) {
    super(`delivery ${destination} is still in progress`);
    this.name = 'DeliveryInProgressError';
  }
}

/**
 * A durable, expiring delivery claim. Terminal states suppress duplicates; an
 * abandoned `sending` claim throws so EventBridge keeps retrying until the lease
 * can be reclaimed.
 */
export class DeliveryFence {
  public constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly table: string,
    private readonly now: () => number = Date.now,
    private readonly leaseSeconds = DEFAULT_LEASE_SECONDS,
  ) {}

  public async claim(run: RunRecord, destination: string): Promise<boolean> {
    const key = deliveryKey(run.runId, destination);
    const now = this.now();
    try {
      await this.client.send(new PutCommand({
        TableName: this.table,
        Item: {
          runId: key,
          itemType: 'delivery',
          parentRunId: run.runId,
          destination,
          status: 'sending',
          createdAt: new Date(now).toISOString(),
          leaseUntil: Math.floor(now / 1_000) + this.leaseSeconds,
          expiresAt: run.expiresAt,
        },
        ConditionExpression: 'attribute_not_exists(runId)',
      }));
      return true;
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
    }

    const existing = await this.client.send(new GetCommand({
      TableName: this.table,
      Key: { runId: key },
      ConsistentRead: true,
    }));
    if (!existing.Item) {
      // A concurrent cleanup removed the claim between the failed put and read.
      return this.claim(run, destination);
    }
    if (existing.Item.status !== 'sending') return false;

    const nowSeconds = Math.floor(now / 1_000);
    if (typeof existing.Item.leaseUntil === 'number' && existing.Item.leaseUntil > nowSeconds) {
      throw new DeliveryInProgressError(destination);
    }
    try {
      await this.client.send(new UpdateCommand({
        TableName: this.table,
        Key: { runId: key },
        UpdateExpression: 'SET leaseUntil = :leaseUntil, updatedAt = :updatedAt',
        ConditionExpression: '#status = :sending AND (attribute_not_exists(leaseUntil) OR leaseUntil <= :now)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':sending': 'sending',
          ':now': nowSeconds,
          ':leaseUntil': nowSeconds + this.leaseSeconds,
          ':updatedAt': new Date(now).toISOString(),
        },
      }));
      return true;
    } catch (error) {
      if (isConditionalFailure(error)) throw new DeliveryInProgressError(destination);
      throw error;
    }
  }

  public async delivered(runId: string, destination: string, receipt: string): Promise<void> {
    await this.update(runId, destination, 'delivered', { receipt });
  }

  public async failed(runId: string, destination: string, error: unknown): Promise<void> {
    await this.update(runId, destination, 'outcome_unknown', {
      failure: error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000),
    });
  }

  public async release(runId: string, destination: string): Promise<void> {
    await this.client.send(new DeleteCommand({
      TableName: this.table,
      Key: { runId: deliveryKey(runId, destination) },
      ConditionExpression: '#status = :sending',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':sending': 'sending' },
    }));
  }

  private async update(
    runId: string,
    destination: string,
    status: string,
    extra: Record<string, string>,
  ): Promise<void> {
    await this.client.send(new UpdateCommand({
      TableName: this.table,
      Key: { runId: deliveryKey(runId, destination) },
      UpdateExpression: 'SET #status = :status, updatedAt = :now, details = :details REMOVE leaseUntil',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':status': status, ':now': new Date(this.now()).toISOString(), ':details': extra },
    }));
  }
}

function deliveryKey(runId: string, destination: string): string {
  const digest = createHash('sha256').update(destination).digest('hex').slice(0, 24);
  return `delivery#${runId}#${digest}`;
}

function isConditionalFailure(error: unknown): boolean {
  return error instanceof Error && error.name === 'ConditionalCheckFailedException';
}
