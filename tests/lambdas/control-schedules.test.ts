import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { afterAll, expect, it, vi } from 'vitest';
import type { AwsClients } from '../../src/adapters/aws-runtime.js';
import { MemoryAgentsStore } from '../agents/fixtures.js';

const denied = vi.hoisted(() => vi.fn(async () => { throw new Error('Control administration attempted a downstream effect'); }));
vi.mock('../../src/adapters/aws-runtime.js', async (original) => ({
  ...await original<typeof import('../../src/adapters/aws-runtime.js')>(),
  createAwsClients: () => Object.fromEntries(['s3', 'secrets', 'scheduler', 'dynamodb', 'sqs', 'events'].map(name => [name, { send: denied }])) as unknown as AwsClients,
}));
vi.mock('../../src/adapters/dynamo-agents-store.js', () => ({ DynamoAgentsStore: MemoryAgentsStore }));

afterAll(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it('administers schedule definitions through the real control composition without delivery, secret reads or Scheduler effects', async () => {
  for (const [name, value] of Object.entries({
    AWS_REGION: 'us-west-2', RUNS_TABLE_NAME: 'runs', INTEGRATIONS_TABLE_NAME: 'integrations', AGENTS_TABLE_NAME: 'agents',
    ARTIFACT_BUCKET: 'artifacts', DEFINITION_BUCKET: 'definitions', RUN_QUEUE_URL: 'https://sqs.example.test/runs', EVENT_BUS_NAME: 'events',
    INTEGRATION_CREDENTIAL_NAME_PREFIX: 'test', INTEGRATION_CREDENTIAL_KMS_KEY_ARN: 'test-key',
    THING_SCHEDULE_GROUP_NAME: 'schedules', THING_SCHEDULE_TARGET_ARN: 'test-target', THING_SCHEDULE_ROLE_ARN: 'test-role',
    GITHUB_NOTIFY_TOKEN_SECRET_ARN: 'test-notify-secret', SLACK_BOT_TOKEN_SECRET_ARN: 'test-slack-secret',
    THING_SCHEDULER_MODE: 'eventbridge', S3_FILES_ENABLED: 'false', EC2_LAUNCH_TEMPLATE_ID: '',
  })) vi.stubEnv(name, value);
  vi.stubGlobal('fetch', denied);
  const { handler } = await import('../../src/lambdas/control.js');
  const { principal } = await import('../../src/lambdas/runtime.js');
  const { getAgentsApiServices, getScheduleService } = await import('../../src/app/composition.js');
  const invoke = async (method: string, path: string, body?: unknown) => {
    const result = await (handler as (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyStructuredResultV2>)(request(method, path, body));
    expect(result.statusCode, result.body).toBeLessThan(300);
    return JSON.parse(result.body ?? '{}') as Record<string, unknown>;
  };
  const owner = principal(request('POST', '/v1/schedules'));
  const agent = await getAgentsApiServices().agents.create(owner, { model: 'test' });
  const configuration = { agentId: agent.id, environment: { type: 'none' }, name: 'Test', expression: 'rate(1 day)', input: 'Check', destinations: [] };
  const schedule = await invoke('POST', '/v1/schedules', configuration);
  const path = `/v1/schedules/${schedule.id}`;
  expect((await invoke('GET', '/v1/schedules')).data).toEqual([schedule]);
  expect(await invoke('GET', path)).toEqual(schedule);
  expect(await invoke('PUT', path, { ...configuration, input: 'Changed' })).toMatchObject({ generation: 2, input: 'Changed' });
  expect(await invoke('POST', `${path}/pause`)).toMatchObject({ status: 'paused' });
  expect(await invoke('POST', `${path}/resume`)).toMatchObject({ status: 'active' });
  expect(await invoke('DELETE', path)).toMatchObject({ status: 'deleted' });
  expect(denied).not.toHaveBeenCalled();
  // Prove the guard is connected: the outbox-only entry point does reach Scheduler.
  await expect(getScheduleService().synchronize(owner, String(schedule.id))).rejects.toThrow('downstream effect');
  expect(denied).toHaveBeenCalledOnce();
});

function request(method: string, path: string, body?: unknown): APIGatewayProxyEventV2 {
  const event: APIGatewayProxyEventV2 = {
    version: '2.0', routeKey: `${method} ${path}`, rawPath: path, rawQueryString: '', headers: {}, isBase64Encoded: false,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    requestContext: {
      accountId: '000000000000', apiId: 'test', domainName: 'example.test', domainPrefix: 'example', requestId: 'test', stage: '$default', routeKey: `${method} ${path}`,
      time: '24/Sep/2026:00:00:00 +0000', timeEpoch: 1,
      http: { method, path, protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
    },
  };
  Object.assign(event.requestContext, { authorizer: { iam: { userArn: 'arn:aws:iam::000000000000:user/test' } } });
  return event;
}
