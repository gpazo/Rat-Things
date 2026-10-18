import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable';
import { createAwsClients, S3ArtifactStore } from '../../src/adapters/aws-runtime.js';
import { DynamoAgentsStore } from '../../src/adapters/dynamo-agents-store.js';
import { SessionRuntimeStore } from '../../src/core/session-runtime-store.js';
import { nativeLease } from '../../src/core/session-native-store.js';
import { openPiStorage } from '../../src/runner/pi/storage.js';

const integration = process.env.LOCALSTACK_E2E === 'true' ? describe : describe.skip;
integration('Pi native S3 and DynamoDB durability', () => {
  it('reconciles lost commit acknowledgements, retains unused reservations and fences old owners', async () => {
    const clients = createAwsClients();
    const owner = `pi-test:${randomUUID()}`;
    const store = new DynamoAgentsStore(clients.dynamodb, process.env.AGENTS_TABLE_NAME!, new S3ArtifactStore(clients.s3, process.env.DEFINITION_BUCKET!));
    const runtime = new SessionRuntimeStore(store);
    await runtime.claim(owner, 'session', 'first', 1);
    const lease = nativeLease(store, owner, 'session', 'first', 0);
    const storage = await openPiStorage(lease);
    expect(await storage.mintId()).toBe(2);
    const commit = store.commit.bind(store);
    let lose = true;
    store.commit = async writes => { await commit(writes); if (lose) { lose = false; throw new Error('Lost commit acknowledgement'); } };
    await storage.commit([{ type: 'conversation', value: { id: ROOT_CONVERSATION_ID } }], context);
    expect((await lease.load()).commits).toHaveLength(1);
    await runtime.claim(owner, 'session', 'second', 2, await runtime.get(owner, 'session'));
    const replacement = nativeLease(store, owner, 'session', 'second', 1);
    const reopened = await openPiStorage(replacement);
    expect(await reopened.conversation(ROOT_CONVERSATION_ID, context)).toEqual({ id: 1 });
    expect(await reopened.mintId()).toBe(258);
    await expect(lease.assertActive()).rejects.toThrow('ownership');
    await runtime.close(owner, 'session');
    await expect(replacement.reserveIds(10, 'late')).rejects.toThrow('ownership');
  });
});
