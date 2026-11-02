import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { afterEach, expect, it, vi } from 'vitest';
import { handler } from '../../src/lambdas/integration-fixture.js';

const audit = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: class { send = audit; },
  SendMessageCommand: class { constructor(public input: unknown) {} },
}));
afterEach(() => { vi.unstubAllEnvs(); audit.mockClear(); });

const proof = 'security-11111111-1111-1111-1111-111111111111';
function event(authorization: string, identity = proof): APIGatewayProxyEventV2 {
  return {
    version: '2.0', routeKey: 'GET /credential-echo', rawQueryString: '', isBase64Encoded: false,
    rawPath: '/credential-echo', headers: { authorization }, queryStringParameters: { proof: identity },
    requestContext: {
      accountId: 'test', apiId: 'test', domainName: 'fixture.test', domainPrefix: 'fixture',
      requestId: 'independent-request-id', routeKey: 'GET /credential-echo', stage: '$default', time: '', timeEpoch: 0,
      http: { method: 'GET', path: '/credential-echo', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
    },
  };
}

it('audits the authenticated echo request independently without copying the credential into the audit', async () => {
  vi.stubEnv('DEPLOYMENT_ID', 'test');
  vi.stubEnv('AUDIT_QUEUE_URL', 'https://queue.test');
  const token = 'echo-test:/+?=';
  const result = await handler(event(`Bearer ${token}`));
  expect(result).toMatchObject({ statusCode: 200, headers: { 'x-credential-echo': token } });
  expect(typeof result === 'object' && 'body' in result && JSON.parse(result.body!)).toEqual({
    raw: token, base64: Buffer.from(token).toString('base64'), url: encodeURIComponent(token), requestId: 'independent-request-id',
  });
  expect(audit).toHaveBeenCalledWith(expect.objectContaining({ input: {
    QueueUrl: 'https://queue.test', MessageBody: JSON.stringify({ version: '1', operation: 'credential.echo', proof, requestId: 'independent-request-id' }),
  } }));
  expect(JSON.stringify(audit.mock.calls)).not.toContain(token);
});

it('never echoes an unknown credential or records an invalid proof', async () => {
  vi.stubEnv('DEPLOYMENT_ID', 'test');
  expect(await handler(event('Bearer arbitrary-secret'))).toMatchObject({ statusCode: 401 });
  expect(await handler(event('Bearer echo-test:/+?=', 'invalid'))).toMatchObject({ statusCode: 400 });
  expect(audit).not.toHaveBeenCalled();
});
