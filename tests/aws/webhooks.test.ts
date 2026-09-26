import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { expect, it } from 'vitest';
import { createAgentsClient } from '../../src/agents-client.js';
import type { WebhookDelivery, WebhookEndpoint } from '../../src/domain/session-webhooks.js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { DynamoAgentsStore } from '../../src/adapters/dynamo-agents-store.js';
import { S3ArtifactStore } from '../../src/adapters/aws-runtime.js';
import { setTimeout as delay } from 'node:timers/promises';

const live = process.env.AWS_E2E === 'true' && process.env.AWS_E2E_WEBHOOK_CAPTURE_URL ? it : it.skip;

live('delivers a committed Session event to the deployment-owned webhook capture', async () => {
  if (process.env.AWS_E2E_REAL_CODEX !== 'true') throw new Error('Live AWS mutation requires explicit opt-in');
  const region = required('AWS_REGION');
  const client = createAgentsClient({ baseURL: required('RAT_THINGS_AGENTS_API_URL'), region }).withOptions({ maxRetries: 0 });
  const sqs = new SQSClient({ region });
  const queueUrl = required('DELIVERY_CAPTURE_QUEUE_URL');
  const endpoint = await client.post<WebhookEndpoint & { signing_secret: string }>('/webhooks', { body: {
    name: 'Disposable Session event proof', url: required('AWS_E2E_WEBHOOK_CAPTURE_URL'), events: ['agent.session.created'],
  } });
  let sessionId: string | undefined;
  try {
    expect(typeof endpoint.signing_secret).toBe('string');
    const retrieved = await client.get<WebhookEndpoint>(`/webhooks/${endpoint.id}`);
    expect(Object.hasOwn(retrieved, 'signing_secret')).toBe(false);
    // A disconnected environment with no input needs no harness or model call.
    const session = await client.beta.agents.sessions.create({
      agent: { model: required('AWS_E2E_CODEX_MODEL_ID'), tools: [] },
      environment: { type: 'self_hosted', workspace_directory: '/workspace' },
    });
    sessionId = session.id;
    let captured: unknown;
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline && captured === undefined) {
      const page = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 5, VisibilityTimeout: 15 }));
      for (const message of page.Messages ?? []) {
        const event = JSON.parse(message.Body ?? '{}') as { type?: string; data?: { id?: string } };
        if (event.type !== 'agent.session.created' || event.data?.id !== session.id) continue;
        captured = event;
        await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle! }));
      }
    }
    expect(captured).toMatchObject({ object: 'event', type: 'agent.session.created', data: { id: session.id } });
  } finally {
    try { if (sessionId) await client.beta.agents.sessions.delete(sessionId); }
    finally {
      try { await client.delete(`/webhooks/${endpoint.id}`); }
      finally { sqs.destroy(); }
    }
  }
}, 180_000);

live('retries a rejected webhook independently of another endpoint and retains its event identity', async () => {
  if (process.env.AWS_E2E_REAL_CODEX !== 'true') throw new Error('Live AWS mutation requires explicit opt-in');
  const region = required('AWS_REGION');
  const fixture = new URL(required('INTEGRATION_FIXTURE_URL'));
  if (fixture.protocol !== 'https:' || !fixture.hostname.endsWith(`.lambda-url.${region}.on.aws`)) throw new Error('Use the deployment-owned rejecting fixture');
  const client = createAgentsClient({ baseURL: required('RAT_THINGS_AGENTS_API_URL'), region }).withOptions({ maxRetries: 0 });
  const sqs = new SQSClient({ region });
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  const s3 = new S3Client({ region });
  const objects = new S3ArtifactStore(s3, required('DEFINITION_BUCKET'));
  const store = new DynamoAgentsStore(db, `rat-things-${required('AWS_E2E_DEPLOYMENT_ID')}-agents`, {
    getJson: reference => objects.getJson(reference), putJson: async () => { throw new Error('The webhook proof may only observe private delivery records'); },
  });
  const endpoints: string[] = [];
  let sessionId: string | undefined;
  const startedAt = Math.floor(Date.now() / 1000);
  try {
    // The fixture requires its own bearer token; webhook signatures alone get 401.
    const retry = await client.post<WebhookEndpoint>('/webhooks', { body: { name: 'Disposable retry proof', url: new URL('/me', fixture).href, events: ['agent.session.created'] } });
    endpoints.push(retry.id);
    const ready = await client.post<WebhookEndpoint>('/webhooks', { body: { name: 'Disposable fanout proof', url: required('AWS_E2E_WEBHOOK_CAPTURE_URL'), events: ['agent.session.created'] } });
    endpoints.push(ready.id);
    const session = await client.beta.agents.sessions.create({ agent: { model: required('AWS_E2E_CODEX_MODEL_ID'), tools: [] },
      environment: { type: 'self_hosted', workspace_directory: '/workspace' } });
    sessionId = session.id;
    let rejected: WebhookDelivery | undefined;
    await waitFor(async () => {
      const deliveries = await readDeliveries();
      rejected = deliveries.find(value => value.endpointId === retry.id && value.lastStatus === 401 && value.attempts >= 1);
      return Boolean(rejected && deliveries.some(value => value.endpointId === ready.id && value.status === 'delivered'));
    });
    const original = rejected!;
    expect(original.status).toBe('pending');
    await client.post(`/webhooks/${retry.id}`, { body: { url: required('AWS_E2E_WEBHOOK_CAPTURE_URL') } });
    let final: WebhookDelivery[] = [];
    await waitFor(async () => { final = await readDeliveries(); return final.length === 2 && final.every(value => value.status === 'delivered'); });
    const recovered = final.find(value => value.endpointId === retry.id)!;
    expect(recovered.webhookId).toBe(original.webhookId);
    expect(recovered.event).toEqual(original.event);
    expect(recovered.attempts).toBeGreaterThan(original.attempts);
    expect(new Set(final.map(value => value.webhookId)).size).toBe(2);
    expect(new Set(final.map(value => value.event.id)).size).toBe(1);
    let captured = 0;
    await waitFor(async () => {
      const page = await sqs.send(new ReceiveMessageCommand({ QueueUrl: required('DELIVERY_CAPTURE_QUEUE_URL'), MaxNumberOfMessages: 10, WaitTimeSeconds: 5, VisibilityTimeout: 10 }));
      for (const message of page.Messages ?? []) {
        const event = JSON.parse(message.Body ?? '{}') as { id?: string; data?: { id?: string } };
        if (event.id !== original.event.id || event.data?.id !== session.id) continue;
        captured++;
        await sqs.send(new DeleteMessageCommand({ QueueUrl: required('DELIVERY_CAPTURE_QUEUE_URL'), ReceiptHandle: message.ReceiptHandle! }));
      }
      return captured >= 2;
    });
    console.log(JSON.stringify({ webhookRetrySession: session.id, retryAttempts: recovered.attempts, deliveredEndpoints: final.length }));
  } finally {
    const cleanup = await Promise.allSettled([
      ...(sessionId ? [client.beta.agents.sessions.delete(sessionId)] : []), ...endpoints.map(id => client.delete(`/webhooks/${id}`)),
    ]);
    sqs.destroy(); db.destroy(); s3.destroy();
    const failures = cleanup.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, 'Disposable webhook proof cleanup failed');
  }

  async function readDeliveries(): Promise<WebhookDelivery[]> {
    const values: WebhookDelivery[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await store.list<WebhookDelivery>(`api:${required('AWS_E2E_CALLER_ARN')}`, 'webhook_deliveries', { order: 'desc', limit: 100, ...(after ? { after } : {}) });
      values.push(...page.data.filter(({ value }) => endpoints.includes(value.endpointId) && value.event.data.id === sessionId).map(resource => resource.value));
      if (!page.has_more || page.data.some(value => value.createdAt < startedAt - 5)) return values;
      after = page.data.at(-1)!.id;
    }
  }
}, 420_000);

async function waitFor(predicate: () => Promise<boolean>) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(1000); }
  throw new Error('Webhook retry proof did not settle before its deadline');
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the disposable webhook proof`);
  return value;
}
