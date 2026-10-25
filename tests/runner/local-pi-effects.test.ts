import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { openLocalPiEffects } from '../../src/runner/local-pi-effects.js';
import type { PiToolEffect } from '../../src/runner/pi/protocol.js';

const effect: PiToolEffect = { kind: 'managed', name: 'exec_command', arguments: { command: ['wait'] }, callId: 'one', taskId: 1, conversationId: 1 };
async function fixture(failure = '') {
  const directory = await mkdtemp(join(tmpdir(), 'rat-pi-client-'));
  const binary = join(directory, 'codex'); const evidence = join(directory, 'evidence.json');
  const owner = { sessionId: 'sess_one', environmentId: 'env_one', generation: 'workspace-one', runId: randomUUID(), epoch: 4 };
  await writeFile(binary, `#!${process.execPath}
const fs=require('node:fs');const readline=require('node:readline');
const evidence={args:process.argv.slice(2),env:process.env,home:fs.readdirSync(process.env.HOME),calls:[]};
const reply=(id,result)=>process.stdout.write(JSON.stringify({id,result})+'\\n');
let pending;
readline.createInterface({input:process.stdin}).on('line',line=>{
const r=JSON.parse(line);evidence.calls.push(r);fs.writeFileSync(${JSON.stringify(evidence)},JSON.stringify(evidence));
if(r.id===undefined)return;
if(r.method==='environment/status')return reply(r.id,{status:'ready'});
if(r.method==='thread/start')return reply(r.id,{thread:{id:'thread_one'}});
if(r.method!=='mcpServer/tool/call')return reply(r.id,{});
const a=r.params.arguments;
const result=value=>reply(r.id,{content:[{type:'text',text:JSON.stringify(value)}]});
if(a.operation===${JSON.stringify(failure)})return reply(r.id,{isError:true,content:[]});
if(a.operation==='ready')return result(${JSON.stringify(owner)});
if(a.operation==='execute'){pending=r.id;return;}
if(a.operation==='cancel'){reply(pending,{content:[{type:'text',text:JSON.stringify({output:[],isError:true})}]});return result({stopped:true});}
if(a.operation==='close')return result({stopped:true});
});`); await chmod(binary, 0o700);
  const stopWorker = vi.fn(async () => {}); const assertActive = vi.fn(async () => {});
  const open = () => openLocalPiEffects({ ...owner, host: { binary, environment: { PATH: process.env.PATH, CODEX_API_KEY: 'never-pass', OPENAI_API_KEY: 'never-pass', NODE_OPTIONS: '--never-pass' } },
    connection: { url: 'http://127.0.0.1:3211', harnessKey: 'fixture-harness' }, lease: { assertActive }, stopWorker });
  const observed = async () => JSON.parse(await readFile(evidence, 'utf8'));
  return { directory, open, observed, stopWorker, assertActive, owner };
}

it('isolates host startup and confirms cancellation before returning, without model inference', async () => {
  const f = await fixture(); const client = await f.open();
  try {
    const startup = await f.observed();
    expect(startup.home).toEqual([]);
    expect(startup.env.CODEX_API_KEY).toBeUndefined(); expect(startup.env.OPENAI_API_KEY).toBeUndefined(); expect(startup.env.NODE_OPTIONS).toBeUndefined();
    expect(startup.args).toEqual(expect.arrayContaining(['features.plugins=false', 'features.apps=false', 'features.hooks=false', 'notify=[]']));
    expect(startup.calls.find((call: { method: string }) => call.method === 'thread/start').params.config.mcp_servers.rat_pi)
      .toMatchObject({ command: 'node', args: ['/opt/rat-things/local-worker.mjs', '--pi-effects', f.owner.runId, '4'], environment_id: 'remote', required: true });
    const abort = new AbortController(); const pending = client.execute(effect, abort.signal);
    await expect.poll(async () => (await f.observed()).calls.some((call: { params?: { arguments?: { operation: string } } }) => call.params?.arguments?.operation === 'execute')).toBe(true);
    abort.abort(); expect(await pending).toEqual({ output: [], isError: true });
    expect(f.stopWorker).not.toHaveBeenCalled();
    await client.close(); await client.close();
    await expect(lstat(startup.env.CODEX_HOME)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await client.close(); await rm(f.directory, { recursive: true, force: true }); }
});

it.each(['ready', 'close', 'cancel'])('stops and poisons the worker when %s acknowledgement fails', async failure => {
  const f = await fixture(failure);
  try {
    if (failure === 'ready') await expect(f.open()).rejects.toThrow('bridge response');
    else {
      const client = await f.open();
      if (failure === 'close') {
        await expect(Promise.all([client.close(), client.close()])).resolves.toEqual([undefined, undefined]);
        await client.close();
      }
      else {
        const abort = new AbortController(); const pending = client.execute(effect, abort.signal);
        const rejected = expect(pending).rejects.toThrow();
        await expect.poll(async () => (await f.observed()).calls.some((call: { params?: { arguments?: { operation: string } } }) => call.params?.arguments?.operation === 'execute')).toBe(true);
        abort.abort(); await rejected; await client.close();
      }
      await expect(client.execute(effect, new AbortController().signal)).rejects.toThrow('unavailable');
    }
    expect(f.stopWorker).toHaveBeenCalledOnce();
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

it('keeps cleanup failed when the fallback cannot confirm worker shutdown', async () => {
  const f = await fixture('close');
  f.stopWorker.mockRejectedValue(new Error('Worker shutdown unconfirmed'));
  const client = await f.open();
  try {
    await expect(client.close()).rejects.toThrow('Pi bridge close and cleanup failed');
    await expect(client.close()).rejects.toThrow('Pi bridge close and cleanup failed');
    await expect(client.execute(effect, new AbortController().signal)).rejects.toThrow('unavailable');
    expect(f.stopWorker).toHaveBeenCalledOnce();
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

it('rejects a stale lease and pre-aborted call before remote dispatch', async () => {
  const f = await fixture(); const client = await f.open();
  try {
    const abort = new AbortController(); abort.abort();
    await expect(client.execute(effect, abort.signal)).rejects.toThrow();
    f.assertActive.mockRejectedValueOnce(new Error('stale lease'));
    await expect(client.execute(effect, new AbortController().signal)).rejects.toThrow('stale lease');
    expect((await f.observed()).calls.filter((call: { params?: { arguments?: { operation: string } } }) => call.params?.arguments?.operation === 'execute')).toEqual([]);
    expect(f.stopWorker).not.toHaveBeenCalled();
  } finally { await client.close(); await rm(f.directory, { recursive: true, force: true }); }
});
