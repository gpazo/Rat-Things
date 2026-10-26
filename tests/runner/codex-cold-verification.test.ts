import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { chown, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { assertCheckpointStartupSafe, prepareCodexColdVerification } from '../../src/runner/codex-cold-verification.js';
import { CodexRpcClient } from '../../src/adapters/codex-rpc.js';
import { nativeThreadHistory, type NativeCheckpointManifest } from '../../src/domain/native-checkpoint.js';
import { stopCheckpointWriters } from '../../src/runner/checkpoint-writers.js';
import { syncWorkspaceStorage } from '../../src/runner/workspace-sync.js';

it.each(['hooks', 'mcp_servers', 'plugins', 'notify', 'apps', 'browser_use', 'computer_use', 'desktop'])('rejects active %s before shutdown', key => {
  expect(() => assertCheckpointStartupSafe({ config: { [key]: { enabled: true } } }, {})).toThrow('startup integrations');
  expect(() => assertCheckpointStartupSafe({ config: {} }, { [key]: ['active'] })).toThrow('startup integrations');
});
it('accepts absent defaults but rejects unknown native storage configuration', () => {
  expect(() => assertCheckpointStartupSafe({ config: { hooks: null, plugins: {}, mcp_servers: {}, notify: [] } }, {})).not.toThrow();
  expect(() => assertCheckpointStartupSafe({ config: { experimental_thread_store: true } }, {})).toThrow('storage');
});

// Run this in the disposable worker image as root, with its dedicated agent UID.
// It must never run in the user's host service or against their native home.
const guest = it.skipIf(process.env.CODEX_COLD_NATIVE_E2E !== 'true');
guest.each(['legacy', 'paginated'] as const)('verifies real root and child histories inside the offline namespace (%s)', async historyMode => {
  const f = await guestFixture(historyMode);
  try {
    const stages = new Set((await readdir(tmpdir())).filter(name => name.startsWith('rat-cold-native-')));
    const verifier = await prepareCodexColdVerification({ request: f.request, stateRoot: f.root, manifest: f.manifest });
    try {
      const stage = (await readdir(tmpdir())).find(name => name.startsWith('rat-cold-native-') && !stages.has(name));
      if (!stage) throw new Error('Missing private verifier staging directory');
      await hostileStagingAttempt(join(tmpdir(), stage), f.root);
      await f.stop();
      // Invalid synthetic auth would fail a verifier that accidentally copied it.
      await writeFile(join(f.home, 'auth.json'), '{"access_token":"SYNTHETIC_DO_NOT_USE"}');
      const before = f.requests();
      const evidence = await verifier.verify(f.manifest);
      expect(evidence).toMatchObject({ kind: 'codex-cold-native', threadIds: f.manifest.threads.map(thread => thread.id), historyModes: historyMode === 'legacy' ? ['legacy', 'paginated'] : ['paginated'] });
      expect(f.requests()).toBe(before);
      expect(await readFile(join(f.home, 'auth.json'), 'utf8')).toContain('SYNTHETIC_DO_NOT_USE');
    } finally { await verifier.close(); }
  } finally { await f.close(); }
}, 60_000);

guest.each(['legacy', 'paginated'] as const)('rejects a corrupt stopped candidate without removing its source (%s)', async historyMode => {
  const f = await guestFixture(historyMode);
  try {
    const verifier = await prepareCodexColdVerification({ request: f.request, stateRoot: f.root, manifest: f.manifest });
    try {
      await f.stop();
      if (historyMode === 'legacy') {
        for (const path of await files(join(f.home, 'sessions'))) if (path.endsWith('.jsonl')) await writeFile(path, '');
      } else {
        for (const path of await files(f.home)) if (/thread_history_\d+\.sqlite$/.test(path)) {
          await writeFile(path, 'corrupt'); await rm(`${path}-wal`, { force: true }); await rm(`${path}-shm`, { force: true });
        }
      }
      await syncWorkspaceStorage(f.root);
      await expect(verifier.verify(f.manifest)).rejects.toThrow();
      expect((await readdir(f.home)).length).toBeGreaterThan(0);
    } finally { await verifier.close(); }
  } finally { await f.close(); }
}, 60_000);

async function guestFixture(historyMode: 'legacy' | 'paginated') {
  if (process.getuid?.() !== 0) throw new Error('Run CODEX_COLD_NATIVE_E2E only as root in the disposable worker container');
  const root = await mkdtemp(join(tmpdir(), 'rat-native-cold-guest-'));
  const home = join(root, 'codex-home'); const workspace = join(root, 'workspace');
  const identity = { uid: 10001, gid: 10001 };
  await chown(root, identity.uid, identity.gid);
  for (const directory of [home, workspace, '/workspace']) { await mkdir(directory, { recursive: true }); await chown(directory, identity.uid, identity.gid); }
  let requests = 0; let rootRequests = 0;
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') { response.writeHead(426, { Connection: 'close' }).end(); return; }
    const parts: Buffer[] = []; for await (const part of request) parts.push(Buffer.from(part));
    if (!request.url?.endsWith('/responses')) { response.writeHead(404).end(); return; }
    const body = JSON.parse(Buffer.concat(parts).toString()) as { input: Array<{ type?: string; recipient?: string }> };
    requests++;
    const child = body.input.some(item => item.type === 'agent_message' && item.recipient === '/root/cold_child');
    if (!child) rootRequests++;
    const id = `response_${requests}`;
    const item = !child && rootRequests === 1
      ? { type: 'function_call', id: 'spawn', call_id: 'spawn', namespace: 'collaboration', name: 'spawn_agent', arguments: JSON.stringify({ task_name: 'cold_child', message: 'CHILD_INPUT', fork_turns: 'none' }) }
      : { type: 'message', id: `message_${requests}`, role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: child ? 'CHILD_PERSISTED' : 'ROOT_PERSISTED' }] };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end([{ type: 'response.created', response: { id } }, { type: 'response.output_item.done', item }, { type: 'response.completed', response: { id } }].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
  });
  server.on('upgrade', (_request, socket) => { socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  const completed = new Set<string>(); let childId: string | undefined; let childActivityDone = false;
  const binary = process.env.CODEX_CONFORMANCE_BINARY ?? resolve('node_modules/.bin/codex');
  const rpc = new CodexRpcClient({ binary, cwd: workspace, environment: { PATH: '/usr/bin:/bin', HOME: home, CODEX_HOME: home, CODEX_API_KEY: 'synthetic-loopback-fixture-only' }, identity,
    binaryArguments: ['-c', `openai_base_url="http://127.0.0.1:${address.port}"`, '-c', 'features.responses_websockets=false', '-c', 'features.responses_websockets_v2=false', 'app-server'],
    onEvent: event => {
      const value = event.params.item as { type?: string; agentThreadId?: string; kind?: string } | undefined;
      if (value?.type === 'subAgentActivity' && value.agentThreadId) { childId = value.agentThreadId; if (value.kind === 'completed') childActivityDone = true; }
      if (event.method === 'turn/completed') completed.add(String(event.params.threadId));
    } });
  let stopped = false;
  const close = async () => { await rpc.close(); await stopCheckpointWriters(identity.uid); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await rm(root, { recursive: true, force: true }); };
  try {
    await rpc.initialize().catch(error => { throw new Error('Source fixture initialize failed', { cause: error }); });
    const call = (method: string, params: unknown) => rpc.call(method, params).catch(error => { throw new Error(`Source fixture ${method} failed`, { cause: error }); });
    const started = await call('thread/start', { cwd: '/workspace', modelProvider: 'openai', model: 'gpt-5.5', historyMode, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: false,
      config: { openai_base_url: `http://127.0.0.1:${address.port}`, 'features.responses_websockets': false, 'features.responses_websockets_v2': false,
        'features.multi_agent': true, 'features.multi_agent_v2': true, 'features.plugins': false, 'features.apps': false, 'features.hooks': false, 'features.goals': false } }) as { thread: { id: string } };
    await call('turn/start', { threadId: started.thread.id, input: [{ type: 'text', text: 'ROOT_INPUT: delegate one child.' }] });
    for (let count = 0; count < 1500 && (!childId || !completed.has(started.thread.id) || !completed.has(childId) || !childActivityDone); count++) await delay(10);
    if (!childId || completed.size !== 2 || !childActivityDone) throw new Error('Native fixture did not complete');
    const threads: Record<string, unknown>[] = [];
    for (const threadId of [started.thread.id, childId]) {
      const result = await call('thread/read', { threadId, includeTurns: true }) as { thread: unknown };
      threads.push(nativeThreadHistory(result.thread));
    }
    const manifest: NativeCheckpointManifest = { rootThreadId: started.thread.id, hostJournalDigest: 'a'.repeat(64), threads };
    const request = { binary, workspace, executionWorkspace: '/workspace', environment: { CODEX_HOME: home }, identity, timeoutMs: 30_000, prompt: '', sandbox: 'read-only' as const, persistent: true, modelProvider: 'openai', networkAccess: false,
      managedPolicy: { workspace: '/workspace', network: { access: 'disabled' as const, allowed_domains: [] }, credentialProxy: false } };
    return { root, home, request, manifest, requests: () => requests, close,
      stop: async () => { if (stopped) return; await rpc.closeCheckpoint(); await stopCheckpointWriters(identity.uid); await syncWorkspaceStorage(root); stopped = true; } };
  } catch (error) { await close(); throw error; }
}
async function files(root: string): Promise<string[]> { return (await Promise.all((await readdir(root, { withFileTypes: true })).map(async entry => entry.isDirectory() ? files(join(root, entry.name)) : [join(root, entry.name)]))).flat(); }

async function hostileStagingAttempt(stage: string, root: string): Promise<void> {
  const victim = join(root, 'root-only-victim'); await mkdir(victim, { mode: 0o700 });
  const script = `const fs=require('node:fs');let blocked=0;for(const target of ['candidate','verify/home']){try{fs.symlinkSync(process.argv[2],process.argv[1]+'/'+target)}catch(error){if(['EACCES','EPERM','EEXIST'].includes(error.code))blocked++}};if(blocked!==2)process.exit(1);fs.writeFileSync(process.argv[1]+'/verify/home/config.toml','notify = ["false"]');`;
  const child = spawn(process.execPath, ['-e', script, stage, victim], { uid: 10001, gid: 10001, env: {}, stdio: 'ignore' });
  const [code] = await once(child, 'close'); expect(code).toBe(0);
  expect(await readdir(victim)).toEqual([]);
}
