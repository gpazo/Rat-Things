import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { hostedCodexArguments } from '../../src/runner/hosted-environment-planning.js';
import { planSessionLaunch } from '../../src/runner/session-launch-planning.js';
import { sessionAgent } from '../../src/core/session-planning.js';
import { planCodexLaunch } from '../../src/runner/agent-planning.js';
import { rpcClient } from './codex-protocol.js';

describe('managed executor contract without inference', () => {
  it('selects a real network proxy and rejects a host outside the admitted list', async () => {
    const home = await mkdtemp(join(tmpdir(), 'rat-network-contract-'));
    const child = spawn((process.env.CODEX_CONFORMANCE_BINARY ?? resolve('node_modules/.bin/codex')), hostedCodexArguments(undefined, { access: 'restricted', allowed_domains: ['api.example.com'] }), {
      env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, CODEX_API_KEY: 'unused' }, cwd: home,
    });
    child.stderr.resume();
    const rpc = rpcClient(child);
    try {
      await rpc.call('initialize', { clientInfo: { name: 'rat-network-test', version: '1' }, capabilities: { experimentalApi: true } });
      child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
      // A public numeric address exercises the allowlist without DNS or an
      // external connection. A private/unresolvable host could fail earlier.
      // Use an explicit Agent: Node's environment-aware global Agent would
      // proxy this already-proxied request a second time.
      const result = await rpc.call('command/exec', {
        permissionProfile: 'rat_managed', cwd: '/tmp', timeoutMs: 3000,
        command: [process.execPath, '-e', `
          const http = require('node:http');
          if (process.env.CODEX_NETWORK_PROXY_ACTIVE !== '1') process.exit(2);
          const proxy = new URL(process.env.HTTP_PROXY);
          const req = http.request({ agent: new http.Agent(), hostname: proxy.hostname, port: proxy.port,
            path: 'http://1.1.1.1/', headers: { Host: '1.1.1.1' } }, response => {
            let body = ''; response.setEncoding('utf8');
            response.on('data', chunk => body += chunk);
            response.on('end', () => console.log(JSON.stringify({ status: response.statusCode, denial: JSON.parse(body) })));
          });
          req.on('error', error => {
            console.error(JSON.stringify({ code: error.code, syscall: error.syscall, address: error.address, port: error.port }));
            process.exitCode = 3;
          }); req.end();
        `],
      });
      expect(result, JSON.stringify(result)).toMatchObject({ exitCode: 0 });
      expect(JSON.parse((result as { stdout: string }).stdout)).toMatchObject({
        status: 403, denial: { host: '1.1.1.1', decision: 'deny', reason: 'not_allowed' },
      });
      const agent = sessionAgent({ model: 'gpt-5.4', multi_agent: { enabled: true, max_concurrent_subagents: 2 } }, 'agent_test', 1);
      const base = planCodexLaunch({ version: '1', prompt: 'test', agent: { sandbox: 'read-only' } }, home, 1000, { CODEX_AUTH_MODE: 'chatgpt' });
      const planned = planSessionLaunch(base, { sessionId: 'sess_test', turnId: 'turn_test', agent, environment: { type: 'none' }, input: [] });
      const started = await rpc.call('thread/start', {
        cwd: home, model: agent.model, approvalPolicy: 'never', sandbox: 'read-only', environments: [], ephemeral: true,
        config: planned.sessionConfig, selectedCapabilityRoots: [],
      });
      expect(started).toMatchObject({ thread: { id: expect.any(String) } });
    } finally {
      rpc.close(); child.stdin.destroy();
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
      await rm(home, { recursive: true, force: true });
    }
  }, 20_000);
});
