import OpenAI, { toFile } from 'openai';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { ApiTokenService } from '../../src/core/api-token-service.js';
import { createAgentsHttpServer } from '../../src/adapters/agents-http-server.js';
import { routeAgentsRequest, agentsErrorResponse } from '../../src/lambdas/agents-router.js';
import { FileService } from '../../src/core/file-service.js';
import { AgentService } from '../../src/core/agent-service.js';
import { MemoryAgentsStore } from './fixtures.js';
import { MemoryArtifacts } from '../runner/artifact-fixtures.js';
import { createAgentsClient } from '../../src/agents-client.js';

describe('independent HTTP transport', () => {
  it('accepts standard SDK uploads larger than a Lambda request and enforces scoped expiring bearer keys', async () => {
    const store = new MemoryAgentsStore();
    let now = 100;
    const tokens = new ApiTokenService(store, { now: () => now });
    const baseURL = 'https://api.example/v1';
    const services = { agents: new AgentService({ store }), files: new FileService({ store, artifacts: new MemoryArtifacts() }) };
    const issued = await tokens.issue('alice', baseURL);
    const server = createAgentsHttpServer({ baseURL, issuerURL: 'https://issuer.lambda-url.us-west-2.on.aws/v1/auth/tokens',
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
        if (request.url.endsWith('/.well-known/agents-api')) return Response.json({ issuer_url: 'https://issuer.lambda-url.us-west-2.on.aws/v1/auth/tokens' });
        if (request.url.includes('.lambda-url.')) {
          issuances++;
          expect(request.headers.get('authorization')).toContain('/us-west-2/lambda/aws4_request');
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
