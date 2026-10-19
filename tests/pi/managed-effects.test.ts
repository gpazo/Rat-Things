import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, access, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createPiEffectBroker } from '../../src/runner/pi-effect-broker.js';
import type { PiToolEffect } from '../../src/runner/pi/protocol.js';
import { planCodexLaunch } from '../../src/runner/agent-planning.js';
import { sessionAgent } from '../../src/core/session-planning.js';
import type { SessionLaunch } from '../../src/domain/session-execution.js';
import { publicTemplate } from '../../src/domain/environment-planning.js';
import type { NativeLease } from '../../src/core/session-native-store.js';

const binary = process.env.CODEX_CONFORMANCE_BINARY ?? resolve('node_modules/.bin/codex');
const effect = (name: string, args: PiToolEffect['arguments']): PiToolEffect => ({ kind: 'managed', name, arguments: args, callId: 'call', taskId: 1, conversationId: 1 });
const lease: NativeLease = { assertActive: async () => {}, load: async () => { throw new Error('Unexpected storage read'); }, commit: async () => { throw new Error('Unexpected commit'); }, reserveIds: async () => { throw new Error('Unexpected ID reservation'); } };

describe('Pi managed effect boundary', () => {
  it('enforces the fixed sandbox and targets cancellation without inference', async () => {
    const workspace = await mkdtemp('/tmp/rat-pi-effects-');
    const deniedRoot = await mkdtemp(resolve('.pi-denied-'));
    const deniedPath = join(deniedRoot, 'forbidden');
    let connections = 0;
    const server = createServer((_request, response) => { connections++; response.end('ok'); });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No listener');
    const endpoint = `http://127.0.0.1:${address.port}`;
    await fetch(endpoint); expect(connections).toBe(1);
    const launch: SessionLaunch = { sessionId: 'session', turnId: 'turn', agent: sessionAgent({ model: 'fixture' }, 'agent', 1), input: [],
      environment: { ...publicTemplate({ network: { access: 'disabled' } }, { id: 'env', created_at: 1, updated_at: 1 }), type: 'openai_hosted', files: [], skills: [] } };
    const plan = planCodexLaunch({ version: '1', source: { kind: 'api' }, prompt: 'unused' }, workspace, 15000, { CODEX_BINARY: binary, PATH: process.env.PATH });
    const broker = await createPiEffectBroker({ launch, plan, lease });
    const signal = new AbortController();
    try {
      const marker = join(workspace, 'started');
      const long = broker.execute(effect('exec_command', { command: [process.execPath, '-e', `require('node:fs').writeFileSync(process.argv[1],'ready');setInterval(()=>{},1000)`, marker] }), signal.signal);
      for (let attempt = 0; attempt < 100 && !await access(marker).then(() => true, () => false); attempt++) await delay(20);
      expect(await access(marker).then(() => true, () => false)).toBe(true);
      const short = await broker.execute(effect('exec_command', { command: [process.execPath, '-e', 'console.log("parallel-ok")'] }), new AbortController().signal);
      expect(short.output).toEqual([{ type: 'text', text: 'parallel-ok\n' }]);
      signal.abort(); expect((await long).isError).toBe(true);
      const denied = await broker.execute(effect('write_file', { path: deniedPath, content: 'denied' }), new AbortController().signal);
      expect(denied.isError).toBe(true); expect(await access(deniedPath).then(() => true, () => false)).toBe(false);
      const link = join(workspace, 'escape'); await symlink(deniedRoot, link);
      expect((await broker.execute(effect('write_file', { path: join(link, 'escape'), content: 'denied' }), new AbortController().signal)).isError).toBe(true);
      await broker.execute(effect('exec_command', { command: [process.execPath, '-e', 'fetch(process.argv[1],{signal:AbortSignal.timeout(1000)}).catch(()=>{})', endpoint] }), new AbortController().signal);
      expect(connections).toBe(1);
      const environment = await broker.execute(effect('exec_command', { command: [process.execPath, '-e', 'console.log(JSON.stringify(Object.keys(process.env).filter(k=>/AWS_|TOKEN|SECRET|API_KEY/.test(k))))'] }), new AbortController().signal);
      expect(environment.output).toEqual([{ type: 'text', text: '["CODEX_API_KEY"]\n' }]);
      await expect(broker.execute(effect('undeclared', {}), new AbortController().signal)).rejects.toThrow('capability envelope');
    } finally { signal.abort(); await broker.close(); server.closeAllConnections(); server.close(); await rm(workspace, { recursive: true, force: true }); await rm(deniedRoot, { recursive: true, force: true }); }
  }, 20000);
  it('exposes no filesystem or process tools without an environment', async () => {
    const launch: SessionLaunch = { sessionId: 'session', turnId: 'turn', agent: sessionAgent({ model: 'fixture' }, 'agent', 1), input: [], environment: { type: 'none' } };
    const plan = planCodexLaunch({ version: '1', source: { kind: 'api' }, prompt: 'unused' }, tmpdir(), 5000, { CODEX_BINARY: binary, PATH: process.env.PATH });
    const broker = await createPiEffectBroker({ launch, plan, lease });
    try { expect(broker.tools).toEqual([]); await expect(broker.execute(effect('exec_command', { command: ['true'] }), new AbortController().signal)).rejects.toThrow('capability envelope'); }
    finally { await broker.close(); }
  });
});
