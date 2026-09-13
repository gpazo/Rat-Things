import { PassThrough } from 'node:stream';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ issue: vi.fn(), services: vi.fn(), metadata: {} as { statusCode?: number; headers?: Record<string, string> } }));
vi.mock('../../src/app/composition.js', () => ({
  getApiTokenService: () => ({ issue: fixture.issue }),
  getAgentsApiServices: fixture.services,
}));
vi.stubGlobal('awslambda', {
  streamifyResponse: (handler: unknown) => handler,
  HttpResponseStream: { from: (stream: PassThrough, metadata: typeof fixture.metadata) => { fixture.metadata = metadata; return stream; } },
});
const { handler } = await import('../../src/lambdas/agents-api.js');
const invoke = handler as unknown as (event: unknown, stream: PassThrough, context: unknown) => Promise<void>;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('AGENTS_TOKEN_ISSUER_ONLY', 'true');
  vi.stubEnv('ALLOW_OWNER_HEADER', 'false');
  vi.stubEnv('AGENTS_PUBLIC_BASE_URL', 'https://api.example/v1');
  fixture.issue.mockResolvedValue({ api_key: 'fixture-key', expires_at: 100, base_url: 'https://api.example/v1' });
});
afterAll(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

async function request(path: string, authenticated = true) {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => { chunks.push(chunk); });
  await invoke({ rawPath: path, headers: { 'content-type': 'application/json', 'x-runtime-owner': 'chosen-owner' },
    body: '{"ownerId":"chosen-owner"}', requestContext: { http: { method: 'POST' },
      ...(authenticated ? { authorizer: { iam: { userArn: 'arn:aws:iam::123456789012:user/operator' } } } : {}) },
  }, stream, { awsRequestId: 'request-1', getRemainingTimeInMillis: () => 10_000 });
  return { ...fixture.metadata, body: JSON.parse(Buffer.concat(chunks).toString()) };
}

describe('isolated IAM token issuer', () => {
  it('issues only for the authenticated IAM principal without composing provider or execution services', async () => {
    const response = await request('/v1/auth/tokens');
    expect(response.statusCode).toBe(200);
    expect(response.headers?.['cache-control']).toBe('no-store');
    expect(fixture.issue).toHaveBeenCalledExactlyOnceWith('api:arn:aws:iam::123456789012:user/operator', 'https://api.example/v1');
    expect(fixture.services).not.toHaveBeenCalled();
  });
  it('requires authenticated identity and refuses resource mutations on the issuer', async () => {
    expect((await request('/v1/auth/tokens', false)).statusCode).toBe(401);
    expect((await request('/v1/agents')).statusCode).toBe(404);
    expect(fixture.issue).not.toHaveBeenCalled();
    expect(fixture.services).not.toHaveBeenCalled();
  });
});
