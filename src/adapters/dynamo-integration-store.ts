import { createHash } from 'node:crypto';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import type { IntegrationCredentialBinding } from '../credentials/types.js';
import {
  validateConnectionGrant,
  validateConnectionSet,
  validateIntegrationConnection,
  validateSourceCapabilityBinding,
  type ConnectionGrant,
  type ConnectionSet,
  type IntegrationConnection,
  type SourceCapabilityBinding,
} from '../domain/capabilities.js';
import type { IntegrationStore } from '../plugins/integration-types.js';

export class DynamoIntegrationStore implements IntegrationStore {
  public constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  public async listConnections(ownerId: string): Promise<IntegrationConnection[]> {
    return (await this.query<IntegrationConnection>(ownerId, 'CONNECTION#'))
      .map((value) => validateIntegrationConnection(value));
  }

  public async getConnection(
    ownerId: string,
    connectionIdOrAlias: string,
  ): Promise<IntegrationConnection | undefined> {
    const direct = await this.get<IntegrationConnection>(ownerId, `CONNECTION#${connectionIdOrAlias}`);
    if (direct) return validateIntegrationConnection(direct);
    const alias = await this.get<{ connectionId: string }>(ownerId, `ALIAS#${connectionIdOrAlias}`);
    if (!alias) return undefined;
    const connection = await this.get<IntegrationConnection>(ownerId, `CONNECTION#${alias.connectionId}`);
    return connection ? validateIntegrationConnection(connection) : undefined;
  }

  public async putConnection(connection: IntegrationConnection): Promise<void> {
    validateIntegrationConnection(connection);
    await this.client.send(new TransactWriteCommand({
      TransactItems: [
        putItem(this.tableName, connection.ownerId, `CONNECTION#${connection.connectionId}`, connection),
        aliasItem(this.tableName, connection.ownerId, connection.alias, connection.connectionId),
      ],
    }));
  }

  public async putConnectionBundle(
    connection: IntegrationConnection,
    binding: IntegrationCredentialBinding,
    grant: ConnectionGrant,
  ): Promise<void> {
    validateIntegrationConnection(connection);
    validateCredentialBinding(binding);
    validateConnectionGrant(grant);
    if (
      connection.ownerId !== binding.ownerId ||
      connection.ownerId !== grant.ownerId ||
      connection.connectionId !== binding.connectionId ||
      connection.connectionId !== grant.connectionId
    ) throw new Error('connection bundle identities do not match');
    await this.client.send(new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            ...putItem(
              this.tableName,
              connection.ownerId,
              `CONNECTION#${connection.connectionId}`,
              connection,
            ).Put,
            ConditionExpression: 'attribute_not_exists(pk)',
          },
        },
        aliasItem(this.tableName, connection.ownerId, connection.alias, connection.connectionId, true),
        {
          Put: {
            ...putItem(
              this.tableName,
              connection.ownerId,
              `CREDENTIAL#${connection.connectionId}`,
              binding,
            ).Put,
            ConditionExpression: 'attribute_not_exists(pk)',
          },
        },
        {
          Put: {
            ...putItem(
              this.tableName,
              connection.ownerId,
              `GRANT#${connection.connectionId}`,
              grant,
            ).Put,
            ConditionExpression: 'attribute_not_exists(pk)',
          },
        },
      ],
    }));
  }

  public async putCredentialBinding(binding: IntegrationCredentialBinding): Promise<void> {
    validateCredentialBinding(binding);
    await this.client.send(new PutCommand(putItemInput(
      this.tableName,
      binding.ownerId,
      `CREDENTIAL#${binding.connectionId}`,
      binding,
    )));
  }

  public async getCredentialBinding(
    ownerId: string,
    connectionId: string,
  ): Promise<IntegrationCredentialBinding | undefined> {
    const binding = await this.get<IntegrationCredentialBinding>(ownerId, `CREDENTIAL#${connectionId}`);
    return binding ? validateCredentialBinding(binding) : undefined;
  }

  public async putGrant(grant: ConnectionGrant): Promise<void> {
    validateConnectionGrant(grant);
    await this.client.send(new PutCommand(putItemInput(
      this.tableName,
      grant.ownerId,
      `GRANT#${grant.connectionId}`,
      grant,
    )));
  }

  public async getGrant(ownerId: string, connectionId: string): Promise<ConnectionGrant | undefined> {
    const grant = await this.get<ConnectionGrant>(ownerId, `GRANT#${connectionId}`);
    return grant ? validateConnectionGrant(grant) : undefined;
  }

  public async putConnectionSet(connectionSet: ConnectionSet): Promise<void> {
    validateConnectionSet(connectionSet);
    await this.client.send(new TransactWriteCommand({
      TransactItems: [
        putItem(
          this.tableName,
          connectionSet.ownerId,
          `SET#${connectionSet.connectionSetId}`,
          connectionSet,
        ),
        {
          Put: {
            ...putItem(
              this.tableName,
              connectionSet.ownerId,
              `SET_NAME#${connectionSet.name}`,
              { connectionSetId: connectionSet.connectionSetId },
            ).Put,
            ConditionExpression: 'attribute_not_exists(pk) OR #value.#id = :id',
            ExpressionAttributeNames: { '#value': 'value', '#id': 'connectionSetId' },
            ExpressionAttributeValues: { ':id': connectionSet.connectionSetId },
          },
        },
      ],
    }));
  }

  public async getConnectionSet(ownerId: string, idOrName: string): Promise<ConnectionSet | undefined> {
    const direct = await this.get<ConnectionSet>(ownerId, `SET#${idOrName}`);
    if (direct) return validateConnectionSet(direct);
    const named = await this.get<{ connectionSetId: string }>(ownerId, `SET_NAME#${idOrName}`);
    if (!named) return undefined;
    const set = await this.get<ConnectionSet>(ownerId, `SET#${named.connectionSetId}`);
    return set ? validateConnectionSet(set) : undefined;
  }

  public async listConnectionSets(ownerId: string): Promise<ConnectionSet[]> {
    return (await this.query<ConnectionSet>(ownerId, 'SET#'))
      .map((value) => validateConnectionSet(value));
  }

  public async putSourceBinding(binding: SourceCapabilityBinding): Promise<void> {
    validateSourceCapabilityBinding(binding);
    const selectorClaim = JSON.stringify(
      Object.entries(binding.selector).sort(([a], [b]) => a.localeCompare(b)),
    );
    const claim = createHash('sha256')
      // API sources carry no cross-owner provider installation identity, so
      // their exact-selector uniqueness boundary is the authenticated owner.
      .update(binding.sourceKind === 'api' ? `${binding.ownerId}\0${selectorClaim}` : selectorClaim)
      .digest('hex');
    const globalPk = `SOURCE#${binding.sourceKind}`;
    await this.client.send(new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            ...putItemInput(
              this.tableName,
              binding.ownerId,
              `SOURCE#${binding.bindingId}`,
              binding,
            ),
            ConditionExpression: 'attribute_not_exists(pk)',
          },
        },
        {
          Put: {
            TableName: this.tableName,
            Item: {
              pk: globalPk,
              sk: `BINDING#${binding.bindingId}`,
              value: binding,
            },
            ConditionExpression: 'attribute_not_exists(pk)',
          },
        },
        {
          Put: {
            TableName: this.tableName,
            Item: {
              pk: globalPk,
              sk: `CLAIM#${claim}`,
              value: { bindingId: binding.bindingId, ownerId: binding.ownerId },
            },
            ConditionExpression: 'attribute_not_exists(pk)',
          },
        },
      ],
    }));
  }

  public async listSourceBindings(ownerId: string): Promise<SourceCapabilityBinding[]> {
    return (await this.query<SourceCapabilityBinding>(ownerId, 'SOURCE#'))
      .map((value) => validateSourceCapabilityBinding(value));
  }

  public async matchingSourceBindings(
    sourceKind: SourceCapabilityBinding['sourceKind'],
  ): Promise<SourceCapabilityBinding[]> {
    const result = await this.client.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': `SOURCE#${sourceKind}`, ':prefix': 'BINDING#' },
      ConsistentRead: true,
    }));
    return (result.Items ?? []).map((item) => (
      validateSourceCapabilityBinding(item.value as SourceCapabilityBinding)
    ));
  }

  private async get<T>(ownerId: string, sk: string): Promise<T | undefined> {
    const result = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: { pk: ownerKey(ownerId), sk },
      ConsistentRead: true,
    }));
    return result.Item?.value as T | undefined;
  }

  private async query<T>(ownerId: string, prefix: string): Promise<T[]> {
    const result = await this.client.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': ownerKey(ownerId), ':prefix': prefix },
      ConsistentRead: true,
    }));
    return (result.Items ?? []).map((item) => item.value as T);
  }
}

function ownerKey(ownerId: string): string {
  return `OWNER#${createHash('sha256').update(ownerId).digest('hex')}`;
}

function putItem(tableName: string, ownerId: string, sk: string, value: unknown) {
  return { Put: putItemInput(tableName, ownerId, sk, value) };
}

function putItemInput(tableName: string, ownerId: string, sk: string, value: unknown) {
  return { TableName: tableName, Item: { pk: ownerKey(ownerId), sk, value } };
}

function aliasItem(
  tableName: string,
  ownerId: string,
  alias: string,
  connectionId: string,
  createOnly = false,
) {
  return {
    Put: {
      ...putItemInput(tableName, ownerId, `ALIAS#${alias}`, { connectionId }),
      ConditionExpression: createOnly
        ? 'attribute_not_exists(pk)'
        : 'attribute_not_exists(pk) OR #value.#connection = :connection',
      ...(createOnly ? {} : {
        ExpressionAttributeNames: { '#value': 'value', '#connection': 'connectionId' },
        ExpressionAttributeValues: { ':connection': connectionId },
      }),
    },
  };
}

function validateCredentialBinding(
  value: IntegrationCredentialBinding,
): IntegrationCredentialBinding {
  if (value.version !== '1') throw new Error('credential binding version is invalid');
  for (const [label, candidate] of [
    ['credential owner', value.ownerId],
    ['credential connection ID', value.connectionId],
    ['credential reference', value.reference],
  ] as const) {
    if (typeof candidate !== 'string' || !candidate || candidate.length > 2_048) {
      throw new Error(`${label} is invalid`);
    }
  }
  if (!Number.isFinite(Date.parse(value.createdAt)) || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw new Error('credential binding timestamps are invalid');
  }
  return structuredClone(value);
}
