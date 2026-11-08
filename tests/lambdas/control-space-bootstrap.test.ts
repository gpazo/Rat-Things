import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { afterEach, expect, it, vi } from 'vitest';
import { SpaceAccessService } from '../../src/identity/space-access.js';
import { MemoryAgentsStore } from '../agents/fixtures.js';

const fixture = vi.hoisted(() => ({ access: undefined as SpaceAccessService | undefined }));
vi.mock('../../src/app/composition.js', async original => ({
  ...await original<typeof import('../../src/app/composition.js')>(),
  getAgentsApiServices: () => ({ access: fixture.access }),
}));
afterEach(() => { vi.unstubAllEnvs(); });

it('bootstraps through API Gateway using IAM identity and ignores caller-supplied ownership headers', async () => {
  const store = new MemoryAgentsStore();
  fixture.access = new SpaceAccessService(store);
  const result = await invoke(true);
  expect(result.statusCode).toBe(201);
  expect(JSON.parse(result.body!)).toMatchObject({ name: 'Team', active: true });
  expect(store.resources.size).toBe(3);
});

it('rejects an unauthenticated space bootstrap without persisting a space', async () => {
  const store = new MemoryAgentsStore();
  fixture.access = new SpaceAccessService(store);
  expect((await invoke(false)).statusCode).toBe(401);
  expect(store.resources.size).toBe(0);
});

async function invoke(authenticated: boolean): Promise<APIGatewayProxyStructuredResultV2> {
  vi.stubEnv('ALLOW_OWNER_HEADER', 'false');
  const { handler } = await import('../../src/lambdas/control.js');
  const event = {
    version: '2.0', rawPath: '/v1/rat/spaces', rawQueryString: '',
    headers: { 'content-type': 'application/json', 'x-runtime-owner': 'forged', authorization: 'Bearer forged' },
    body: JSON.stringify({ name: 'Team', manager: { issuer: 'https://identity.example', subject: 'alice' } }),
    requestContext: { requestId: 'bootstrap', http: { method: 'POST' },
      ...(authenticated ? { authorizer: { iam: { userArn: 'arn:aws:iam::123456789012:user/operator' } } } : {}),
    },
  } as APIGatewayProxyEventV2;
  return await (handler as (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyStructuredResultV2>)(event);
}
