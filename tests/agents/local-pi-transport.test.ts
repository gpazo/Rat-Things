import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { createEnvironmentRelay } from '../../src/adapters/environment-relay.js';
import { CodexRpcClient } from '../../src/adapters/codex-rpc.js';
import { isolatedCodexArguments } from '../../src/domain/local-codex-arguments.js';

it('delivers cancellation concurrently through the real remote MCP transport', async () => {
  const home = await mkdtemp(join(tmpdir(), 'rat-pi-transport-'));
  const fixture = join(home, 'fixture.mjs');
  await writeFile(fixture, `import {createInterface} from 'node:readline';
const waiting=new Map();
const reply=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
const r=JSON.parse(line);if(r.id===undefined)return;
if(r.method==='initialize')return reply(r.id,{protocolVersion:r.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}});
if(r.method==='tools/list')return reply(r.id,{tools:[{name:'bridge',description:'fixture',inputSchema:{type:'object'}}]});
if(r.method==='tools/call'){
const a=r.params.arguments;
if(a.operation==='wait'){waiting.set(a.id,r.id);return;}
if(a.operation==='cancel'){const id=waiting.get(a.id);if(id===undefined)throw Error('not started');reply(id,{content:[{type:'text',text:'stopped'}]});waiting.delete(a.id);return reply(r.id,{content:[{type:'text',text:'cancelled'}]});}
return reply(r.id,{content:[{type:'text',text:String(waiting.size)}]});
}
reply(r.id,{});
});`);
  let address = '';
  let connected = false;
  const relay = createEnvironmentRelay({ healthEnvironmentId: 'env_fixture', publicURL: () => address, environments: {
    authenticate: async (_token, environmentId, role) => ({ ownerId: 'fixture', environmentId, role }),
    connection: async (_identity, _registration, ready) => { connected = ready; },
  } });
  relay.server.listen(0, '127.0.0.1'); await once(relay.server, 'listening');
  const bound = relay.server.address(); if (!bound || typeof bound === 'string') throw new Error('No relay');
  address = `http://127.0.0.1:${bound.port}`;
  const binary = process.env.CODEX_CONFORMANCE_BINARY ?? resolve('node_modules/.bin/codex');
  const executor = spawn(binary, ['exec-server', '--remote', address, '--environment-id', 'env_fixture'], {
    env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, CODEX_API_KEY: 'fixture-executor' }, detached: true,
  });
  executor.stdout.resume(); executor.stderr.resume();
  const rpc = new CodexRpcClient({ binary, binaryArguments: isolatedCodexArguments(['app-server']), cwd: home,
    environment: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, CODEX_API_KEY: 'unused-fixture', CODEX_EXEC_SERVER_NOISE_REGISTRY_URL: address,
      CODEX_EXEC_SERVER_NOISE_ENVIRONMENT_ID: 'env_fixture', CODEX_EXEC_SERVER_NOISE_AUTH_TOKEN: 'fixture-harness' } });
  try {
    await expect.poll(() => connected, { timeout: 5000 }).toBe(true);
    await expect.poll(async () => (await fetch(`${address}/health`)).status, { timeout: 5000 }).toBe(200);
    await rpc.initialize();
    await expect.poll(() => rpc.call('environment/status', { environmentId: 'remote' }), { timeout: 5000 }).toMatchObject({ status: 'ready' });
    const start = await rpc.call('thread/start', { cwd: home, environments: [{ environmentId: 'remote', cwd: home }], ephemeral: true,
      approvalPolicy: 'never', sandbox: 'danger-full-access', selectedCapabilityRoots: [], config: { mcp_servers: { fixture: {
        command: process.execPath, args: [fixture], cwd: home, environment_id: 'remote', required: true, enabled_tools: ['bridge'], default_tools_approval_mode: 'approve',
      } } } }) as { thread: { id: string } };
    const call = (operation: string) => rpc.call('mcpServer/tool/call', { threadId: start.thread.id, server: 'fixture', tool: 'bridge', arguments: { operation, id: 'one' } }, 5000);
    const pending = call('wait');
    await expect.poll(() => call('status')).toMatchObject({ content: [{ text: '1' }] });
    expect(await call('cancel')).toMatchObject({ content: [{ text: 'cancelled' }] });
    expect(await pending).toMatchObject({ content: [{ text: 'stopped' }] });
  } finally {
    await rpc.close();
    if (executor.pid) { try { process.kill(-executor.pid, 'SIGTERM'); } catch {} }
    await Promise.race([once(executor, 'exit'), delay(1000)]);
    if (executor.pid) { try { process.kill(-executor.pid, 'SIGKILL'); } catch {} }
    await relay.close(); await rm(home, { recursive: true, force: true });
  }
}, 20000);
