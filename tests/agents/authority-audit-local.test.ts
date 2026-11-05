import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { SqliteAgentsStore } from '../../src/adapters/sqlite-agents-store.js';
import { ToolAuthorizationService } from '../../src/core/tool-authorization-service.js';
import { projectToolAuthorizationTrace } from '../../src/core/tool-authorization-traces.js';
import { createSessionMcpProxy } from '../../src/runner/session-mcp.js';
import { exportAuthorizationTraces } from '../../src/trace-export.js';

it('persists real HTTP MCP decisions in SQLite, preserves responses through an outcome outage, and exports after reopening', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rat-local-authority-'));
  let store: SqliteAgentsStore | undefined;
  let upstream: Server | undefined;
  let proxy: Awaited<ReturnType<typeof createSessionMcpProxy>> | undefined;
  try {
    store = new SqliteAgentsStore(directory);
    let service = new ToolAuthorizationService(store);
    const upstreamDecisions: number[] = [];
    const receivedExports: unknown[] = [];
    upstream = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString());
      if (request.url === '/v1/traces') {
        receivedExports.push(body);
        response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
        return;
      }
      upstreamDecisions.push((await service.list('local-owner', 'local-session')).data.length);
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: 1,
        result: { content: [{ type: 'text', text: `local-result-${upstreamDecisions.length}` }] } }));
    });
    upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('Fixture listener is unavailable');
    let loseOutcome = true;
    proxy = await createSessionMcpProxy({
      serverURL: 'https://fixture.invalid/mcp', serverLabel: 'fixture', headers: {}, metadata: {}, allowedTools: ['lookup'],
      audit: { ownerId: 'local-owner', identity: { sessionId: 'local-session', agentId: 'local-agent', runId: 'local-run', generation: '1', runtimeEpoch: 0 },
        configuration: null, context: () => ({ kind: 'unresolved', reason: 'unavailable' }), assertActive: async () => {},
        service: { record: (owner, decisions) => service.record(owner, decisions), recordOutcome: (owner, session, ids, outcome) => {
          if (loseOutcome) { loseOutcome = false; return Promise.reject(new Error('Synthetic observation outage')); }
          return service.recordOutcome(owner, session, ids, outcome);
        } },
      },
      authorize: async () => ({ authorization: 'Bearer synthetic-local-secret', evidence: { kind: 'inline_snapshot' } }),
      // Only the test transport maps HTTPS to a loopback fixture; production validation stays enabled.
      fetch: async (_url, init) => fetch(`http://127.0.0.1:${address.port}/mcp`, init),
    });
    const connection = proxy;
    const request = (name: string) => fetch(connection.url, { method: 'POST', headers: { authorization: `Bearer ${connection.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { private: 'argument-sentinel' } } }) });
    const first = await request('lookup');
    expect(first.status).toBe(200);
    expect(await first.text()).toContain('local-result-1');
    const firstPage = await service.list('local-owner', 'local-session');
    expect(firstPage.data[0]).toMatchObject({ decision: 'allow', outcome: { kind: 'unknown', reason: 'no_observation' } });
    const second = await request('lookup');
    expect(second.status).toBe(200);
    expect(await second.text()).toContain('local-result-2');
    expect((await request('delete_everything')).status).toBe(502);
    expect(upstreamDecisions).toEqual([1, 2]);
    await proxy.close();
    const before = await service.list('local-owner', 'local-session', { order: 'asc' });
    expect(before.data).toHaveLength(3);
    expect(before.data.filter(value => value.decision === 'deny')).toEqual([expect.objectContaining({ reason: 'tool_not_admitted', outcome: { kind: 'not_dispatched', at: expect.any(Number) } })]);
    store.close();
    store = new SqliteAgentsStore(directory);
    service = new ToolAuthorizationService(store);
    expect(await service.list('local-owner', 'local-session', { order: 'asc' })).toEqual(before);
    expect((await service.list('other-owner', 'local-session')).data).toEqual([]);
    const exported = await exportAuthorizationTraces(async query => {
      const page = await service.list('local-owner', 'local-session', query);
      return { ...page, data: page.data.map(receipt => projectToolAuthorizationTrace('local-owner', receipt)) };
    }, { limit: 1 });
    expect(exported.resourceSpans).toHaveLength(3);
    for (const value of [before, exported]) {
      for (const secret of ['synthetic-local-secret', 'argument-sentinel', 'local-result-', 'fixture.invalid']) expect(JSON.stringify(value)).not.toContain(secret);
    }
    const accepted = await fetch(`http://127.0.0.1:${address.port}/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(exported) });
    expect(accepted.status).toBe(200);
    expect(receivedExports).toEqual([exported]);
  } finally {
    await proxy?.close();
    if (upstream) {
      upstream.closeAllConnections();
      await new Promise<void>(resolve => upstream!.close(() => resolve()));
    }
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
