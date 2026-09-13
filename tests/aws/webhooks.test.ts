import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { expect, it } from 'vitest';
import { createAgentsClient } from '../../src/agents-client.js';
import type { WebhookEndpoint } from '../../src/domain/session-webhooks.js';

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

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the disposable webhook proof`);
  return value;
}
