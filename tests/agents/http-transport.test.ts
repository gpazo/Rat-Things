import OpenAI, { toFile } from 'openai';
import { once } from 'node:events';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { ApiTokenService } from '../../src/core/api-token-service.js';
import { createAgentsHttpServer } from '../../src/adapters/agents-http-server.js';
import { routeAgentsRequest, agentsErrorResponse } from '../../src/lambdas/agents-router.js';
import { FileService } from '../../src/core/file-service.js';
import { AgentService } from '../../src/core/agent-service.js';
import { MemoryAgentsStore } from './fixtures.js';
import { MemoryArtifacts } from '../runner/artifact-fixtures.js';
import { createAgentsClient, createAgentsFetch } from '../../src/agents-client.js';

describe('independent HTTP transport', () => {
  it('accepts standard SDK uploads larger than a Lambda request and enforces scoped expiring bearer keys', async () => {
    const store = new MemoryAgentsStore();
    let now = Math.floor(Date.now() / 1000);
    const tokens = new ApiTokenService(store, { now: () => now });
    const baseURL = 'https://api.example/v1';
    const services = { agents: new AgentService({ store }), files: new FileService({ store, artifacts: new MemoryArtifacts() }) };
    const issued = await tokens.issue('alice', baseURL);
    const server = createAgentsHttpServer({ baseURL, issuerURL: 'https://api.execute-api.us-west-2.amazonaws.com/v1/auth/tokens',
      authenticate: (value) => tokens.authenticate(value, baseURL), route: (request, owner, id) => routeAgentsRequest(request, owner, services, id), error: agentsErrorResponse,
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
      const sdk = new OpenAI({ baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: issued.api_key, maxRetries: 0 });
      const bytes = Buffer.alloc(8 * 1024 * 1024, 213);
      const saved = await sdk.files.create({ file: await toFile(bytes, 'large.bin'), purpose: 'user_data' });
      expect(saved.bytes).toBe(bytes.length);
      expect(Buffer.from(await (await sdk.files.content(saved.id)).arrayBuffer()).equals(bytes)).toBe(true);
      const bob = await tokens.issue('bob', baseURL);
      await expect(sdk.files.retrieve(saved.id, { headers: { Authorization: `Bearer ${bob.api_key}` } })).rejects.toMatchObject({ status: 404 });
      await expect(tokens.authenticate(`Bearer ${issued.api_key}`, 'https://another.example/v1')).rejects.toMatchObject({ status: 401 });
      await expect(tokens.authenticate(`Bearer ${issued.api_key.slice(0, -2)}xx`, baseURL)).rejects.toMatchObject({ status: 401 });
      now = issued.expires_at;
      await expect(sdk.files.retrieve(saved.id)).rejects.toMatchObject({ status: 401 });
      expect(JSON.stringify([...store.resources.values()])).not.toContain(issued.api_key);
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  it('uses IAM only for token issuance and shares a refresh across simultaneous SDK requests', async () => {
    let issuances = 0;
    const client = createAgentsClient({ baseURL: 'https://api.example/v1', region: 'us-west-2', credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if (request.url.endsWith('/.well-known/agents-api')) return Response.json({ issuer_url: 'https://api.execute-api.us-west-2.amazonaws.com/v1/auth/tokens' });
        if (request.url.includes('.execute-api.')) {
          issuances++;
          expect(request.headers.get('authorization')).toContain('/us-west-2/execute-api/aws4_request');
          return Response.json({ api_key: 'temporary-key', expires_at: Date.now() / 1000 + 900, base_url: 'https://api.example/v1' });
        }
        expect(request.headers.get('authorization')).toBe('Bearer temporary-key');
        return Response.json({ data: [], has_more: false });
      },
    });
    await Promise.all([client.beta.agents.list(), client.beta.agents.list()]);
    expect(issuances).toBe(1);
  });
});


it.each(['https://api.example/v1', 'https://bcdfghjklmnpqrst.b7t.lambda-web.us-west-2.on.aws/v1'])(
  'returns artifact redirects for validation without following them at %s', async (baseURL) => {
    const calls: Request[] = [];
    const client = createAgentsFetch({ baseURL, region: 'us-west-2', credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if (request.url.endsWith('/.well-known/agents-api')) return Response.json({ issuer_url: 'https://api.execute-api.us-west-2.amazonaws.com/v1/auth/tokens' });
        if (request.url.endsWith('/auth/tokens')) return Response.json({ api_key: 'temporary-key', expires_at: Date.now() / 1000 + 900, base_url: baseURL });
        calls.push(request);
        return new Response(null, { status: 302, headers: { location: 'https://artifacts.s3.us-west-2.amazonaws.com/private' } });
      },
    });
    const response = await client(`${baseURL}/agents/sessions/s/artifacts/a/content`, { redirect: 'manual' });
    expect(response.status).toBe(302);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.redirect).toBe('manual');
    expect(calls[0]!.headers.has('authorization')).toBe(true);
    await expect(client('https://other.example/private')).rejects.toThrow('another origin');
    await client(`${baseURL}/agents`, { redirect: 'follow' });
    expect(calls[1]!.redirect).toBe('error');
  },
);

describe('Lambda Web Function HTTP binding', () => {
  const host = 'bcdfghjklmnpqrst.b7t.lambda-web.us-west-2.on.aws';
  const baseURL = `https://${host}/v1`;

  it('uses only the regional endpoint Host for discovery and bearer audience', async () => {
    const audiences: string[] = [];
    const server = createAgentsHttpServer({ webFunctionRegion: 'us-west-2', issuerURL: 'https://api.execute-api.us-west-2.amazonaws.com/v1/auth/tokens',
      authenticate: async (_authorization, audience) => { audiences.push(audience); return { ownerId: 'alice', scopes: [], authentication: 'token', expiresAt: 0, actor: { id: 'alice', kind: 'operator' } }; },
      route: async request => Response.json({ url: request.url }), error: agentsErrorResponse,
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
      const origin = `http://127.0.0.1:${address.port}`;
      const discovery = await httpResponse(`${origin}/.well-known/agents-api`, { headers: { host, 'x-forwarded-host': 'attacker.example', 'x-forwarded-proto': 'http' } });
      expect(JSON.parse(await responseText(discovery))).toMatchObject({ base_url: baseURL, issuer_url: 'https://api.execute-api.us-west-2.amazonaws.com/v1/auth/tokens' });
      const accepted = await httpResponse(`${origin}/v1/agents`, { headers: { host, authorization: 'Bearer test', 'x-forwarded-host': 'attacker.example' } });
      expect(JSON.parse(await responseText(accepted))).toEqual({ url: `${baseURL}/agents` });
      expect(audiences).toEqual([baseURL]);
      expect((await httpResponse(`${origin}/.well-known/agents-api`, { headers: { host: 'attacker.example' } })).statusCode).toBe(400);
      expect((await httpResponse(`${origin}/.well-known/agents-api`, { headers: { host: 'bcdfghjklmnpqrst.b7t.lambda-web.eu-west-1.on.aws' } })).statusCode).toBe(400);
      expect(audiences).toEqual([baseURL]);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it('keeps concurrent event streams and input requests bound to their own bearer identities and cancels streams', async () => {
    const aborted = new Set<string>();
    const server = createAgentsHttpServer({ webFunctionRegion: 'us-west-2', issuerURL: 'https://api.execute-api.us-west-2.amazonaws.com/v1/auth/tokens',
      authenticate: async authorization => {
        const ownerId = authorization === 'Bearer alice' ? 'alice' : authorization === 'Bearer bob' ? 'bob' : '';
        if (!ownerId) throw new Error('unexpected authorization');
        return { ownerId, scopes: [], authentication: 'token', expiresAt: 0, actor: { id: ownerId, kind: 'operator' } };
      },
      route: async (request, principal) => {
        if (request.method === 'POST') return Response.json({ ownerId: principal.ownerId, body: await request.text() });
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`data: ${principal.ownerId}\n\n`));
            request.signal.addEventListener('abort', () => { aborted.add(principal.ownerId); controller.close(); }, { once: true });
          },
        }), { headers: { 'content-type': 'text/event-stream' } });
      }, error: agentsErrorResponse,
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
      const origin = `http://127.0.0.1:${address.port}`;
      const [aliceStream, bobStream] = await Promise.all([
        httpResponse(`${origin}/v1/agents/sessions/alice/events`, { headers: { host, authorization: 'Bearer alice' } }),
        httpResponse(`${origin}/v1/agents/sessions/bob/events`, { headers: { host, authorization: 'Bearer bob' } }),
      ]);
      const [aliceEvents, bobEvents] = await Promise.all([aliceStream[Symbol.asyncIterator]().next(), bobStream[Symbol.asyncIterator]().next()]);
      expect(aliceEvents.value?.toString()).toContain('alice');
      expect(bobEvents.value?.toString()).toContain('bob');
      const [aliceInput, bobInput] = await Promise.all([
        httpResponse(`${origin}/v1/agents`, { method: 'POST', headers: { host, authorization: 'Bearer alice' }, body: 'alice-input' }),
        httpResponse(`${origin}/v1/agents`, { method: 'POST', headers: { host, authorization: 'Bearer bob' }, body: 'bob-input' }),
      ]);
      expect(JSON.parse(await responseText(aliceInput))).toEqual({ ownerId: 'alice', body: 'alice-input' });
      expect(JSON.parse(await responseText(bobInput))).toEqual({ ownerId: 'bob', body: 'bob-input' });
      aliceStream.destroy(); bobStream.destroy();
      await vi.waitFor(() => expect([...aborted].sort()).toEqual(['alice', 'bob']));
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});

function httpResponse(url: string, options: { method?: string; headers: Record<string, string>; body?: string }): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, options, resolve);
    request.once('error', reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

async function responseText(response: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of response) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}
