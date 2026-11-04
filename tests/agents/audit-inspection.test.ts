import { describe, expect, it } from 'vitest';
import { AgentService } from '../../src/core/agent-service.js';
import { ConfigurationHistory } from '../../src/core/configuration-history.js';
import { ToolAuthorizationService } from '../../src/core/tool-authorization-service.js';
import { iamApiPrincipal, type ApiScope } from '../../src/domain/api-permissions.js';
import type { ToolAuthorizationDecision } from '../../src/domain/tool-authorization.js';
import { routeAgentsRequest } from '../../src/lambdas/agents-router.js';
import { MemoryAgentsStore } from './fixtures.js';

describe('operator audit inspection', () => {
  it('retains owner-scoped Agent revisions after deletion with mutation attribution', async () => {
    const store = new MemoryAgentsStore();
    const services = { agents: new AgentService({ store }), history: new ConfigurationHistory(store) };
    const send = (path: string, method = 'GET', body?: unknown, owner = 'alice') => routeAgentsRequest(
      new Request(`https://rat.invalid/v1/agents${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) }),
      iamApiPrincipal(owner), services, 'host-request',
    );
    const agent = await (await send('', 'POST', { model: 'test', instructions: 'First' })).json() as { id: string };
    expect(agent.id).toMatch(/^agent_/);
    expect((await send(`/${agent.id}`, 'POST', { instructions: 'Second' })).status).toBe(200);
    expect((await send(`/${agent.id}`, 'DELETE')).status).toBe(200);
    expect((await send(`/${agent.id}`)).status).toBe(404);
    const page = await (await send(`/${agent.id}/revisions?order=asc&limit=1`)).json() as { data: Array<{ id: string; ref: { revision: number }; actor: unknown; requestId: string }>; has_more: boolean; last_id: string };
    expect(page.has_more).toBe(true);
    expect(page.data[0]).toMatchObject({ actor: { kind: 'owner', id: 'alice' }, requestId: 'host-request', ref: { revision: 1 } });
    const next = await (await send(`/${agent.id}/revisions?order=asc&after=${page.last_id}`)).json() as { data: Array<{ snapshot: unknown; change: string }> };
    expect(next.data).toHaveLength(2);
    expect(next.data.at(-1)).toMatchObject({ change: 'deleted', snapshot: null });
    expect((await send(`/${agent.id}/revisions/1`, 'GET', undefined, 'bob')).status).toBe(404);
    for (const query of ['limit=0', 'limit=-1', 'limit=1&limit=2', 'ownerId=bob', 'order=sideways']) {
      expect((await send(`/${agent.id}/revisions?${query}`)).status).toBe(400);
    }
  });

  it('allows trace-only access to the structural projection while protecting full receipts and snapshots', async () => {
    const store = new MemoryAgentsStore();
    const authorizations = new ToolAuthorizationService(store);
    const decision: ToolAuthorizationDecision = {
      id: 'authz_one', object: 'rat_things.tool_authorization', requestId: 'host_one', attempt: 1, at: 10,
      identity: { sessionId: 'sess_one', agentId: 'agent_one', runId: 'run_one', generation: 'g1', runtimeEpoch: 0 },
      configuration: null, context: { kind: 'unresolved', reason: 'unavailable' },
      policy: { serverLabel: 'docs', destinationDigest: 'digest', allowedTools: ['lookup'] },
      policyDigest: 'digest', toolName: 'lookup', credential: { kind: 'none' }, decision: 'allow',
    };
    await authorizations.record('alice', [decision]);
    const services = { agents: new AgentService({ store }), history: new ConfigurationHistory(store), authorizations };
    const send = (path: string, scopes: ApiScope[], ownerId = 'alice') => routeAgentsRequest(new Request(`https://rat.invalid/v1/${path}`), { ownerId, scopes }, services);
    const trace = await send('agents/sessions/sess_one/authorizations/otlp', ['api.traces.read']);
    expect(trace.status).toBe(200);
    expect(await trace.json()).toMatchObject({ data: [{ id: 'authz_one', otlp: { resourceSpans: expect.any(Array) } }] });
    for (const path of ['agents/sessions/sess_one/authorizations', 'agents/sessions/sess_one/authorizations/authz_one', 'agents/sessions/sess_one/configurations', 'agents/agent_one/revisions', 'vaults/vault_one/revisions']) {
      expect((await send(path, ['api.traces.read'])).status).toBe(403);
    }
    const receipt = await send('agents/sessions/sess_one/authorizations/authz_one', ['api.agents.read']);
    expect(await receipt.json()).toMatchObject({ outcome: { kind: 'unknown', reason: 'no_observation' } });
    expect((await send('agents/sessions/sess_one/authorizations/authz_one', ['api.agents.read'], 'bob')).status).toBe(404);
    expect((await send('agents/sessions/sess_one/authorizations/otlp', [])).status).toBe(403);
  });
});
