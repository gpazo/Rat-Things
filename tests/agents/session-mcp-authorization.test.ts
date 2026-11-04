import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionMcpProxy, prepareSessionMcp } from '../../src/runner/session-mcp.js';
import { activeMcpTurnContext, type SessionMcpAudit } from '../../src/runner/session-mcp-authorization.js';
import { sessionAgent } from '../../src/core/session-planning.js';
import { ToolAuthorizationService } from '../../src/core/tool-authorization-service.js';
import type { McpAuthorization, ToolAuthorizationReceipt } from '../../src/domain/tool-authorization.js';
import { initialSessionRuntime, type SessionRuntimeState } from '../../src/core/session-runtime-planning.js';
import type { Turn } from '../../src/domain/agents-api.js';
import { MemoryAgentsStore } from './fixtures.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const call = (name = 'lookup', id: unknown = 'guest-protocol-secret') => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name,
  arguments: { password: 'private-argument' }, _meta: { ownerId: 'mallory', turnId: 'forged-turn', itemId: 'forged-item', runId: 'forged-run' } } });
const credential = (revision = 1): McpAuthorization => ({ authorization: `Bearer token-${revision}`, evidence: { kind: 'vault',
  vault: { subject: { kind: 'vault', id: 'vault' }, revision }, credential: { subject: { kind: 'credential', vaultId: 'vault', id: 'credential' }, revision }, checkedAt: 100, destinationDigest: 'digest' } });
const turn = (id: string, status: Turn['status'] = 'in_progress', subagent: string | null = null): Turn => ({
  id, status, session_id: 'session', agent_id: 'agent', subagent_id: subagent, object: 'agent.session.turn',
  created_at: 1, started_at: 1, completed_at: null, usage: null, error: null,
});
const withTurns = (...turns: Turn[]): SessionRuntimeState => ({ ...initialSessionRuntime('session', 'agent', 'native-root'),
  turns: turns.map(turn => ({ threadId: turn.subagent_id ?? 'native-root', nativeTurnId: `native-${turn.id}`, turn, items: [] })) });

async function fixture(options: { signal?: AbortSignal; store?: MemoryAgentsStore; runtime?: () => SessionRuntimeState | undefined; authorize?: (rejected?: string) => Promise<McpAuthorization>;
  assertActive?: () => Promise<void>; upstream?: (request: IncomingMessage, response: ServerResponse) => void } = {}) {
  const store = options.store ?? new MemoryAgentsStore();
  const service = new ToolAuthorizationService(store);
  const sendObservations: number[] = [];
  const upstream = createServer(async (request, response) => {
    sendObservations.push((await service.list('alice', 'session')).data.length);
    if (options.upstream) options.upstream(request, response);
    else { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ jsonrpc: '2.0', id: 'guest-protocol-secret', result: { isError: true, content: [{ type: 'text', text: 'private-result' }] } })); }
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  cleanup.push(async () => { upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); });
  const address = upstream.address(); if (!address || typeof address === 'string') throw new Error('Fixture listen failed');
  const authorize = vi.fn(options.authorize ?? (async () => credential()));
  const audit: SessionMcpAudit = { ownerId: 'alice', identity: { sessionId: 'session', agentId: 'agent', runId: 'run', generation: 'generation', runtimeEpoch: 4 },
    configuration: { subject: { kind: 'session', id: 'session' }, revision: 7 }, service,
    context: () => activeMcpTurnContext(options.runtime?.()), assertActive: options.assertActive ?? (async () => {}) };
  const proxy = await createSessionMcpProxy({ serverURL: 'https://mcp.example/service?key=private-query', headers: {}, metadata: {}, allowedTools: ['lookup'], serverLabel: 'crm', audit, authorize, ...(options.signal ? { signal: options.signal } : {}),
    // Production destination validation remains HTTPS. The fixture adapter alone
    // routes its send into a real loopback HTTP server.
    fetch: async (_url, init) => fetch(`http://127.0.0.1:${address.port}/`, init),
  });
  cleanup.push(proxy.close);
  const request = async (value: unknown = call()) => fetch(proxy.url, { method: 'POST', headers: { authorization: `Bearer ${proxy.key}`, 'content-type': 'application/json' }, body: JSON.stringify(value) });
  return { store, service, authorize, sendObservations, request };
}

describe('durable service MCP dispatch', () => {
  it('retains an allow before a real upstream send and excludes guest metadata, arguments, results and URLs', async () => {
    const f = await fixture({ runtime: () => withTurns(turn('root-2')) });
    expect((await f.request()).status).toBe(200);
    expect(f.sendObservations).toEqual([1]);
    const [receipt] = (await f.service.list('alice', 'session')).data;
    expect(receipt).toMatchObject({ decision: 'allow', attempt: 1, configuration: { revision: 7 }, identity: { runId: 'run', generation: 'generation', runtimeEpoch: 4 },
      context: { kind: 'single_active_turn', turnId: 'root-2' }, outcome: { kind: 'response_received', httpStatus: 200, toolResult: 'unobserved' } });
    const json = JSON.stringify([...f.store.resources.values()]);
    for (const secret of ['private-', 'forged-', 'mallory', 'token-1', 'mcp.example', 'guest-protocol-secret', 'native-root']) expect(json).not.toContain(secret);
    expect(receipt!.policy.allowedTools).toEqual(['lookup']);
    expect(receipt!.policy.destinationDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('denies a mixed batch atomically without reading credentials or sending any member', async () => {
    const f = await fixture();
    const response = await f.request([call(), call('erase')]);
    expect(response.status).toBe(502); expect(await response.json()).toEqual({ error: 'MCP request failed' });
    expect(f.authorize).not.toHaveBeenCalled(); expect(f.sendObservations).toEqual([]);
    const receipts = (await f.service.list('alice', 'session')).data;
    expect(receipts).toHaveLength(2);
    expect(receipts.map(receipt => receipt.reason).sort()).toEqual(['batch_denied', 'tool_not_admitted']);
    expect(receipts.every(receipt => receipt.decision === 'deny' && receipt.outcome.kind === 'not_dispatched')).toBe(true);
  });

  it('records invalid notifications and bounds batches before credentials', async () => {
    const f = await fixture();
    expect((await f.request({ ...call(), id: null })).status).toBe(502);
    expect((await f.service.list('alice', 'session')).data[0]).toMatchObject({ decision: 'deny', reason: 'invalid_call' });
    expect((await f.request(Array.from({ length: 33 }, () => call()))).status).toBe(502);
    expect(f.authorize).not.toHaveBeenCalled(); expect(f.sendObservations).toEqual([]);
  });

  it('retains credential denial without provider diagnostics', async () => {
    const f = await fixture({ authorize: async () => { throw new Error('private-token'); } });
    const response = await f.request(); expect(await response.json()).toEqual({ error: 'MCP request failed' });
    expect((await f.service.list('alice', 'session')).data[0]).toMatchObject({ decision: 'deny', reason: 'credential_unavailable', credential: { kind: 'unavailable' } });
    expect(f.sendObservations).toEqual([]);
  });

  it('retains inactive execution denial before any secret read', async () => {
    const f = await fixture({ assertActive: async () => { throw new Error('revoked'); } });
    expect((await f.request()).status).toBe(502);
    expect(f.authorize).not.toHaveBeenCalled();
    expect((await f.service.list('alice', 'session')).data[0]).toMatchObject({ decision: 'deny', reason: 'execution_inactive' });
  });

  it('rechecks execution authority after the decision before sending', async () => {
    let checks = 0;
    const f = await fixture({ assertActive: async () => { if (++checks === 2) throw new Error('revoked'); } });
    expect((await f.request()).status).toBe(502);
    expect((await f.service.list('alice', 'session')).data[0]).toMatchObject({ decision: 'allow', outcome: { kind: 'not_dispatched' } });
    expect(f.sendObservations).toEqual([]);
  });

  it('fails closed and disables dispatch if decision persistence fails', async () => {
    const store = new MemoryAgentsStore(); vi.spyOn(store, 'commit').mockRejectedValue(new Error('storage unavailable'));
    const f = await fixture({ store });
    expect((await f.request()).status).toBe(502); expect((await f.request()).status).toBe(502);
    expect(f.sendObservations).toEqual([]); expect(f.authorize).toHaveBeenCalledTimes(1);
  });

  it('does not replay a remote effect after outcome persistence fails', async () => {
    const store = new MemoryAgentsStore(); const commit = store.commit.bind(store);
    vi.spyOn(store, 'commit').mockImplementation(writes => writes.some(write => write.resource.collection.startsWith('tool_authorization_outcomes/')) ? Promise.reject(new Error('storage unavailable')) : commit(writes));
    const f = await fixture({ store });
    expect((await f.request()).status).toBe(502); expect((await f.request()).status).toBe(502);
    expect(f.sendObservations).toEqual([1]);
    expect((await f.service.list('alice', 'session')).data[0]?.outcome).toEqual({ kind: 'unknown', reason: 'no_observation' });
  });

  it('records ambiguous transport failure without retrying', async () => {
    const f = await fixture({ upstream: request => request.socket.destroy() });
    expect((await f.request()).status).toBe(502); expect(f.sendObservations).toEqual([1]);
    expect((await f.service.list('alice', 'session')).data[0]?.outcome).toMatchObject({ kind: 'unknown', reason: 'transport_failure' });
  });

  it('retains distinct checked credential revisions before the one 401 retry', async () => {
    let sends = 0;
    const f = await fixture({ authorize: async rejected => credential(rejected ? 2 : 1), upstream: (_request, response) => {
      response.writeHead(++sends === 1 ? 401 : 200, { 'content-type': 'text/event-stream' }); response.end('data: private-result\n\n');
    } });
    expect((await f.request()).status).toBe(200); expect(f.sendObservations).toEqual([1, 2]);
    expect(f.authorize.mock.calls).toEqual([[undefined], ['Bearer token-1']]);
    const receipts = (await f.service.list('alice', 'session')).data.sort((a, b) => a.attempt - b.attempt);
    expect(receipts.map(receipt => receipt.attempt)).toEqual([1, 2]);
    expect(receipts[0]!.requestId).toBe(receipts[1]!.requestId);
    expect(receipts.map(receipt => receipt.credential)).toEqual([credential(1).evidence, credential(2).evidence]);
    expect(receipts.map(receipt => receipt.outcome)).toEqual([expect.objectContaining({ httpStatus: 401, toolResult: 'unobserved' }), expect.objectContaining({ httpStatus: 200, toolResult: 'unobserved' })]);
  });

  it('keeps cancellation after send unknown without a replay', async () => {
    const abort = new AbortController();
    const f = await fixture({ signal: abort.signal, upstream: () => abort.abort() });
    expect((await f.request()).status).toBe(502); expect(f.sendObservations).toEqual([1]);
    expect((await f.service.list('alice', 'session')).data[0]?.outcome).toMatchObject({ kind: 'unknown', reason: 'cancelled' });
  });

  it('records denial of refreshed credentials without a second send', async () => {
    const f = await fixture({ authorize: async rejected => { if (rejected) throw new Error('archived private-token'); return credential(); },
      upstream: (_request, response) => { response.writeHead(401); response.end(); } });
    expect((await f.request()).status).toBe(502); expect(f.sendObservations).toEqual([1]);
    const receipts = (await f.service.list('alice', 'session')).data.sort((a, b) => a.attempt - b.attempt);
    expect(receipts).toHaveLength(2);
    expect(receipts[1]).toMatchObject({ attempt: 2, decision: 'deny', reason: 'credential_unavailable', outcome: { kind: 'not_dispatched' } });
  });

  it('sanitizes invalid guest tool labels in denied receipts', async () => {
    const f = await fixture();
    expect((await f.request(call('https://private-secret.example/path'))).status).toBe(502);
    expect((await f.service.list('alice', 'session')).data[0]).toMatchObject({ toolName: 'invalid', reason: 'invalid_call' });
    expect(JSON.stringify([...f.store.resources.values()])).not.toContain('private-secret');
    expect(f.authorize).not.toHaveBeenCalled();
  });

  it('wires audited launch bindings to live evidence without direct Vault secret reads', async () => {
    const store = new MemoryAgentsStore(); const service = new ToolAuthorizationService(store);
    const secrets = { get: vi.fn(async () => { throw new Error('Unexpected secret read'); }) };
    const authorizeMcp = vi.fn(async () => credential());
    const authorization = vi.fn(async () => { throw new Error('Unaudited authorization'); });
    const audit: SessionMcpAudit = { ownerId: 'alice', identity: { sessionId: 'session', agentId: 'agent', runId: 'run', generation: 'generation', runtimeEpoch: 0 },
      configuration: null, service, context: () => ({ kind: 'unresolved', reason: 'unavailable' }), assertActive: async () => {} };
    const runtime = await prepareSessionMcp('alice', { sessionId: 'session', turnId: 'stale-launch-turn', input: [],
      agent: sessionAgent({ model: 'test', tools: [{ type: 'mcp', server_label: 'crm', allowed_tools: ['lookup'], transport: { type: 'http', server_url: 'https://mcp.example/service' } }] }, 'agent', 1),
      environment: { type: 'none' }, mcp: [{ serverLabel: 'crm', vaultId: 'vault', credentialId: 'credential', vaultReference: 'private-reference' }] },
      secrets, undefined, { authorization, authorizeMcp }, undefined, undefined, audit);
    cleanup.push(runtime.close);
    const server = runtime.servers.crm as { url: string; bearer_token_env_var: string };
    expect((await fetch(server.url, { method: 'POST', headers: { authorization: `Bearer ${runtime.environment[server.bearer_token_env_var]}` }, body: JSON.stringify(call('erase')) })).status).toBe(502);
    expect(secrets.get).not.toHaveBeenCalled(); expect(authorizeMcp).not.toHaveBeenCalled(); expect(authorization).not.toHaveBeenCalled();
    expect((await service.list('alice', 'session')).data[0]).toMatchObject({ decision: 'deny', configuration: null, context: { kind: 'unresolved' } });
    const nativeFetch = globalThis.fetch;
    const transport = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => String(input) === 'https://mcp.example/service'
      ? Response.json({ result: {} }) : nativeFetch(input, init));
    try {
      expect((await nativeFetch(server.url, { method: 'POST', headers: { authorization: `Bearer ${runtime.environment[server.bearer_token_env_var]}` }, body: JSON.stringify(call()) })).status).toBe(200);
      expect(authorizeMcp).toHaveBeenCalledWith('alice', 'vault', 'credential', 'https://mcp.example/service', undefined);
      expect(authorization).not.toHaveBeenCalled(); expect(secrets.get).not.toHaveBeenCalled();
    } finally { transport.mockRestore(); }

  });

  it('observes reused root Turns and overlapping children without claiming an invocation match', async () => {
    let state: SessionRuntimeState | undefined;
    const f = await fixture({ runtime: () => state });
    const contexts: ToolAuthorizationReceipt[] = [];
    for (const next of [undefined, withTurns(turn('root-1')), withTurns(turn('root-1', 'completed'), turn('root-2')),
      withTurns(turn('root-2'), turn('child', 'in_progress', 'child')), withTurns(turn('root-2', 'completed'))]) {
      state = next; await f.request();
      contexts.push((await f.service.list('alice', 'session', { limit: 100 })).data.find(receipt => !contexts.some(context => context.id === receipt.id))!);
    }
    expect(contexts.map(receipt => receipt.context)).toEqual([{ kind: 'unresolved', reason: 'unavailable' }, { kind: 'single_active_turn', turnId: 'root-1' },
      { kind: 'single_active_turn', turnId: 'root-2' }, { kind: 'unresolved', reason: 'multiple_active_turns' }, { kind: 'unresolved', reason: 'no_active_turn' }]);
    expect(new Set(contexts.map(receipt => receipt.requestId)).size).toBe(5);
  });
});
