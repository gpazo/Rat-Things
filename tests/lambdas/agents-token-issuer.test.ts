import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ issue: vi.fn(), services: vi.fn() }));
vi.mock('../../src/app/composition.js', () => ({
  getApiTokenService: () => ({ issue: fixture.issue }),
  getAgentsApiServices: fixture.services,
}));
const { handler } = await import('../../src/lambdas/agents-token-issuer.js');
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('ALLOW_OWNER_HEADER', 'false');
  vi.stubEnv('AGENTS_PUBLIC_BASE_URL', 'https://api.example/v1');
  fixture.issue.mockResolvedValue({ api_key: 'fixture-key', expires_at: 100, base_url: 'https://api.example/v1' });
});
afterAll(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

async function request(path: string, authenticated = true, body = '{}') {
  const result = await handler({ rawPath: path, headers: { 'content-type': 'application/json', 'x-runtime-owner': 'chosen-owner' },
    body, requestContext: { requestId: 'request-1', http: { method: 'POST' },
      ...(authenticated ? { authorizer: { iam: { userArn: 'arn:aws:iam::123456789012:user/operator' } } } : {}) },
  } as unknown as APIGatewayProxyEventV2);
  return { ...result, body: JSON.parse(result.body ?? '{}') };
}

describe('isolated IAM token issuer', () => {
  it('issues only for the authenticated IAM principal without composing provider or execution services', async () => {
    const response = await request('/v1/auth/tokens');
    expect(response.statusCode).toBe(200);
    expect(response.headers?.['cache-control']).toBe('no-store');
    expect(fixture.issue).toHaveBeenCalledExactlyOnceWith('api:arn:aws:iam::123456789012:user/operator', 'https://api.example/v1', {});
    expect(fixture.services).not.toHaveBeenCalled();
  });
  it('passes requested scopes and rejects malformed JSON before issuance', async () => {
    expect((await request('/v1/auth/tokens', true, '{')).statusCode).toBe(400);
    expect(fixture.issue).not.toHaveBeenCalled();
    expect((await request('/v1/auth/tokens', true, '{"scopes":[]}')).statusCode).toBe(200);
    expect(fixture.issue).toHaveBeenCalledExactlyOnceWith('api:arn:aws:iam::123456789012:user/operator', 'https://api.example/v1', { scopes: [] });
  });
  it('requires authenticated identity and refuses resource mutations on the issuer', async () => {
    expect((await request('/v1/auth/tokens', false)).statusCode).toBe(401);
    expect((await request('/v1/agents')).statusCode).toBe(404);
    expect(fixture.issue).not.toHaveBeenCalled();
    expect(fixture.services).not.toHaveBeenCalled();
  });
  it('rejects JWT and local-header identities even when local owner headers are enabled', async () => {
    vi.stubEnv('ALLOW_OWNER_HEADER', 'true');
    expect((await request('/v1/auth/tokens', false)).statusCode).toBe(401);
    const result = await handler({ rawPath: '/v1/auth/tokens', headers: {}, body: '{}',
      requestContext: { requestId: 'request-2', http: { method: 'POST' }, authorizer: { jwt: { claims: { sub: 'viewer' } } } },
    } as unknown as APIGatewayProxyEventV2);
    expect(result.statusCode).toBe(401);
    expect(fixture.issue).not.toHaveBeenCalled();
  });
});
