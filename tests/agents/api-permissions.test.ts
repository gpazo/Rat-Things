import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { API_SCOPES, parseTokenScopes, requireRoutePermission, type ApiScope } from '../../src/domain/api-permissions.js';
import { ApiTokenService } from '../../src/core/api-token-service.js';
import { AgentService } from '../../src/core/agent-service.js';
import type { SessionService } from '../../src/core/session-service.js';
import { routeAgentsRequest, agentsErrorResponse } from '../../src/lambdas/agents-router.js';
import { createAgentsHttpServer } from '../../src/adapters/agents-http-server.js';
import { createAgentsClient } from '../../src/agents-client.js';
import { MemoryAgentsStore } from './fixtures.js';

describe('scoped API authority', () => {
  it('checks every scope independently across resource families', () => {
    const routes: Array<[string, string, ApiScope[]]> = [
      ['GET', 'v1/agents', ['api.agents.read']], ['POST', 'v1/agents', ['api.agents.write']],
      ['DELETE', 'v1/agents/sessions/s', ['api.agents.write']], ['GET', 'v1/agents/sessions/s/events', ['api.agents.read']],
      ['GET', 'v1/agents/sessions/s/traces', ['api.agents.read', 'api.traces.read']],
      ['GET', 'v1/vaults/v', ['api.vaults.read']], ['POST', 'v1/vaults/v', ['api.vaults.write']],
      ['GET', 'v1/files/f/content', ['api.agents.read']], ['POST', 'v1/skills', ['api.agents.write']],
      ['DELETE', 'v1/webhooks/w', ['api.agents.write']],
    ];
    for (const [method, path, allowed] of routes) for (const scope of API_SCOPES) {
      const check = () => requireRoutePermission({ ownerId: 'alice', scopes: [scope] }, method, path.split('/'));
      if (allowed.includes(scope)) expect(check).not.toThrow(); else expect(check).toThrow(expect.objectContaining({ status: 403 }));
    }
    for (const input of [null, [], { scopes: ['unknown'] }, { ownerId: 'bob' }, { scopes: 'api.agents.read' }]) expect(() => parseTokenScopes(input)).toThrow();
    expect(parseTokenScopes({ scopes: [] })).toEqual([]);
  });
  it('rejects inference batches before any Session service call and allows cancel-only writes', async () => {
    const store = new MemoryAgentsStore();
    const create = vi.fn().mockResolvedValue({}); const events = vi.fn().mockResolvedValue({});
    const services = { agents: new AgentService({ store }), sessions: { create, events } as unknown as SessionService };
    const principal = { ownerId: 'alice', scopes: ['api.agents.write'] as ApiScope[] };
    const send = (path: string, body: unknown) => routeAgentsRequest(new Request(`https://rat.invalid/v1/agents/sessions${path}`, { method: 'POST', body: JSON.stringify(body) }), principal, services);
    for (const input of ['', 'start', [{ role: 'user', content: [] }]]) expect((await send('', { input })).status).toBe(403);
    const cancel = { type: 'agent.session.input.cancel' };
    for (const type of ['agent.session.input.message', 'agent.session.input.tool_result']) expect((await send('/s/events', { events: [cancel, { type }] })).status).toBe(403);
    expect(create).not.toHaveBeenCalled(); expect(events).not.toHaveBeenCalled(); expect(store.resources.size).toBe(0);
    expect((await send('/s/events', { events: [cancel] })).status).toBe(204);
    expect(events).toHaveBeenCalledTimes(1);
    expect((await send('', { input: [] })).status).toBe(200);
    expect(create).toHaveBeenCalledTimes(1);
  });
  it('enforces a persisted read-only bearer grant over HTTP, including encoded paths', async () => {
    const store = new MemoryAgentsStore(); const tokens = new ApiTokenService(store, { now: () => 100 });
    const baseURL = 'https://rat.invalid/v1';
    const issued = await tokens.issue('alice', baseURL, { scopes: ['api.agents.read'] });
    const server = createAgentsHttpServer({ baseURL, issuerURL: 'https://issuer.lambda-url.us-west-2.on.aws/v1/auth/tokens', authenticate: value => tokens.authenticate(value, baseURL), route: (request, principal) => routeAgentsRequest(request, principal, { agents: new AgentService({ store }) }), error: agentsErrorResponse });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('No HTTP address');
      const url = `http://127.0.0.1:${address.port}/v1/%61gents`;
      const headers = { authorization: `Bearer ${issued.api_key}`, 'content-type': 'application/json' };
      expect((await fetch(url.replace('%61gents', 'agents'), { headers })).status).toBe(200);
      expect((await fetch(url, { method: 'POST', headers, body: '{"model":"test"}' })).status).toBe(403);
      expect(store.resources.size).toBe(1);
      const none = await tokens.issue('alice', baseURL, { scopes: [] });
      expect((await fetch(url, { headers: { authorization: `Bearer ${none.api_key}` } })).status).toBe(403);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it.each([undefined, ['api.agents.write'], 'api.agents.read'])('rejects an issuer that returns invalid or excessive scopes: %j', async granted => {
    let resourceCalls = 0;
    const client = createAgentsClient({ baseURL: 'https://rat.invalid/v1', region: 'us-west-2', scopes: ['api.agents.read'], credentials: { accessKeyId: 'test', secretAccessKey: 'test' }, tokenIssuerURL: 'https://issuer.lambda-url.us-west-2.on.aws/v1/auth/tokens', fetch: async (input, init) => {
      const request = new Request(input, init);
      if (request.url.includes('.lambda-url.')) {
        expect(await request.json()).toEqual({ scopes: ['api.agents.read'] });
        return Response.json({ api_key: 'key', expires_at: Date.now() / 1000 + 900, base_url: 'https://rat.invalid/v1', scopes: granted });
      }
      resourceCalls++; return Response.json({ data: [], has_more: false });
    } }).withOptions({ maxRetries: 0 });
    await expect(client.beta.agents.list()).rejects.toThrow(); expect(resourceCalls).toBe(0);
  });
});
