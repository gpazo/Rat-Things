import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { AwsClients } from '../../src/adapters/aws-runtime.js';
import type { SessionIntegrationInput } from '../../src/domain/session-integrations.js';
import { MemoryAgentsStore } from '../agents/fixtures.js';

const effects = vi.hoisted(() => ({
  denied: vi.fn(async () => { throw new Error('Ingress attempted an execution or delivery effect'); }),
  secrets: vi.fn(async () => ({ SecretString: 'test-signing-secret' })),
}));
vi.mock('../../src/adapters/aws-runtime.js', async (original) => ({
  ...await original<typeof import('../../src/adapters/aws-runtime.js')>(),
  createAwsClients: () => ({
    ...Object.fromEntries(['s3', 'scheduler', 'dynamodb', 'sqs', 'events'].map(name => [name, { send: effects.denied }])),
    secrets: { send: effects.secrets },
  }) as unknown as AwsClients,
}));
vi.mock('../../src/adapters/dynamo-agents-store.js', () => ({ DynamoAgentsStore: MemoryAgentsStore }));

beforeAll(() => {
  for (const [name, value] of Object.entries({
    AWS_REGION: 'us-west-2', RUNS_TABLE_NAME: 'runs', INTEGRATIONS_TABLE_NAME: 'integrations', AGENTS_TABLE_NAME: 'agents',
    ARTIFACT_BUCKET: 'artifacts', DEFINITION_BUCKET: 'definitions', RUN_QUEUE_URL: 'https://sqs.example.test/runs',
    INTEGRATION_CREDENTIAL_NAME_PREFIX: 'test', INTEGRATION_CREDENTIAL_KMS_KEY_ARN: 'test-key',
    GITHUB_WEBHOOK_SECRET_ARN: 'test-github-signing-secret', SLACK_SIGNING_SECRET_ARN: 'test-slack-signing-secret',
    SESSION_CHECKPOINTS_ENABLED: 'true', S3_FILES_ENABLED: 'true',
    S3_FILES_FILE_SYSTEM_ID: undefined, S3_FILES_ACCESS_POINT_ID: undefined, S3_FILES_MOUNT_TARGET_IP: undefined,
    EC2_LAUNCH_TEMPLATE_ID: undefined, EVENT_FILTER_MODEL_ID: undefined,
  })) vi.stubEnv(name, value);
  vi.stubGlobal('fetch', effects.denied);
});
afterAll(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it.each(['github', 'slack'] as const)('rejects an invalid %s signature through the real ingress composition without worker configuration', async provider => {
  const { handler } = provider === 'github'
    ? await import('../../src/lambdas/webhook-github.js')
    : await import('../../src/lambdas/webhook-slack.js');
  const result = await (handler as (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyStructuredResultV2>)(request(provider));
  expect(result.statusCode).toBe(401);
  expect(JSON.parse(result.body ?? '{}')).toMatchObject({ error: { code: 'invalid_signature' } });
  expect(effects.secrets).toHaveBeenCalledWith(expect.objectContaining({ input: { SecretId: `test-${provider}-signing-secret` } }));
  expect(effects.denied).not.toHaveBeenCalled();
});

it('accepts and replays durable ingress receipts and reads subscriptions without worker configuration', async () => {
  const { getSessionIntegrationService, getAgentsApiServices } = await import('../../src/app/composition.js');
  const integrations = getSessionIntegrationService();
  const target = { agentId: 'agent_test', environment: { type: 'none' as const } };
  const input: SessionIntegrationInput = {
    id: 'slack:event-1', text: 'Check this thread',
    source: { kind: 'slack', teamId: 'team', channelId: 'channel', userId: 'user', eventId: 'event-1', threadTs: '1.0' },
    actor: { kind: 'human', provider: 'slack', id: 'slack:team:user' },
    credentialSubject: { kind: 'runtime', id: 'runtime:slack' },
  };
  expect(await integrations.hasActiveSubscription('operator', 'binding', 'thread')).toBe(false);
  const accepted = await integrations.accept('operator', 'binding', 'thread', target, input);
  expect(await integrations.accept('operator', 'binding', 'thread', target, input)).toEqual(accepted);
  expect(await integrations.hasActiveSubscription('operator', 'binding', 'thread')).toBe(true);
  const subscriptions = await integrations.listSubscriptions('operator');
  expect(subscriptions.data).toHaveLength(1);
  expect(await integrations.subscription('operator', subscriptions.data[0]!.id)).toMatchObject({
    subscribers: [{ sessionId: accepted.sessionId, state: 'active' }],
  });
  expect((await getAgentsApiServices().store.list('operator', 'integration_occurrences', {})).data).toHaveLength(1);
  expect((await getAgentsApiServices().store.list('operator', 'sessions', {})).data).toEqual([]);
  expect(effects.denied).not.toHaveBeenCalled();
});

function request(provider: string): APIGatewayProxyEventV2 {
  const path = `/webhooks/${provider}`;
  return {
    version: '2.0', routeKey: `POST ${path}`, rawPath: path, rawQueryString: '',
    headers: {
      'x-hub-signature-256': 'sha256=invalid',
      'x-slack-signature': 'v0=invalid',
      'x-slack-request-timestamp': String(Math.floor(Date.now() / 1000)),
    },
    body: 'not JSON', isBase64Encoded: false,
    requestContext: {
      accountId: '000000000000', apiId: 'test', domainName: 'example.test', domainPrefix: 'example', requestId: 'test', stage: '$default', routeKey: `POST ${path}`,
      time: '01/Nov/2026:00:00:00 +0000', timeEpoch: 1,
      http: { method: 'POST', path, protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
    },
  };
}
