import { createHash } from 'node:crypto';
import {
  DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { AgentsApiError, AgentsResourceConflictError, invalid } from '../domain/agents-api-validation.js';
import type { ArtifactReference } from '../domain/contracts.js';
import { canonicalJson } from '../domain/json.js';
import type { AgentListOrdering, AgentListQuery, AgentObservation, AgentResource, AgentsStore } from '../core/agents-ports.js';
import type { ArtifactStore } from '../core/ports.js';
import { performanceCount } from '../core/performance.js';
import { measuredDynamo } from './aws-performance.js';
import { ImmutableHydrationCache, type HydrationCacheOptions } from './immutable-hydration-cache.js';

const listHydrationConcurrency = 4;

interface ResourceIndex {
  id: string;
  ownerId: string;
  collection: string;
  createdAt: number;
  listOrder?: AgentListOrdering;
  revision: number;
  expiresAt?: number;
  reference: ArtifactReference;
  deleted?: boolean;
}

/** Strongly consistent indexes; complete definitions and content stay in encrypted S3. */
export class DynamoAgentsStore implements AgentsStore {
  private readonly hydrationCache: ImmutableHydrationCache;
  public constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
    private readonly objects: Pick<ArtifactStore, 'putJson' | 'getJson'>,
    cacheOptions: HydrationCacheOptions = {},
  ) { this.hydrationCache = new ImmutableHydrationCache(cacheOptions); }

  public async get<T>(ownerId: string, collection: string, id: string): Promise<AgentResource<T> | undefined> {
    const index = await this.index(ownerId, collection, id);
    return index && !index.deleted ? this.hydrate<T>(index) : undefined;
  }

  public async list<T>(ownerId: string, collection: string, query: AgentListQuery) {
    performanceCount('StorageListCount');
    const cursor = query.after ? await this.index(ownerId, collection, query.after) : undefined;
    if (query.after && !cursor) invalid('Invalid pagination cursor', 'after');
    const indexes: ResourceIndex[] = [];
    const maximum = Math.min(query.limit ?? 20, 100);
    if (!Number.isInteger(maximum) || maximum < 1) invalid('limit must be a positive integer', 'limit');
    const scope = listScope(ownerId, collection);
    let key = cursor ? { scope, key: orderKey(cursor, query.orderBy) } : undefined;
    // Fetch one extra entry so has_more means another resource exists, including
    // across DynamoDB's byte-based pagination boundary.
    do {
      const page = await measuredDynamo(() => this.client.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: '#scope = :scope',
        ExpressionAttributeNames: { '#scope': 'scope' },
        ExpressionAttributeValues: { ':scope': scope },
        ConsistentRead: true,
        ReturnConsumedCapacity: 'TOTAL',
        ScanIndexForward: query.order === 'asc',
        Limit: maximum + 1 - indexes.length,
        ...(key ? { ExclusiveStartKey: key } : {}),
      })), 'read');
      indexes.push(...(page.Items ?? []) as ResourceIndex[]);
      key = page.LastEvaluatedKey as typeof key;
    } while (key && indexes.length <= maximum);

    const data: Array<AgentResource<T>> = [];
    const returned = indexes.slice(0, maximum);
    for (let start = 0; start < returned.length; start += listHydrationConcurrency) {
      const batch = returned.slice(start, start + listHydrationConcurrency);
      const hydrated = await Promise.allSettled(batch.map(index => this.hydrate<T>(index)));
      for (const result of hydrated) {
        if (result.status === 'rejected') throw result.reason;
        data.push(result.value);
      }
    }
    return { data, has_more: indexes.length > maximum };
  }

  public put<T>(resource: AgentResource<T>, expectedRevision: number): Promise<void> {
    return this.commit([{ resource, expectedRevision }]);
  }

  public async commit(writes: Array<{ resource: AgentResource<unknown>; expectedRevision: number }>, observations: AgentObservation[] = []): Promise<void> {
    if (writes.length === 0 && observations.length === 0) return;
    if (writes.length * 2 + observations.length > 100) throw new Error('Agents storage transaction exceeds its item limit');
    const items = await this.writeItems(writes);
    requireLiveObservations(observations);
    await this.transact([...items, ...observations.map(observation => ({ ConditionCheck: {
      TableName: this.tableName, Key: rootKey(observation.ownerId, observation.collection, observation.id),
      ConditionExpression: '#revision = :expected AND attribute_not_exists(deleted)',
      ExpressionAttributeNames: { '#revision': 'revision' }, ExpressionAttributeValues: { ':expected': observation.revision },
    } }))]);
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
        ...(resource.listOrder ? { listOrder: resource.listOrder } : {}),
        ...(resource.expiresAt ? { expiresAt: resource.expiresAt } : {}),
      };
      items.push({ Put: {
        TableName: this.tableName,
        Item: { ...rootKey(resource.ownerId, resource.collection, resource.id), ...index },
        ConditionExpression: expectedRevision === 0 ? 'attribute_not_exists(#revision)' : `#revision = :expected AND attribute_not_exists(deleted) AND ${fixedOrderCondition(resource)}`,
        ExpressionAttributeNames: { '#revision': 'revision', ...(expectedRevision ? { '#listOrder': 'listOrder' } : {}) },
        ...(expectedRevision ? { ExpressionAttributeValues: { ':expected': expectedRevision, ':listOrder': resource.listOrder ?? 'createdAt' } } : {}),
      } }, { Put: {
        TableName: this.tableName,
        Item: { scope: listScope(resource.ownerId, resource.collection), key: orderKey(resource), ...index },
      } });
    }
    return items;
  }

  public async delete(resource: AgentResource<unknown>, writes: Array<{ resource: AgentResource<unknown>; expectedRevision: number }> = [], observations: AgentObservation[] = []): Promise<void> {
    if (writes.length * 2 + observations.length + 2 > 100) throw new Error('Agents storage transaction exceeds its item limit');
    const items = await this.writeItems(writes);
    requireLiveObservations(observations);
    await this.transact([...items, { Update: {
      TableName: this.tableName,
      Key: rootKey(resource.ownerId, resource.collection, resource.id),
      UpdateExpression: 'SET deleted = :deleted, #revision = :next',
      ConditionExpression: `#revision = :expected AND attribute_not_exists(deleted) AND ${fixedOrderCondition(resource)}`,
      ExpressionAttributeNames: { '#revision': 'revision', '#listOrder': 'listOrder' },
      ExpressionAttributeValues: { ':expected': resource.revision, ':next': resource.revision + 1, ':deleted': true, ':listOrder': resource.listOrder ?? 'createdAt' },
    } }, { Delete: {
      TableName: this.tableName,
      Key: { scope: listScope(resource.ownerId, resource.collection), key: orderKey(resource) },
    } }, ...observations.map(observation => ({ ConditionCheck: {
      TableName: this.tableName, Key: rootKey(observation.ownerId, observation.collection, observation.id),
      ConditionExpression: '#revision = :expected AND attribute_not_exists(deleted)',
      ExpressionAttributeNames: { '#revision': 'revision' }, ExpressionAttributeValues: { ':expected': observation.revision },
    } }))]);
  }

  private async transact(items: NonNullable<TransactWriteCommandInput['TransactItems']>) {
    performanceCount('StorageTransactionCount');
    try {
      await measuredDynamo(() => this.client.send(new TransactWriteCommand({ TransactItems: items, ReturnConsumedCapacity: 'TOTAL' })), 'write');
    } catch (error) {
      if (confirmedContention(error)) throw new AgentsResourceConflictError();
      throw error;
    }
  }

  private async index(ownerId: string, collection: string, id: string): Promise<ResourceIndex | undefined> {
    performanceCount('StorageGetCount');
    const response = await measuredDynamo(() => this.client.send(new GetCommand({
      TableName: this.tableName, Key: rootKey(ownerId, collection, id), ConsistentRead: true, ReturnConsumedCapacity: 'TOTAL',
    })), 'read');
    return response.Item as ResourceIndex | undefined;
  }

  private async hydrate<T>(index: ResourceIndex): Promise<AgentResource<T>> {
    return {
      id: index.id, ownerId: index.ownerId, collection: index.collection,
      revision: index.revision, createdAt: index.createdAt,
      ...(index.listOrder ? { listOrder: index.listOrder } : {}),
      ...(index.expiresAt !== undefined ? { expiresAt: index.expiresAt } : {}),
      value: await (isWriterOwnedReference(index) ? this.hydrationCache.get(cacheKey(index.reference), () => this.objects.getJson<T>(index.reference)) : this.objects.getJson<T>(index.reference)),
    };
  }
}

/** Only confirmed aborted writes can enter the caller's compare-and-swap retry. */
function confirmedContention(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'ConditionalCheckFailedException' || error.name === 'TransactionConflictException') return true;
  if (error.name !== 'TransactionCanceledException' || !('CancellationReasons' in error) || !Array.isArray(error.CancellationReasons)) return false;
  const codes = error.CancellationReasons.map((reason: unknown) => typeof reason === 'object' && reason !== null && 'Code' in reason ? reason.Code : undefined);
  return codes.some(code => code === 'ConditionalCheckFailed' || code === 'TransactionConflict')
    && codes.every(code => code === 'None' || code === 'ConditionalCheckFailed' || code === 'TransactionConflict');
}

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function isWriterOwnedReference(index: ResourceIndex): boolean {
  if (typeof index.reference?.key !== 'string') return false;
  const prefix = `owners/${hash(index.ownerId)}/agents/${hash(index.collection)}/${index.id}/`;
  return index.reference.key.startsWith(prefix) && /^[a-f0-9]{64}\.json$/.test(index.reference.key.slice(prefix.length));
}
function cacheKey(reference: ArtifactReference): string { return JSON.stringify([reference.bucket, reference.key, reference.sha256]); }
function listScope(ownerId: string, collection: string): string { return `list:${hash(ownerId)}:${hash(collection)}`; }
function rootKey(ownerId: string, collection: string, id: string) {
  return { scope: `resource:${hash(ownerId)}:${hash(collection)}:${id}`, key: 'root' };
}
function orderKey(resource: Pick<ResourceIndex, 'id' | 'createdAt' | 'listOrder'>, order = resource.listOrder): string {
  // Keep ID-mode rows on the original zero-prefix index so pre-upgrade history
  // and its cursors remain interleaved without a migration or a second index.
  return `${String(order === 'id' ? 0 : resource.createdAt).padStart(16, '0')}:${resource.id}`;
}
function fixedOrderCondition(resource: Pick<ResourceIndex, 'listOrder'>): string {
  return resource.listOrder === 'id' ? '#listOrder = :listOrder' : '(attribute_not_exists(#listOrder) OR #listOrder = :listOrder)';
}

function requireLiveObservations(observations: AgentObservation[]) {
  if (observations.some(value => value.validUntil !== undefined && value.validUntil <= Date.now())) throw new AgentsApiError(401, 'Authority expired before acceptance.', 'invalid_api_key');
}
