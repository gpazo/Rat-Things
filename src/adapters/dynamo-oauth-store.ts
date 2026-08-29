import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DeleteCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type {
  OAuthAuthorizationRecord,
  OAuthAuthorizationStore,
} from '../plugins/oauth.js';
import { createHash } from 'node:crypto';

export class DynamoOAuthAuthorizationStore implements OAuthAuthorizationStore {
  public constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  public async create(stateHash: string, record: OAuthAuthorizationRecord): Promise<void> {
    await this.client.send(new PutCommand({
      TableName: this.tableName,
      Item: {
        pk: `OAUTH#${stateHash}`,
        sk: 'AUTHORIZATION',
        value: record,
        expiresAt: record.expiresAt,
      },
      ConditionExpression: 'attribute_not_exists(pk)',
    }));
  }

  public async consume(stateHash: string): Promise<OAuthAuthorizationRecord | undefined> {
    const result = await this.client.send(new DeleteCommand({
      TableName: this.tableName,
      Key: { pk: `OAUTH#${stateHash}`, sk: 'AUTHORIZATION' },
      ReturnValues: 'ALL_OLD',
    }));
    return result.Attributes?.value as OAuthAuthorizationRecord | undefined;
  }

  public async acquireRefreshLock(
    ownerId: string,
    connectionId: string,
    token: string,
    expiresAt: number,
  ): Promise<boolean> {
    try {
      await this.client.send(new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: refreshKey(ownerId, connectionId),
          sk: 'LOCK',
          value: { token },
          expiresAt,
        },
        ConditionExpression: 'attribute_not_exists(pk) OR expiresAt < :now',
        ExpressionAttributeValues: { ':now': Math.floor(Date.now() / 1_000) },
      }));
      return true;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException || (
        error instanceof Error && error.name === 'ConditionalCheckFailedException'
      )) return false;
      throw error;
    }
  }

  public async releaseRefreshLock(
    ownerId: string,
    connectionId: string,
    token: string,
  ): Promise<void> {
    try {
      await this.client.send(new DeleteCommand({
        TableName: this.tableName,
        Key: { pk: refreshKey(ownerId, connectionId), sk: 'LOCK' },
        ConditionExpression: '#value.#token = :token',
        ExpressionAttributeNames: { '#value': 'value', '#token': 'token' },
        ExpressionAttributeValues: { ':token': token },
      }));
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException || (
        error instanceof Error && error.name === 'ConditionalCheckFailedException'
      )) return;
      throw error;
    }
  }
}

function refreshKey(ownerId: string, connectionId: string): string {
  return `OAUTH_REFRESH#${createHash('sha256').update(`${ownerId}\0${connectionId}`).digest('hex')}`;
}
