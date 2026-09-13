import { createHash } from 'node:crypto';
import {
  DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import type { AgentListParams } from '../domain/agents-api.js';
import { AgentsApiError, invalid } from '../domain/agents-api-validation.js';
import type { ArtifactReference } from '../domain/contracts.js';
import { canonicalJson } from '../domain/json.js';
import type { AgentResource, AgentsStore } from '../core/agents-ports.js';
import type { ArtifactStore } from '../core/ports.js';

interface ResourceIndex {
  id: string;
  ownerId: string;
  collection: string;
  createdAt: number;
  revision: number;
  expiresAt?: number;
  reference: ArtifactReference;
  deleted?: boolean;
}

/** Strongly consistent indexes; complete definitions and content stay in encrypted S3. */
export class DynamoAgentsStore implements AgentsStore {
  public constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
    private readonly objects: Pick<ArtifactStore, 'putJson' | 'getJson'>,
  ) {}

  public async get<T>(ownerId: string, collection: string, id: string): Promise<AgentResource<T> | undefined> {
    const index = await this.index(ownerId, collection, id);
    return index && !index.deleted ? this.hydrate<T>(index) : undefined;
  }

  public async list<T>(ownerId: string, collection: string, query: AgentListParams) {
    const cursor = query.after ? await this.index(ownerId, collection, query.after) : undefined;
    if (query.after && !cursor) invalid('Invalid pagination cursor', 'after');
    const data: Array<AgentResource<T>> = [];
    const maximum = Math.min(query.limit ?? 20, 100);
    if (!Number.isInteger(maximum) || maximum < 1) invalid('limit must be a positive integer', 'limit');
    const scope = listScope(ownerId, collection);
    let key = cursor ? { scope, key: orderKey(cursor) } : undefined;
    // Fetch one extra entry so has_more means another resource exists, including
    // across DynamoDB's byte-based pagination boundary.
    do {
      const page = await this.client.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: '#scope = :scope',
        ExpressionAttributeNames: { '#scope': 'scope' },
        ExpressionAttributeValues: { ':scope': scope },
        ConsistentRead: true,
        ScanIndexForward: query.order === 'asc',
        Limit: maximum + 1 - data.length,
        ...(key ? { ExclusiveStartKey: key } : {}),
      }));
      for (const item of page.Items ?? []) data.push(await this.hydrate<T>(item as ResourceIndex));
      key = page.LastEvaluatedKey as typeof key;
    } while (key && data.length <= maximum);
    return { data: data.slice(0, maximum), has_more: data.length > maximum };
  }

  public put<T>(resource: AgentResource<T>, expectedRevision: number): Promise<void> {
    return this.commit([{ resource, expectedRevision }]);
  }

  public async commit(writes: Array<{ resource: AgentResource<unknown>; expectedRevision: number }>): Promise<void> {
    if (writes.length === 0) return;
    await this.transact(await this.writeItems(writes));
  }

  private async writeItems(writes: Array<{ resource: AgentResource<unknown>; expectedRevision: number }>) {
    if (writes.length > 50) throw new Error('Agents storage transaction exceeds its item limit');
    const items: NonNullable<TransactWriteCommandInput['TransactItems']> = [];
    for (const { resource, expectedRevision } of writes) {
      if (resource.revision !== expectedRevision + 1) throw new Error('Invalid resource revision');
      const digest = hash(canonicalJson(resource.value));
      const reference = await this.objects.putJson(
        `owners/${hash(resource.ownerId)}/agents/${hash(resource.collection)}/${resource.id}/${digest}.json`,
        resource.value,
      );
      const index: ResourceIndex = {
        id: resource.id, ownerId: resource.ownerId, collection: resource.collection,
        createdAt: resource.createdAt, revision: resource.revision, reference,
        ...(resource.expiresAt ? { expiresAt: resource.expiresAt } : {}),
      };
      items.push({ Put: {
        TableName: this.tableName,
        Item: { ...rootKey(resource.ownerId, resource.collection, resource.id), ...index },
        ConditionExpression: expectedRevision === 0 ? 'attribute_not_exists(#revision)' : '#revision = :expected AND attribute_not_exists(deleted)',
        ExpressionAttributeNames: { '#revision': 'revision' },
        ...(expectedRevision ? { ExpressionAttributeValues: { ':expected': expectedRevision } } : {}),
      } }, { Put: {
        TableName: this.tableName,
        Item: { scope: listScope(resource.ownerId, resource.collection), key: orderKey(resource), ...index },
      } });
    }
    return items;
  }

  public async delete(resource: AgentResource<unknown>, writes: Array<{ resource: AgentResource<unknown>; expectedRevision: number }> = []): Promise<void> {
    if (writes.length > 49) throw new Error('Agents storage transaction exceeds its item limit');
    await this.transact([...await this.writeItems(writes), { Update: {
      TableName: this.tableName,
      Key: rootKey(resource.ownerId, resource.collection, resource.id),
      UpdateExpression: 'SET deleted = :deleted, #revision = :next',
      ConditionExpression: '#revision = :expected AND attribute_not_exists(deleted)',
      ExpressionAttributeNames: { '#revision': 'revision' },
      ExpressionAttributeValues: { ':expected': resource.revision, ':next': resource.revision + 1, ':deleted': true },
    } }, { Delete: {
      TableName: this.tableName,
      Key: { scope: listScope(resource.ownerId, resource.collection), key: orderKey(resource) },
    } }]);
  }

  private async transact(items: NonNullable<TransactWriteCommandInput['TransactItems']>) {
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: items }));
    } catch (error) {
      const conditional = error instanceof Error &&
        (error.name === 'ConditionalCheckFailedException' ||
          (error.name === 'TransactionCanceledException' &&
            'CancellationReasons' in error && Array.isArray(error.CancellationReasons) &&
            error.CancellationReasons.some((reason: { Code?: string }) => reason.Code === 'ConditionalCheckFailed')));
      if (conditional) throw new AgentsApiError(409, 'Resource changed concurrently. Retry the request.', 'conflict');
      throw error;
    }
  }

  private async index(ownerId: string, collection: string, id: string): Promise<ResourceIndex | undefined> {
    const response = await this.client.send(new GetCommand({
      TableName: this.tableName, Key: rootKey(ownerId, collection, id), ConsistentRead: true,
    }));
    return response.Item as ResourceIndex | undefined;
  }

  private async hydrate<T>(index: ResourceIndex): Promise<AgentResource<T>> {
    return {
      id: index.id, ownerId: index.ownerId, collection: index.collection,
      revision: index.revision, createdAt: index.createdAt,
      ...(index.expiresAt !== undefined ? { expiresAt: index.expiresAt } : {}),
      value: await this.objects.getJson<T>(index.reference),
    };
  }
}

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function listScope(ownerId: string, collection: string): string { return `list:${hash(ownerId)}:${hash(collection)}`; }
function rootKey(ownerId: string, collection: string, id: string) {
  return { scope: `resource:${hash(ownerId)}:${hash(collection)}:${id}`, key: 'root' };
}
function orderKey(resource: Pick<ResourceIndex, 'id' | 'createdAt'>): string {
  return `${String(resource.createdAt).padStart(16, '0')}:${resource.id}`;
}
