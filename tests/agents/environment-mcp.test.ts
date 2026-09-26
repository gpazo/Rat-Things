import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import worker from '../../src/runner/environment-mcp-worker-source.json' with { type: 'json' };
import { rpcClient } from './codex-protocol.js';
import { prepareSessionMcp } from '../../src/runner/session-mcp.js';
import { sessionAgent } from '../../src/core/session-planning.js';
import { hostedCodexArguments } from '../../src/runner/hosted-environment-planning.js';

describe('MCP connections from the environment', () => {
  it('resumes a tool response from an empty SSE priming event without repeating its POST', async () => {
    let posts = 0;
    let callId: number | undefined;
    let disconnectedAt = 0;
    const cursors: string[] = [];
    const server = createServer(async (request, response) => {
      if (request.method === 'GET') {
        cursors.push(String(request.headers['last-event-id']));
        expect(Date.now() - disconnectedAt).toBeGreaterThanOrEqual(50);
        response.writeHead(200, { 'content-type': 'text/event-stream' }).end(`id: tool-complete\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: callId, result: { content: [{ type: 'text', text: 'saved once' }] } })}\n\n`);
        return;
      }
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { id: number; method: string };
      if (body.method === 'initialize') {
        response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'tool-session' }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-11-25' } }));
      } else {
        posts++; callId = body.id; disconnectedAt = Date.now();
        response.writeHead(200, { 'content-type': 'text/event-stream' }).end('id: tool-start\nretry: 60\ndata:\n\n');
      }
    });
    const { child, rpc, close } = await bridge(server);
    child.stderr.resume();
    try {
      await rpc.call('initialize', { protocolVersion: '2025-11-25' });
      expect(await rpc.call('tools/call', { name: 'save', arguments: {} })).toEqual({ content: [{ type: 'text', text: 'saved once' }] });
      expect(posts).toBe(1); expect(cursors).toEqual(['tool-start']);
    } finally { await close(); }
  });

  it('reinitializes one expired HTTP session for concurrent callers without replaying their rejected effects', async () => {
    let initializations = 0;
    let calls = 0;
    const expired: import('node:http').ServerResponse[] = [];
    const server = createServer(async (request, response) => {
      if (request.method !== 'POST') { response.writeHead(405).end(); return; }
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { id: number; method: string };
      if (body.method === 'initialize') {
        expect(request.headers['mcp-session-id']).toBeUndefined();
        response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': `session-${++initializations}` }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-11-25' } }));
      } else if (body.method === 'notifications/initialized') response.writeHead(202).end();
      else {
        calls++;
        if (request.headers['mcp-session-id'] === 'session-1') {
          expired.push(response);
          if (expired.length === 2) for (const rejected of expired) rejected.writeHead(404).end();
        } else response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'new session' }] } }));
      }
    });
    const { rpc, close } = await bridge(server);
    try {
      await rpc.call('initialize', { protocolVersion: '2025-11-25' });
      const rejected = await Promise.allSettled([rpc.call('tools/call', { name: 'save', arguments: {} }), rpc.call('tools/call', { name: 'save', arguments: {} })]);
      expect(rejected.map(result => result.status)).toEqual(['rejected', 'rejected']);
      expect(initializations).toBe(2); expect(calls).toBe(2);
      expect(await rpc.call('tools/call', { name: 'save', arguments: {} })).toEqual({ content: [{ type: 'text', text: 'new session' }] });
      expect(initializations).toBe(2); expect(calls).toBe(3);
    } finally { await close(); }
  });

  it('resumes interrupted notifications at their event cursor without repeating a tool POST', async () => {
    const requests: Array<{ method: string; cursor: string | undefined; session: string | undefined }> = [];
    let toolCalls = 0;
    let initialized = false;
    const server = createServer(async (request, response) => {
      requests.push({ method: request.method!, cursor: request.headers['last-event-id'] as string | undefined, session: request.headers['mcp-session-id'] as string | undefined });
      if (request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const cursor = request.headers['last-event-id'];
        if (!cursor) {
          response.write('id: notification-1\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{"data":"before disconnect"}}\n\n');
          // The bytes must reach the bridge before the connection disappears.
          await delay(50); response.destroy();
        } else if (cursor === 'notification-1') {
          response.end('id: notification-2\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{"data":"after reconnect"}}\n\n');
        }
        return;
      }
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { id?: number; method: string };
      if (body.method === 'notifications/initialized') { initialized = true; response.writeHead(202).end(); return; }
      if (body.method === 'tools/call') { toolCalls++; response.destroy(); return; }
      response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'resume-session' }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id,
        result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'reconnect', version: '1' } } }));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing server address');
    const child = spawn(process.execPath, ['--input-type=module', '-e', worker, JSON.stringify({
      transport: { type: 'http', server_url: `http://127.0.0.1:${address.port}/mcp` }, metadata: {}, allowedTools: ['save'], headerEnv: {},
    })], { env: { PATH: process.env.PATH } });
    child.stderr.resume(); const rpc = rpcClient(child);
    const notifications: string[] = [];
    const reader = createInterface({ input: child.stdout });
    reader.on('line', line => { const message = JSON.parse(line); if (message.method === 'notifications/message') notifications.push(message.params.data); });
    try {
      await rpc.call('initialize', { protocolVersion: '2025-03-26' });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      await expect.poll(() => notifications, { timeout: 5000 }).toEqual(['before disconnect', 'after reconnect']);
      expect(initialized).toBe(true);
      expect(requests.filter(request => request.method === 'GET').slice(0, 2)).toEqual([
        { method: 'GET', session: 'resume-session', cursor: undefined },
        { method: 'GET', session: 'resume-session', cursor: 'notification-1' },
      ]);
      await expect(rpc.call('tools/call', { name: 'save', arguments: {} })).rejects.toThrow('Environment MCP request failed');
      await delay(1200);
      expect(toolCalls).toBe(1);
      expect(notifications).toEqual(['before disconnect', 'after reconnect']);
    } finally {
      reader.close(); rpc.close(); child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }, 15_000);

  it('adds metadata and headers at the environment and denies undeclared tools before connecting', async () => {
    const received: Array<{ method: string; params: unknown; token: string | undefined; protocol: string | string[] | undefined }> = [];
    const server = createServer(async (request, response) => {
      if (request.method !== 'POST') { response.writeHead(405).end(); return; }
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { id: number; method: string; params: unknown };
      received.push({ method: body.method, params: body.params, token: request.headers.authorization, protocol: request.headers['mcp-protocol-version'] });
      response.writeHead(200, { 'content-type': body.method === 'tools/call' ? 'text/event-stream' : 'application/json', 'mcp-session-id': 'session-test' });
      const result = JSON.stringify({ jsonrpc: '2.0', id: body.id, result: body.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } } : { content: [{ type: 'text', text: 'result' }] } });
      response.end(body.method === 'tools/call' ? `data: ${result}\n\n` : result);
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing server address');
    const child = spawn(process.execPath, ['--input-type=module', '-e', worker, JSON.stringify({
      transport: { type: 'http', server_url: `http://127.0.0.1:${address.port}/mcp` }, metadata: { tenant: 'alice', enabled: false }, allowedTools: ['lookup'], headerEnv: { Authorization: 'TEST_MCP_KEY' },
    })], { env: { PATH: process.env.PATH, TEST_MCP_KEY: 'Bearer private-header' } });
    child.stderr.resume(); const rpc = rpcClient(child);
    try {
      await rpc.call('initialize', { protocolVersion: '2025-11-25' });
      expect(await rpc.call('tools/call', { name: 'lookup', arguments: {}, _meta: { tenant: 'wrong' } })).toMatchObject({ content: [{ text: 'result' }] });
      expect(received).toHaveLength(2);
      expect(received[1]).toMatchObject({ params: { _meta: { tenant: 'alice', enabled: false } }, token: 'Bearer private-header', protocol: '2025-03-26' });
      await expect(rpc.call('tools/call', { name: 'delete_all' })).rejects.toThrow('Environment MCP request failed');
      expect(received).toHaveLength(2);
    } finally {
      rpc.close(); child.stdin.end(); await once(child, 'exit');
      server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('runs the managed stdio bridge inside the stock sandbox with enforced egress', async () => {
    const home = await mkdtemp(join(tmpdir(), 'rat-mcp-network-'));
    // Address the proxy once, independently of Node's environment-aware global
    // Agent. A public numeric host tests allowlist denial without DNS.
    const program = `const http = require('node:http'); require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      const request = JSON.parse(line); if (request.id === undefined) return;
      if (process.env.CODEX_NETWORK_PROXY_ACTIVE !== '1') process.exit(2);
      const proxy = new URL(process.env.HTTP_PROXY);
      const call = http.request({agent:new http.Agent(),hostname:proxy.hostname,port:proxy.port,path:'http://1.1.1.1/',headers:{host:'1.1.1.1'}}, response => {
        let body = ''; response.setEncoding('utf8'); response.on('data', chunk => body += chunk);
        response.on('end', () => console.log(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{network_status:response.statusCode,denial:JSON.parse(body)}})));
      }); call.on('error',()=>process.exit(3)); call.end();
    });`;
    const child = spawn((process.env.CODEX_CONFORMANCE_BINARY ?? resolve('node_modules/.bin/codex')), hostedCodexArguments(['sandbox', '--permission-profile', 'rat_managed', '--', process.execPath, '--input-type=module', '-e', worker, JSON.stringify({
      transport: { type: 'stdio', command: process.execPath, args: ['-e', program], cwd: '/tmp' }, metadata: {}, allowedTools: null, headerEnv: {},
    })], { access: 'restricted', allowed_domains: ['api.example.com'] }), { cwd: home, env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home } });
    child.stderr.resume(); const rpc = rpcClient(child);
    try {
      expect(await rpc.call('initialize', { protocolVersion: '2025-03-26' })).toMatchObject({
        network_status: 403, denial: { host: '1.1.1.1', decision: 'deny', reason: 'not_allowed' },
      });
    }
    finally {
      rpc.close(); child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
      await rm(home, { recursive: true, force: true });
    }
  }, 15_000);

  it('wraps managed stdio processes in the immutable network profile', async () => {
    const agent = sessionAgent({ model: 'test', tools: [{ type: 'mcp', server_label: 'local', transport: { type: 'stdio', command: 'node', args: ['server.js'], cwd: '/workspace' }, request_metadata: { tenant: 'alice' } }] }, 'agent_test', 1);
    const environment = { id: 'env_test', type: 'openai_hosted' as const, capability_directories: [], files: [], skills: [], plugins: [], packages: { npm: [], python: [], system: [] }, network: { access: 'restricted' as const, allowed_domains: ['api.example.com'] } };
    const credentials = { processEnvironment: { NO_PROXY: '*' }, shellEnvironment: { SERVICE_TOKEN: 'placeholder', HTTPS_PROXY: 'http://127.0.0.1:1234', NO_PROXY: '' }, close: async () => {} };
    const mcp = await prepareSessionMcp('alice', { sessionId: 'sess_test', turnId: 'turn_test', environment, agent, input: [] }, { get: async () => { throw new Error('No secrets'); } }, undefined, undefined, credentials);
    try {
      expect(mcp.servers.local).toMatchObject({ command: 'codex', environment_id: 'local' });
      const args = (mcp.servers.local as { args: string[] }).args;
      expect(args).toContain('sandbox'); expect(args).toContain('--permission-profile'); expect(args).toContain('rat_managed');
      expect(args.join(' ')).toContain('"api.example.com" = "allow"');
      expect(args.join(' ')).toContain('allow_upstream_proxy = true');
      expect(mcp.servers.local).toMatchObject({ env: credentials.shellEnvironment });
    } finally { await mcp.close(); }
  });
});

async function bridge(server: ReturnType<typeof createServer>) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing server address');
  const child = spawn(process.execPath, ['--input-type=module', '-e', worker, JSON.stringify({
    transport: { type: 'http', server_url: `http://127.0.0.1:${address.port}/mcp` }, metadata: {}, allowedTools: ['save'], headerEnv: {},
  })], { env: { PATH: process.env.PATH } });
  child.stderr.resume(); const rpc = rpcClient(child);
  return { child, rpc, close: async () => {
    rpc.close(); child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}
