import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CreateTableCommand, DeleteTableCommand, DescribeTableCommand, DynamoDBClient, waitUntilTableExists, waitUntilTableNotExists } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { CreateBucketCommand, DeleteBucketCommand, DeleteObjectsCommand, GetBucketEncryptionCommand, HeadBucketCommand, ListObjectsV2Command, PutBucketEncryptionCommand, PutBucketTaggingCommand, PutPublicAccessBlockCommand, S3Client } from '@aws-sdk/client-s3';
import { expect, it } from 'vitest';
import { DynamoAgentsStore } from '../../src/adapters/dynamo-agents-store.js';
import { S3ArtifactStore } from '../../src/adapters/aws-runtime.js';
import { exerciseWorkspaceHandoff } from '../helpers/workspace-handoff-proof.js';

const live = process.env.AWS_E2E === 'true' && process.env.AWS_E2E_CHECKPOINT_FOUNDATION === 'true' ? it : it.skip;

live('fences handoff claims and publishes independent snapshot records in real encrypted AWS storage', async () => {
  const account = process.env.AWS_E2E_CALLER_ACCOUNT;
  if (!account || !/^\d{12}$/.test(account)) throw new Error('Explicit expected AWS account is required');
  const region = process.env.AWS_REGION;
  if (!region || region === 'us-east-1') throw new Error('A non-us-east-1 test region is required');
  const identity = await promisify(execFile)('aws', ['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text'], { timeout: 30_000 });
  expect(identity.stdout.trim()).toBe(account);
  const name = `rat-checkpoint-proof-${randomUUID()}`;
  const db = new DynamoDBClient({ region });
  const s3 = new S3Client({ region });
  const evidenceDirectory = resolve('.aws-e2e', name);
  await mkdir(evidenceDirectory, { recursive: true });
  const proof: Record<string, unknown> = { name, region, account, startedAt: new Date().toISOString(), nativeWorkerReplacement: false, physicalSnapshotCopy: false };
  let table = false;
  let bucket = false;
  try {
    await db.send(new CreateTableCommand({ TableName: name, BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [{ AttributeName: 'scope', KeyType: 'HASH' }, { AttributeName: 'key', KeyType: 'RANGE' }],
      AttributeDefinitions: [{ AttributeName: 'scope', AttributeType: 'S' }, { AttributeName: 'key', AttributeType: 'S' }],
      SSESpecification: { Enabled: true }, Tags: [{ Key: 'Purpose', Value: 'checkpoint-foundation-proof' }] }));
    table = true;
    await s3.send(new CreateBucketCommand({ Bucket: name, CreateBucketConfiguration: { LocationConstraint: region as 'us-west-2' } }));
    bucket = true;
    await s3.send(new PutPublicAccessBlockCommand({ Bucket: name, PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true } }));
    await s3.send(new PutBucketEncryptionCommand({ Bucket: name, ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] } }));
    await s3.send(new PutBucketTaggingCommand({ Bucket: name, Tagging: { TagSet: [{ Key: 'Purpose', Value: 'checkpoint-foundation-proof' }] } }));
    await waitUntilTableExists({ client: db, maxWaitTime: 60, minDelay: 1, maxDelay: 3 }, { TableName: name });
    expect((await s3.send(new GetBucketEncryptionCommand({ Bucket: name }))).ServerSideEncryptionConfiguration?.Rules?.[0]?.ApplyServerSideEncryptionByDefault?.SSEAlgorithm).toBe('AES256');
    const store = new DynamoAgentsStore(DynamoDBDocumentClient.from(db), name, new S3ArtifactStore(s3, name));
    proof.result = await exerciseWorkspaceHandoff(store);
    proof.status = 'passed';
    console.log(JSON.stringify({ evidenceDirectory, ...proof }));
  } catch (error) {
    proof.status = 'failed';
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    if (bucket) {
      try {
        let page;
        do {
          page = await s3.send(new ListObjectsV2Command({ Bucket: name }));
          if (page.Contents?.length) {
            const deletion = await s3.send(new DeleteObjectsCommand({ Bucket: name, Delete: { Objects: page.Contents.map(object => ({ Key: object.Key! })) } }));
            if (deletion.Errors?.length) throw new Error('Test bucket cleanup failed');
          }
        } while (page.IsTruncated);
        await s3.send(new DeleteBucketCommand({ Bucket: name }));
        await expect(s3.send(new HeadBucketCommand({ Bucket: name }))).rejects.toMatchObject({ $metadata: { httpStatusCode: 404 } });
        proof.bucketDeleted = true;
      } catch (error) { cleanupErrors.push(error); }
    }
    if (table) {
      try {
        await db.send(new DeleteTableCommand({ TableName: name }));
        await waitUntilTableNotExists({ client: db, maxWaitTime: 60, minDelay: 1, maxDelay: 3 }, { TableName: name });
        await expect(db.send(new DescribeTableCommand({ TableName: name }))).rejects.toMatchObject({ name: 'ResourceNotFoundException' });
        proof.tableDeleted = true;
      } catch (error) { cleanupErrors.push(error); }
    }
    proof.finishedAt = new Date().toISOString();
    proof.cleanup = cleanupErrors.length ? 'failed' : 'completed';
    await writeFile(resolve(evidenceDirectory, 'proof.json'), `${JSON.stringify(proof, null, 2)}\n`);
    db.destroy(); s3.destroy();
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, `Cleanup required for ${name}`);
  }
}, 180_000);
