import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage } from 'node:http';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execute = promisify(execFile);

describe('Thing CLI-to-HTTP workflow', () => {
  const requests: Array<{
    method: string;
    path: string;
    headers: IncomingMessage['headers'];
    body: unknown;
  }> = [];
  const server = createServer(async (request, response) => {
    const body = await requestBody(request);
    requests.push({
      method: request.method ?? 'GET',
      path: request.url ?? '/',
      headers: request.headers,
      body,
    });
    response.setHeader('content-type', 'application/json');
    if (request.url === '/health') return send(response, { status: 'ok', service: 'rat-things' });
    if (request.url === '/.well-known/rat-things') {
      return send(response, { version: '1', service: 'rat-things', api: { openapi: '/openapi.json' } });
    }
    if (request.url === '/v1/capability-profiles') return send(response, { profiles: [] });
    if (request.method === 'POST' && request.url === '/v1/things') {
      return send(response, { version: '1', thingId: 'thing-cli', revision: 1, status: 'draft' }, 201);
    }
    if (request.method === 'GET' && request.url === '/v1/things/thing-cli/explain') {
      return send(response, { version: '1', runnable: true, diagnostics: [] });
    }
    if (request.method === 'POST' && request.url === '/v1/things/thing-cli/versions') {
      return send(response, { version: '1', thingId: 'thing-cli', revision: 2, status: 'draft' }, 201);
    }
    if (request.method === 'GET' && request.url === '/v1/things/thing-cli/versions/1') {
      return send(response, { version: '1', thingId: 'thing-cli', revision: 1, spec: { goal: 'original' } });
    }
    if (request.method === 'POST' && request.url === '/v1/things/thing-cli/run') {
      return send(response, { runId: 'run-cli', status: 'queued' }, 202);
    }
    return send(response, { error: { code: 'not_found', message: 'route not found' } }, 404);
  });
  let apiUrl = '';

  beforeAll(async () => {
    await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test HTTP server has no port');
    apiUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolvePromise, reject) => server.close((error) => (
      error ? reject(error) : resolvePromise()
    )));
  });

  it('creates, explains, and idempotently invokes a Thing through independent CLI processes', async () => {
    const created = await cli(['thing-create', '--file', 'examples/thing-create.json'], apiUrl);
    expect(JSON.parse(created.stdout)).toMatchObject({ thingId: 'thing-cli', status: 'draft' });
    const createRequest = requests.find((request) => request.path === '/v1/things');
    expect(createRequest).toMatchObject({
      method: 'POST',
      body: {
        version: '1',
        status: 'draft',
        spec: {
          name: 'Customer operations review',
          connections: {
            accounts: [
              { account: 'slack-support', access: 'read-only' },
              expect.objectContaining({ account: 'stripe-business', access: 'read-write' }),
            ],
          },
        },
      },
    });

    const explained = await cli(['thing-explain', 'thing-cli'], apiUrl);
    expect(JSON.parse(explained.stdout)).toMatchObject({ runnable: true });

    const revised = await cli([
      'thing-version',
      'thing-cli',
      '--file',
      'examples/thing-version.json',
    ], apiUrl);
    expect(JSON.parse(revised.stdout)).toMatchObject({ thingId: 'thing-cli', revision: 2 });
    expect(requests.find((request) => request.path === '/v1/things/thing-cli/versions')).toMatchObject({
      method: 'POST',
      body: { version: '1', expectedRevision: 1 },
    });

    const historical = await cli(['thing-version', 'thing-cli', '1'], apiUrl);
    expect(JSON.parse(historical.stdout)).toMatchObject({ revision: 1, spec: { goal: 'original' } });

    const run = await cli([
      'thing-run',
      'thing-cli',
      '--idempotency-key',
      'cli-safe-retry',
    ], apiUrl);
    expect(JSON.parse(run.stdout)).toMatchObject({ runId: 'run-cli', status: 'queued' });
    const runRequest = requests.find((request) => request.path === '/v1/things/thing-cli/run');
    expect(runRequest?.headers['idempotency-key']).toBe('cli-safe-retry');
    expect(runRequest?.body).toEqual({});
  }, 20_000);

  it('returns machine-readable installation diagnostics', async () => {
    const result = await cli(['doctor', '--json'], apiUrl);
    expect(JSON.parse(result.stdout)).toMatchObject({
      version: '1',
      ok: true,
      checks: expect.arrayContaining([
        expect.objectContaining({ name: 'api-health', status: 'pass' }),
        expect.objectContaining({ name: 'discovery', status: 'pass' }),
        expect.objectContaining({ name: 'authenticated-api', status: 'pass' }),
      ]),
    });
  });
});

async function cli(argumentsValue: string[], apiUrl: string): Promise<{ stdout: string; stderr: string }> {
  return execute(process.execPath, [
    resolve('node_modules/tsx/dist/cli.mjs'),
    'src/cli.ts',
    ...argumentsValue,
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      RAT_THINGS_API_URL: apiUrl,
      AGENT_RUNTIME_UNSIGNED: 'true',
    },
    timeout: 20_000,
  });
}

async function requestBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function send(
  response: import('node:http').ServerResponse,
  value: unknown,
  statusCode = 200,
): void {
  response.statusCode = statusCode;
  response.end(JSON.stringify(value));
}
