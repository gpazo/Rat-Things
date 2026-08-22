import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';

const sqs = new SQSClient({});

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const deploymentId = requiredEnv('DEPLOYMENT_ID');
  const authorization = event.headers.authorization ?? event.headers.Authorization ?? '';
  const account = accountFor(authorization, deploymentId);
  if (!account) return response(401, { ok: false, error: 'invalid_api_key' });
  const method = event.requestContext.http.method;
  const path = event.rawPath;

  if (method === 'GET' && path === '/me') {
    return response(200, {
      ok: true,
      label: account === 'alpha' ? 'Alpha Support' : 'Beta Support',
      tenant_id: `fixture-${account}`,
      subject_id: `fixture-service-${account}`,
      access: account === 'alpha' ? 'read' : 'full',
      scopes: account === 'alpha' ? ['records:read'] : ['records:read', 'records:write'],
    });
  }
  if (method === 'GET' && path === '/records/search') {
    const query = event.queryStringParameters?.query;
    if (!query || Buffer.byteLength(query, 'utf8') > 4_096) {
      return response(400, { ok: false, error: 'invalid_query' });
    }
    return response(200, {
      ok: true,
      account,
      query,
      records: [{ id: `${account}-customer-1`, name: `${account} ${query}` }],
    });
  }
  if (method === 'POST' && path === '/records') {
    if (account !== 'beta') return response(403, { ok: false, error: 'read_only_account' });
    const body = jsonObject(event.body);
    const name = body?.name;
    if (typeof name !== 'string' || !name || Buffer.byteLength(name, 'utf8') > 256) {
      return response(400, { ok: false, error: 'invalid_name' });
    }
    const recordId = `beta-created-${event.requestContext.requestId}`;
    await sqs.send(new SendMessageCommand({
      QueueUrl: requiredEnv('AUDIT_QUEUE_URL'),
      MessageBody: JSON.stringify({
        version: '1',
        operation: 'records.create',
        account,
        recordId,
        name,
      }),
    }));
    return response(201, { ok: true, account, record: { id: recordId, name } });
  }
  return response(404, { ok: false, error: 'not_found' });
}

function accountFor(authorization: string, deploymentId: string): 'alpha' | 'beta' | undefined {
  if (authorization === `Bearer alpha-${deploymentId}`) return 'alpha';
  if (authorization === `Bearer beta-${deploymentId}`) return 'beta';
  return undefined;
}

function jsonObject(encoded: string | undefined): Record<string, unknown> | undefined {
  if (!encoded || Buffer.byteLength(encoded, 'utf8') > 16_384) return undefined;
  try {
    const value = JSON.parse(encoded) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function response(statusCode: number, value: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
