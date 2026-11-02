import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentsApiError } from '../../src/domain/agents-api-validation.js';

const update = vi.hoisted(() => vi.fn());
vi.mock('../../src/app/composition.js', async original => ({
  ...await original<typeof import('../../src/app/composition.js')>(),
  getConnectionService: () => ({ updateSourceEventPolicy: update }),
}));
afterEach(() => { vi.clearAllMocks(); });

it('updates only policy using the authenticated owner and preserves the existing binding response', async () => {
  const policy = { mode: 'explicit', actors: { allow: ['maintainer'] } };
  const binding = { bindingId: 'binding-1', selector: { repository: 'org/repo' }, eventPolicy: policy };
  update.mockResolvedValueOnce(binding);
  const result = await invoke({ version: '1', eventPolicy: policy });
  expect(result.statusCode).toBe(200);
  expect(JSON.parse(result.body!)).toEqual(binding);
  expect(update).toHaveBeenCalledExactlyOnceWith('api:arn:aws:iam::000000000000:user/test', 'binding-1', policy);
});

it.each([
  { version: '1', eventPolicy: { mode: 'explicit' }, ownerId: 'other' },
  { version: '1', eventPolicy: { mode: 'explicit' }, agentId: 'agent_other' },
  { version: '1', eventPolicy: { mode: 'candidate' } },
  { version: '1', eventPolicy: { mode: 'explicit', secret: 'value' } },
  { version: '1' },
])('rejects invalid or unrelated changes before the service call', async body => {
  expect((await invoke(body)).statusCode).toBe(400);
  expect(update).not.toHaveBeenCalled();
});

it.each([404, 409])('preserves status %i from policy administration', async status => {
  update.mockRejectedValueOnce(new AgentsApiError(status, 'policy update failed'));
  expect((await invoke({ version: '1', eventPolicy: { mode: 'ignore' } })).statusCode).toBe(status);
});

it('does not accept an unauthenticated policy update', async () => {
  expect((await invoke({ version: '1', eventPolicy: { mode: 'ignore' } }, false)).statusCode).toBe(403);
  expect(update).not.toHaveBeenCalled();
});

async function invoke(body: unknown, authenticated = true): Promise<APIGatewayProxyStructuredResultV2> {
  const { handler } = await import('../../src/lambdas/control.js');
  const path = '/v1/integrations/source-bindings/binding-1/event-policy';
  const event = {
    version: '2.0', routeKey: 'PUT /v1/integrations/source-bindings/{bindingId}/event-policy',
    rawPath: path, rawQueryString: '', headers: {}, isBase64Encoded: false,
    pathParameters: { bindingId: 'binding-1' }, body: JSON.stringify(body),
    requestContext: {
      http: { method: 'PUT', path }, requestId: 'policy-test',
      ...(authenticated ? { authorizer: { iam: { userArn: 'arn:aws:iam::000000000000:user/test' } } } : {}),
    },
  } as unknown as APIGatewayProxyEventV2;
  return await (handler as (input: APIGatewayProxyEventV2) => Promise<APIGatewayProxyStructuredResultV2>)(event);
}
