import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { beforeEach, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({ listSubscriptions: vi.fn(), subscription: vi.fn(), release: vi.fn() }));
vi.mock('../../src/app/composition.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/app/composition.js')>(),
  getSessionIntegrationService: () => f,
}));
const { handler } = await import('../../src/lambdas/control.js');
const owner = 'arn:aws:iam::000000000000:user/operator';

beforeEach(() => { vi.resetAllMocks(); });

async function request(path: string, method = 'GET', body?: unknown, query?: Record<string, string>) {
  const event: APIGatewayProxyEventV2 = { version: '2.0', routeKey: `${method} ${path}`, rawPath: path, rawQueryString: '', headers: {}, isBase64Encoded: false,
    ...(body ? { body: JSON.stringify(body) } : {}), ...(query ? { queryStringParameters: query } : {}),
    requestContext: { requestId: 'request', accountId: '000000000000', apiId: 'test', domainName: 'example.test', domainPrefix: 'example', routeKey: `${method} ${path}`, stage: '$default', time: '2026-11-01T00:00:00Z', timeEpoch: 1793491200000,
      http: { method, path, protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'vitest' } },
  };
  Object.assign(event.requestContext, { authorizer: { iam: { userArn: owner } } });
  return await (handler as (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyStructuredResultV2>)(event);
}

it('scopes subscription listing and retrieval to the authenticated operator', async () => {
  f.listSubscriptions.mockResolvedValue({ object: 'list', data: [{ id: 'thread', epoch: 1 }], has_more: true });
  f.subscription.mockResolvedValue({ id: 'thread', epoch: 1 });
  expect((await request('/v1/integrations/thread-subscriptions', 'GET', undefined, { after: 'previous', limit: '3' })).statusCode).toBe(200);
  expect(f.listSubscriptions).toHaveBeenCalledWith(`api:${owner}`, { after: 'previous', limit: 3 });
  expect((await request('/v1/integrations/thread-subscriptions/thread')).statusCode).toBe(200);
  expect(f.subscription).toHaveBeenCalledWith(`api:${owner}`, 'thread');
});

it('requires an epoch before dispatching an operator release', async () => {
  f.release.mockResolvedValue({ id: 'thread', sessionId: 'sess_current', released: true });
  expect((await request('/v1/integrations/thread-subscriptions/thread/release', 'POST', { reason: 'Done', epoch: 2 })).statusCode).toBe(200);
  expect(f.release).toHaveBeenCalledWith(`api:${owner}`, 'thread', { reason: 'Done' }, undefined, 2);
  f.release.mockClear();
  for (const body of [{ reason: 'Done' }, { reason: 'Done', epoch: -1 }, { reason: 'Done', epoch: 0, ownerId: 'other' }]) {
    expect((await request('/v1/integrations/thread-subscriptions/thread/release', 'POST', body)).statusCode).toBe(400);
  }
  expect(f.release).not.toHaveBeenCalled();
});
