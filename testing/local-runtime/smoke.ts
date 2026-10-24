import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createLocalServices, LOCAL_OWNER } from '../../src/app/local-composition.js';
import { LocalSessionExecution } from '../../src/runner/local-session-execution.js';
import { localWorkerNames } from '../../src/domain/local-runtime.js';
import { NativeProofRuntime, nativeProofCpuCount } from './native-vm/worker/runtime.js';

const native = process.env.RAT_NATIVE_VM_PROOF === '1';
const directory = await mkdtemp(native ? resolve('.runtime/local-vm-worker/proof-') : join(tmpdir(), 'rat-worker-smoke-'));
if (native) console.log(`Native VM evidence: ${directory}`);
const nativeRuntimes: NativeProofRuntime[] = [];
const workspaceId = createHash('sha256').update(directory).digest('hex').slice(0, 16);
let sessionId: string | undefined;
const requests: Array<{ input: unknown }> = [];
const program = `const fs=require('node:fs');(async()=>{let networkBlocked=false;try{await fetch('http://127.0.0.1:3211',{signal:AbortSignal.timeout(1000)})}catch{networkBlocked=true}fs.writeFileSync('/workspace/proof.json',JSON.stringify({uid:process.getuid(),platform:process.platform,auth:fs.existsSync('/home/agent/.codex/auth.json'),socket:fs.existsSync('/var/run/docker.sock'),host:fs.existsSync(${JSON.stringify(directory)}),networkBlocked}));console.log('WORKER_COMMAND_PASSED')})()`;
const model = createServer(async (request, response) => {
  const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
  requests.push(JSON.parse(Buffer.concat(chunks).toString()));
  const item = requests.length === 1 ? { type: 'function_call', name: 'exec_command', id: 'command', call_id: 'command', arguments: JSON.stringify({ cmd: `node -e '${program.replaceAll("'", "'\\''")}'`, yield_time_ms: 1000, max_output_tokens: 1000 }) }
    : { type: 'message', id: `reply_${requests.length}`, role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Worker verified.' }] };
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end([{ type: 'response.created', response: { id: `response_${requests.length}` } }, { type: 'response.output_item.done', item }, { type: 'response.completed', response: { id: `response_${requests.length}` } }].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
});
model.listen(0, '127.0.0.1'); await once(model, 'listening');
const address = model.address(); if (!address || typeof address === 'string') throw new Error('Fixture has no address');
const launch = () => {
  const runtime = native ? new NativeProofRuntime(directory, undefined, nativeProofCpuCount(process.env.RAT_NATIVE_PROOF_CPUS)) : undefined;
  if (runtime) nativeRuntimes.push(runtime);
  return createLocalServices({ directory, ...(runtime ? { runtime } : {}), execution: (store, managed) => new LocalSessionExecution({ store, managed, directory, maxSessions: 2,
  environment: { PATH: process.env.PATH, HOME: directory, CODEX_HOME: directory, CODEX_BINARY: resolve('node_modules/.bin/codex') },
  request: request => ({ ...request, modelProvider: 'fixture', sessionConfig: { ...request.sessionConfig, 'model_providers.fixture': { name: 'fixture', base_url: `http://127.0.0.1:${address.port}`, wire_api: 'responses', requires_openai_auth: false, supports_websockets: false } } }),
}) });
};
let services = launch();
try {
  const session = await services.sessions.create(LOCAL_OWNER, { agent: { model: 'gpt-5.4', multi_agent: { enabled: false } }, environment: { type: 'openai_hosted', network: { access: 'disabled' }, setup_commands: [{ command: `node -e "const f=require('node:fs'); f.appendFileSync('/workspace/setup-count','once');"` }], files: [{ type: 'inline', path: '/workspace/example.txt', data: Buffer.from('local worker').toString('base64') }] }, input: 'Run the worker verification.' });
  sessionId = session.id;
  await services.sessions.dispatch(LOCAL_OWNER, session.id);
  let completed = false;
  for (let index = 0; index < 600; index++) {
    const turn = (await services.sessions.turns(LOCAL_OWNER, session.id)).data[0];
    if (turn?.status === 'completed') { completed = true; break; }
    if (turn?.status === 'failed') throw new Error(JSON.stringify(turn.error));
    await delay(100);
  }
  assert(completed, 'Worker Turn did not complete');
  const commandOutput = requests.flatMap(request => Array.isArray(request.input) ? request.input as unknown[] : [])
    .find(item => typeof item === 'object' && item !== null && 'type' in item && item.type === 'function_call_output' && 'call_id' in item && item.call_id === 'command');
  assert(commandOutput && typeof commandOutput === 'object' && 'output' in commandOutput && typeof commandOutput.output === 'string'
    && /^WORKER_COMMAND_PASSED\r?$/m.test(commandOutput.output), JSON.stringify(requests.at(-1)?.input));
  assert(session.environment.type === 'openai_hosted');
  assert((await services.environments.files(LOCAL_OWNER, session.environment.id)).data.some(file => file.path === '/workspace/proof.json'));
  await services.close();
  services = launch();
  await services.sessions.dispatch(LOCAL_OWNER, session.id);
  assert((await services.environments.files(LOCAL_OWNER, session.environment.id)).data.some(file => file.path === '/workspace/proof.json'));
  const snapshot = await services.sessions.snapshotForTransfer(LOCAL_OWNER, session.id, () => services.runtime.snapshot(session.id));
  const proof = snapshot.workspace.find(file => file.path === 'proof.json'); assert(proof);
  assert.deepEqual(JSON.parse(Buffer.from(proof.data, 'base64').toString()), { uid: 10001, platform: 'linux', auth: false, socket: false, host: false, networkBlocked: true });
  assert.equal(Buffer.from(snapshot.workspace.find(file => file.path === 'setup-count')!.data, 'base64').toString(), 'once');
  if (native) {
    await writeFile(join(directory, 'result.json'), JSON.stringify({ prototype: true, inference: 'fixture', networkDevices: 0, sharedHostPaths: 0,
      assertions: ['remote command execution', 'UID 10001', 'no guest auth file', 'no engine socket', 'no host path', 'command networking blocked', 'file protocol', 'workspace persistence after graceful restart', 'setup once', 'snapshot from read-only guest disk'],
      boots: nativeRuntimes.flatMap(runtime => runtime.boots), limitations: ['Not a distributed runtime', 'No live subscription inference', 'No abrupt filesystem recovery proof', 'Earlier guest kernel faults remain unexplained'],
    }, null, 2), { mode: 0o600 });
  }
  console.log('Remote command execution, isolated identity, file protocol, restart and snapshot passed with fixture inference.');
} finally {
  await services.close(); model.closeAllConnections(); await new Promise<void>(resolveClose => model.close(() => resolveClose()));
  if (!native) {
    if (sessionId) {
      const volume = localWorkerNames(workspaceId, sessionId).volume;
      await promisify(execFile)('docker', ['volume', 'rm', volume, `${volume}-state`]);
    }
    await rm(directory, { recursive: true, force: true });
  }
}
