import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execute = promisify(execFile);

describe('Thing CLI-to-HTTP workflow', () => {
  const draftHash = 'b'.repeat(64);
  const requests: Array<{
    method: string;
    path: string;
    headers: IncomingMessage['headers'];
    body: unknown;
  }> = [];
  let oauthStarts = 0;
  const connectionSets: Array<Record<string, unknown>> = [];
  const sourceBindings: Array<Record<string, unknown>> = [];
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
    if (request.method === 'GET' && request.url === '/v1/integrations/plugins') {
      return send(response, {
        plugins: [{
          id: 'fixture-crm',
          version: '1',
          title: 'Fixture CRM',
          description: 'Test customer records.',
          authentication: [{
            scheme: 'api-key',
            title: 'API key',
            fields: [{ key: 'api_key', label: 'API key', secret: true }],
          }],
          operations: [],
        }, {
          id: 'slack',
          version: '1',
          title: 'Slack',
          description: 'Slack messages.',
          authentication: [{
            scheme: 'oauth2',
            title: 'Install with Slack OAuth',
            fields: [{ key: 'access_token', label: 'Access token', secret: true }],
            oauth2: {
              authorizationUrl: 'https://slack.example/authorize',
              tokenUrl: 'https://slack.example/token',
              scopes: ['chat:write'],
              tokenEndpointAuthMethod: 'client-secret-post',
            },
          }],
          operations: [],
          oauthInstallation: {
            status: 'configured',
            callbackUrl: 'https://api.example/v1/integrations/oauth/callback',
          },
        }],
      });
    }
    if (request.method === 'POST' && request.url === '/v1/integrations/oauth/authorizations') {
      oauthStarts += 1;
      return send(response, {
        version: '1',
        pluginId: 'slack',
        authorizationUrl: 'https://slack.example/authorize?state=opaque',
        callbackUrl: 'https://api.example/v1/integrations/oauth/callback',
        expiresAt: '2099-08-27T20:10:00.000Z',
      }, 201);
    }
    if (request.method === 'POST' && request.url === '/v1/integrations/connections') {
      return send(response, {
        connection: {
          version: '1',
          connectionId: 'connection-cli',
          pluginId: 'fixture-crm',
          alias: 'fixture-alpha',
          label: 'Alpha Support',
        },
        grant: { version: '1', preset: 'read-only' },
      }, 201);
    }
    if (request.method === 'GET' && request.url === '/v1/integrations/connections') {
      return send(response, {
        connections: [{
          connection: {
            version: '1',
            connectionId: 'connection-cli',
            pluginId: 'fixture-crm',
            alias: 'fixture-alpha',
            label: 'Alpha Support',
            authorization: {
              scheme: 'api-key',
              access: 'read',
              scopeModel: 'granular',
              scopes: ['records:read'],
            },
          },
        }, ...(oauthStarts >= 2 ? [{
          connection: {
            version: '1',
            connectionId: 'connection-slack',
            pluginId: 'slack',
            alias: 'slack-acme',
            label: 'Acme Slack',
            status: 'active',
            externalTenantId: 'T123',
            externalSubjectId: 'U123',
            authorization: {
              scheme: 'oauth2',
              access: 'full',
              scopeModel: 'granular',
              scopes: ['chat:write'],
            },
          },
          grant: { version: '1', preset: 'read-write' },
        }] : [])],
      });
    }
    if (request.method === 'POST' && request.url === '/v1/integrations/connections/connection-slack/grant') {
      return send(response, { version: '1', connectionId: 'connection-slack', preset: 'read-write' });
    }
    if (request.method === 'GET' && request.url === '/v1/integrations/connection-sets') {
      return send(response, { connectionSets });
    }
    if (request.method === 'POST' && request.url === '/v1/integrations/connection-sets') {
      const input = body as Record<string, unknown>;
      const { connections, ...rest } = input;
      const value = {
        ...rest,
        connectionIds: connections,
        connectionSetId: 'set-slack-events',
        ownerId: 'api:owner',
      };
      connectionSets.push(value);
      return send(response, value, 201);
    }
    if (request.method === 'GET' && request.url === '/v1/integrations/source-bindings') {
      return send(response, { sourceBindings });
    }
    if (request.method === 'POST' && request.url === '/v1/integrations/source-bindings') {
      const value = {
        ...(body as Record<string, unknown>),
        bindingId: 'binding-slack-events',
        ownerId: 'api:owner',
      };
      sourceBindings.push(value);
      return send(response, value, 201);
    }
    if (
      request.method === 'POST' &&
      request.url === '/v1/integrations/connections/fixture-alpha/credential'
    ) {
      return send(response, { ok: true, connectionId: 'connection-cli' });
    }
    if (request.method === 'POST' && request.url === '/v1/things') {
      return send(response, {
        version: '1',
        thingId: 'thing-cli',
        draft: { revision: 1 },
        status: 'draft',
      }, 201);
    }
    if (request.method === 'GET' && request.url === '/v1/things/thing-cli') {
      const revised = requests.filter((candidate) => (
        candidate.method === 'POST' && candidate.path === '/v1/things/thing-cli/versions'
      )).length > 0;
      return send(response, {
        version: '1',
        thingId: 'thing-cli',
        draft: { revision: revised ? 2 : 1, specHash: draftHash },
        status: revised ? 'active' : 'draft',
      });
    }
    if (request.method === 'GET' && request.url === '/v1/things/thing-cli/explain') {
      return send(response, {
        version: '1',
        runnable: true,
        diagnostics: [],
        thing: { thingId: 'thing-cli', draft: { revision: 2, specHash: draftHash } },
      });
    }
    if (request.method === 'POST' && request.url === '/v1/things/thing-cli/versions') {
      return send(response, {
        version: '1',
        thingId: 'thing-cli',
        draft: { revision: 2 },
        status: 'draft',
      }, 201);
    }
    if (request.method === 'GET' && request.url === '/v1/things/thing-cli/versions/1') {
      return send(response, { version: '1', thingId: 'thing-cli', revision: 1, spec: { goal: 'original' } });
    }
    if (request.method === 'POST' && request.url === '/v1/things/thing-cli/run') {
      return send(response, { runId: 'run-cli', status: 'queued' }, 202);
    }
    if (request.method === 'POST' && request.url === '/v1/things/thing-cli/test') {
      return send(response, {
        runId: 'test-cli',
        status: 'queued',
        thing: {
          version: '1',
          thingId: 'thing-cli',
          revision: 2,
          specHash: draftHash,
          invocation: 'test',
        },
      }, 202);
    }
    if (request.method === 'GET' && request.url === '/v1/runs/test-cli') {
      return send(response, {
        runId: 'test-cli',
        status: 'succeeded',
        thing: {
          version: '1',
          thingId: 'thing-cli',
          revision: 2,
          specHash: draftHash,
          invocation: 'test',
        },
      });
    }
    if (request.method === 'POST' && request.url === '/v1/things/thing-cli/publish') {
      return send(response, {
        version: '1',
        thingId: 'thing-cli',
        draft: { revision: 2 },
        active: { revision: 2 },
        status: 'active',
      });
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
        name: 'Safe reusable baseline',
        agent: {
          sandbox: 'read-only',
          capabilities: expect.objectContaining({
            networkAccess: false,
            computerUse: 'disabled',
          }),
        },
        deliver: [{ kind: 'none' }],
      },
    });

    const explained = await cli(['thing-explain', 'thing-cli'], apiUrl);
    expect(JSON.parse(explained.stdout)).toMatchObject({ runnable: true });

    const revised = await cli([
      'thing-update',
      'thing-cli',
      '--file',
      'examples/thing-version.json',
    ], apiUrl);
    expect(JSON.parse(revised.stdout)).toMatchObject({ thingId: 'thing-cli', draft: { revision: 2 } });
    expect(requests.find((request) => request.path === '/v1/things/thing-cli/versions')).toMatchObject({
      method: 'POST',
      body: { version: '1', expectedDraftRevision: 1, spec: expect.any(Object) },
    });

    const historical = await cli(['thing-version', 'thing-cli', '1'], apiUrl);
    expect(JSON.parse(historical.stdout)).toMatchObject({ revision: 1, spec: { goal: 'original' } });

    const published = await cli([
      'thing-release',
      'thing-cli',
      '--poll-seconds',
      '1',
    ], apiUrl);
    expect(JSON.parse(published.stdout)).toMatchObject({
      released: true,
      testRun: { runId: 'test-cli', status: 'succeeded' },
      thing: { status: 'active', draft: { revision: 2 }, active: { revision: 2 } },
    });
    expect(requests.find((request) => request.path === '/v1/things/thing-cli/publish')).toMatchObject({
      body: {
        version: '1',
        expectedDraftRevision: 2,
        expectedSpecHash: draftHash,
        testRunId: 'test-cli',
      },
    });
    expect(requests.find((request) => request.path === '/v1/things/thing-cli/test')
      ?.headers['idempotency-key']).toBe(`release:thing-cli:2:${draftHash.slice(0, 16)}`);

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

  it('creates, tests, and publishes a first Thing in one command', async () => {
    const released = await cli([
      'thing-release',
      '--file',
      'examples/thing-create.json',
      '--poll-seconds',
      '1',
    ], apiUrl);
    expect(released.stderr).toContain('created Thing thing-cli');
    expect(JSON.parse(released.stdout)).toMatchObject({
      released: true,
      created: { thingId: 'thing-cli', status: 'draft' },
      testRun: { runId: 'test-cli', status: 'succeeded' },
      thing: { thingId: 'thing-cli', status: 'active' },
    });
  }, 20_000);

  it('discovers authentication fields and creates and rotates a connection from credential-only files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rat-things-connect-'));
    const credentialPath = join(directory, 'fixture-credential.json');
    await writeFile(credentialPath, JSON.stringify({ api_key: 'fixture-secret' }), { mode: 0o600 });
    try {
      const result = await cli([
        'connect',
        'fixture-crm',
        '--credential-file',
        credentialPath,
        '--alias',
        'fixture-alpha',
      ], apiUrl);
      expect(JSON.parse(result.stdout)).toMatchObject({
        connection: { alias: 'fixture-alpha', label: 'Alpha Support' },
        grant: { preset: 'read-only' },
      });
      expect([...requests].reverse().find(
        (request) => request.path === '/v1/integrations/connections',
      ))
        .toMatchObject({
          method: 'POST',
          body: {
            version: '1',
            pluginId: 'fixture-crm',
            alias: 'fixture-alpha',
            authScheme: 'api-key',
            credential: { api_key: 'fixture-secret' },
            grant: { version: '1', preset: 'read-only' },
          },
        });
      await cli([
        'rotate',
        'fixture-alpha',
        '--credential-file',
        credentialPath,
      ], apiUrl);
      expect([...requests].reverse().find(
        (request) => request.path === '/v1/integrations/connections/fixture-alpha/credential',
      )).toMatchObject({
        method: 'POST',
        body: { version: '1', credential: { api_key: 'fixture-secret' } },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('starts configured self-hosted OAuth without putting an app secret or token on the command line', async () => {
    const result = await cli([
      'connect',
      'slack',
      '--oauth',
      '--no-browser',
      '--access',
      'read-write',
      '--json',
    ], apiUrl);
    expect(JSON.parse(result.stdout)).toMatchObject({
      pluginId: 'slack',
      authorizationUrl: 'https://slack.example/authorize?state=opaque',
    });
    expect([...requests].reverse().find(
      (request) => request.path === '/v1/integrations/oauth/authorizations',
    )).toMatchObject({
      method: 'POST',
      body: {
        version: '1',
        pluginId: 'slack',
        grant: { version: '1', preset: 'read-write' },
      },
    });
  });

  it('can wait for the OAuth callback to install a verified connection', async () => {
    const result = await cli([
      'connect',
      'slack',
      '--oauth',
      '--wait',
      '--no-browser',
      '--access',
      'read-write',
      '--json',
    ], apiUrl);
    expect(JSON.parse(result.stdout)).toMatchObject({
      connection: {
        connectionId: 'connection-slack',
        pluginId: 'slack',
        alias: 'slack-acme',
      },
      grant: { preset: 'read-write' },
    });
  });

  it('enables signed Slack mentions with a source binding and owner connection set', async () => {
    const result = await cli(['slack-events', 'slack-acme'], apiUrl);
    expect(JSON.parse(result.stdout)).toMatchObject({
      enabled: true,
      connectionSet: { connectionSetId: 'set-slack-events' },
      sourceBinding: {
        sourceKind: 'slack',
        selector: { teamId: 'T123' },
        capabilityProfile: 'read-only',
      },
    });
    expect(requests.filter((request) => request.path === '/v1/integrations/connection-sets').at(-1))
      .toMatchObject({
        method: 'POST',
        body: {
          name: 'slack-events-t123',
          connections: ['connection-slack'],
          defaults: { slack: 'connection-slack' },
        },
      });
    const repeated = await cli(['slack-events', 'slack-acme', '--json'], apiUrl);
    expect(JSON.parse(repeated.stdout)).toMatchObject({
      enabled: true,
      unchanged: true,
      sourceBinding: { bindingId: 'binding-slack-events' },
    });
    expect(requests.filter((request) => (
      request.method === 'POST' && request.path === '/v1/integrations/connection-sets'
    ))).toHaveLength(1);
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
