import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { sessionAgent } from '../../src/core/session-planning.js';
import { SessionToolService } from '../../src/core/session-tool-service.js';
import { VaultService } from '../../src/core/vault-service.js';
import { createSessionMcpProxy, planMcpRequest } from '../../src/runner/session-mcp.js';
import type { AgentToolParam } from '../../src/domain/agents-api.js';
import type { SessionToolSecret } from '../../src/credentials/session-tools.js';
import { MemoryAgentsStore } from './fixtures.js';
import { rpcClient } from './codex-protocol.js';

describe('session MCP capabilities', () => {
  it('keeps inline credentials out of public settings and encrypted session metadata', async () => {
    const store = new MemoryAgentsStore();
    const secrets = new Map<string, SessionToolSecret>();
    const tools: AgentToolParam[] = [{ type: 'mcp', server_label: 'crm', transport: {
      type: 'http', server_url: 'https://crm.example/mcp', authorization: 'Bearer private-token', headers: { 'X-Private': 'private-header' },
    } }];
    const agent = sessionAgent({ model: 'test', tools }, 'agent_1', 1);
    const vaults = new VaultService({ store, secrets: { create: async () => { throw new Error('No vault secrets in this fixture'); }, read: async () => { throw new Error('No vault secrets in this fixture'); }, revoke: async () => {} } });
    const service = new SessionToolService({ store, vaults, secrets: {
      create: async (value) => { secrets.set('secret-ref', structuredClone(value)); return 'secret-ref'; },
      revoke: async (reference) => { secrets.delete(reference); },
    } });
    await service.prepare('alice', 'sess_1', agent, tools, []);
    expect(JSON.stringify(agent)).not.toContain('private-');
    expect(JSON.stringify([...store.resources.values()])).not.toContain('private-');
    expect(secrets.get('secret-ref')?.headers.Authorization).toBe('Bearer private-token');
    expect(agent.tools[0]).toMatchObject({ transport: { type: 'http', server_url: 'https://crm.example/mcp' } });
    await service.close('alice', 'sess_1');
    expect(secrets.size).toBe(0);
  });

  it('preserves falsey metadata and enforces the fixed MCP tool allowlist without mutating input', () => {
    const input = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'lookup', arguments: { query: '' }, _meta: { trace: 'caller', enabled: true } } };
    const before = structuredClone(input);
    expect(planMcpRequest(input, { enabled: false, limit: 0, trace: '' }, ['lookup'])).toMatchObject({ params: { _meta: { enabled: false, limit: 0, trace: '' } } });
    expect(input).toEqual(before);
    expect(() => planMcpRequest(input, {}, [])).toThrow('outside');
  });

  it('initializes a service MCP server from a Codex thread with no execution environment', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rat-mcp-conformance-'));
    const received: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
    const proxy = await createSessionMcpProxy({ serverURL: 'https://mcp.example/service', headers: { Authorization: 'Bearer vault-token' }, metadata: { tenant: 'alice' }, allowedTools: ['lookup'], fetch: async (_input, init) => {
      if (init?.method !== 'POST') return new Response(null, { status: 405 });
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      received.push({ headers: new Headers(init.headers), body });
      if (body.id === undefined) return new Response(null, { status: 202 });
      const result = body.method === 'initialize' ? { protocolVersion: (body.params as Record<string, unknown>).protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
        : body.method === 'tools/list' ? { tools: [{ name: 'lookup', description: 'Look up an item', inputSchema: { type: 'object', properties: {} } }] }
        : { content: [{ type: 'text', text: 'fixture' }] };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { headers: { 'content-type': 'application/json' } });
    } });
    const harness = spawn((process.env.CODEX_CONFORMANCE_BINARY ?? resolve('node_modules/.bin/codex')), ['app-server'], { env: { PATH: process.env.PATH, HOME: directory, CODEX_HOME: directory, CODEX_API_KEY: 'unused-test-key', RAT_MCP_KEY: proxy.key } });
    harness.stderr.resume();
    const rpc = rpcClient(harness);
    try {
      await rpc.call('initialize', { clientInfo: { name: 'rat-mcp-conformance', version: '1' }, capabilities: { experimentalApi: true } });
      harness.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
      const result = await rpc.call('thread/start', { cwd: directory, model: 'gpt-5.4', environments: [], selectedCapabilityRoots: [], approvalPolicy: 'never', ephemeral: true, config: { mcp_servers: { fixture: { url: proxy.url, bearer_token_env_var: 'RAT_MCP_KEY', required: true, enabled_tools: ['lookup'], default_tools_approval_mode: 'approve' } } } }) as { thread: { id: string } };
      const inventory = await rpc.call('mcpServerStatus/list', { threadId: result.thread.id, detail: 'toolsAndAuthOnly' });
      expect(inventory).toMatchObject({ data: [expect.objectContaining({ name: 'fixture', tools: expect.objectContaining({ lookup: expect.objectContaining({ name: 'lookup' }) }) })] });
      expect(received.some(({ body }) => body.method === 'tools/list')).toBe(true);
      expect(received.every(({ headers, body }) => headers.get('authorization') === 'Bearer vault-token' && (body.params as { _meta?: unknown })._meta && JSON.stringify(body.params).includes('alice'))).toBe(true);
      const count = received.length;
      const denied = await fetch(proxy.url, { method: 'POST', headers: { Authorization: `Bearer ${proxy.key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'delete_all' } }) });
      expect(denied.status).toBe(502);
      expect(received).toHaveLength(count);
    } finally {
      rpc.close(); harness.stdin.destroy(); harness.kill('SIGTERM');
      await Promise.race([once(harness, 'exit'), delay(1000)]);
      if (harness.exitCode === null && harness.signalCode === null) harness.kill('SIGKILL');
      await proxy.close(); await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);
});
