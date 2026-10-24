import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { createLocalServices, LOCAL_OWNER } from '../../src/app/local-composition.js';
import { LocalSubscription } from '../../src/runner/local-subscription.js';
import { LocalSessionExecution } from '../../src/runner/local-session-execution.js';
import { NativeProofRuntime, nativeProofCpuCount } from './native-vm/worker/runtime.js';

if (process.env.RAT_LIVE_SUBSCRIPTION !== '1') throw new Error('Set RAT_LIVE_SUBSCRIPTION=1 to run real ChatGPT subscription inference');
const { values } = parseArgs({ options: { directory: { type: 'string' }, model: { type: 'string' }, runtime: { type: 'string', default: 'native-proof' } } });
if (!values.directory) throw new Error('Choose a persistent Rat Things directory with --directory');
if (!['native-proof', 'container'].includes(values.runtime)) throw new Error('Choose --runtime native-proof or container');
const directory = resolve(values.directory);
const account = new LocalSubscription(directory);
try {
  const status = await account.status();
  if (!status.signed_in || status.account_type !== 'chatgpt') throw new Error(`ChatGPT sign-in required. Run rat-things login with RAT_THINGS_LOCAL_DIR set to ${directory}`);
} finally { await account.close(); }

const nativeRuntimes: NativeProofRuntime[] = [];
const commandEvents: unknown[] = [];
const launch = () => {
  const runtime = values.runtime === 'native-proof' ? new NativeProofRuntime(directory, undefined, nativeProofCpuCount(process.env.RAT_NATIVE_PROOF_CPUS)) : undefined;
  if (runtime) nativeRuntimes.push(runtime);
  return createLocalServices({ directory, maxSessions: 1, ...(runtime ? { runtime } : {}),
    execution: (store, managed) => new LocalSessionExecution({ store, managed, directory, maxSessions: 1,
      request: request => ({ ...request, onEvent: event => {
        const params = event.params;
        const item = params.item as Record<string, unknown> | undefined;
        if (item?.type === 'commandExecution') commandEvents.push({ method: event.method, id: item.id,
          outputType: typeof item.aggregatedOutput, outputBytes: typeof item.aggregatedOutput === 'string' ? Buffer.byteLength(item.aggregatedOutput) : null,
          exitCode: item.exitCode, status: item.status });
        if (event.method === 'item/commandExecution/outputDelta') commandEvents.push({ method: event.method, id: params.itemId,
          outputBytes: typeof params.delta === 'string' ? Buffer.byteLength(params.delta) : null });
        if (event.method === 'turn/completed') {
          const turn = params.turn as { items?: Array<Record<string, unknown>> } | undefined;
          for (const entry of turn?.items ?? []) if (entry.type === 'commandExecution') commandEvents.push({ method: event.method, id: entry.id,
            outputType: typeof entry.aggregatedOutput, outputBytes: typeof entry.aggregatedOutput === 'string' ? Buffer.byteLength(entry.aggregatedOutput) : null,
            exitCode: entry.exitCode, status: entry.status });
        }
        if (event.method === 'error') {
          const error = params.error as { message?: string; codexErrorInfo?: unknown } | undefined;
          commandEvents.push({ method: 'error', badRequest: error?.codexErrorInfo === 'badRequest',
            category: error?.message?.includes('Unsupported service_tier:') ? 'unsupported_service_tier' : 'other' });
        }
      } }),
    }),
  });
};
const nonce = randomUUID();
const program = `const fs=require('node:fs'),assert=require('node:assert/strict'),crypto=require('node:crypto');
(async()=>{const nonce=${JSON.stringify(nonce)};
if(process.argv[2]==='first'){
let networkBlocked=false;try{await fetch('http://127.0.0.1:3211',{signal:AbortSignal.timeout(1000)})}catch{networkBlocked=true}
fs.writeFileSync('/workspace/live-proof.json',JSON.stringify({nonce,uid:process.getuid(),platform:process.platform,auth:fs.existsSync('/home/agent/.codex/auth.json'),socket:fs.existsSync('/var/run/docker.sock'),host:fs.existsSync(${JSON.stringify(directory)}),networkBlocked}));
console.log('RAT_LIVE_FIRST_'+nonce);
}else if(process.argv[2]==='resume'){
const original=fs.readFileSync('/workspace/live-proof.json');assert.equal(JSON.parse(original).nonce,nonce);
fs.writeFileSync('/workspace/live-resumed.json',JSON.stringify({nonce,originalSha256:crypto.createHash('sha256').update(original).digest('hex')}));
console.log('RAT_LIVE_RESUMED_'+nonce);
}else{throw new Error('Expected first or resume')}})().catch(()=>{process.exitCode=1});`;

let services = launch();
async function completedTurn(sessionId: string, excluding?: string) {
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const turn = (await services.sessions.turns(LOCAL_OWNER, sessionId)).data.find(turn => turn.id !== excluding);
    if (turn?.status === 'completed') return turn;
    if (turn && ['failed', 'cancelled'].includes(turn.status)) throw new Error(`Subscription acceptance Turn ${turn.status}: ${turn.error?.code ?? 'unknown'}`);
    await delay(250);
  }
  throw new Error('Subscription acceptance Turn did not complete within four minutes');
}

async function commandResult(sessionId: string, turnId: string, phase: 'first' | 'resume') {
  const marker = `RAT_LIVE_${phase === 'first' ? 'FIRST' : 'RESUMED'}_${nonce}`;
  const items = await services.sessions.items(LOCAL_OWNER, sessionId, { limit: 100, order: 'desc' });
  const command = items.data.find(item => item.type === 'command_execution' && item.turn_id === turnId
    && item.command.includes(`node /workspace/rat-acceptance.cjs ${phase}`) && item.status === 'completed'
    && item.exit_code === 0 && item.output?.split(/\r?\n/).includes(marker));
  assert(command, `Missing successful ${phase} command output`);
  return command.id;
}

try {
  assert((await services.runtime.status()).ready, 'Selected runtime is not ready');
  const catalog = await services.models();
  const model = values.model ?? catalog?.default_model;
  assert(model && catalog?.data.some(entry => entry.id === model), 'Choose an available subscription model with --model');
  const session = await services.sessions.create(LOCAL_OWNER, {
    agent: { model, multi_agent: { enabled: false } },
    environment: { type: 'openai_hosted', network: { access: 'disabled' },
      setup_commands: [{ command: 'node -e "require(\'node:fs\').appendFileSync(\'/workspace/setup-count\',\'once\')"' }],
      files: [{ type: 'inline', path: '/workspace/rat-acceptance.cjs', data: Buffer.from(program).toString('base64') }] },
    input: 'Run exactly `node /workspace/rat-acceptance.cjs first` using the environment command tool. Do not edit the script or create its output yourself. Report the command output. This is a local runtime acceptance check.',
  });
  await services.sessions.dispatch(LOCAL_OWNER, session.id);
  const first = await completedTurn(session.id);
  const firstCommandId = await commandResult(session.id, first.id, 'first');
  assert(session.environment.type === 'openai_hosted');
  assert((await services.environments.files(LOCAL_OWNER, session.environment.id)).data.some(file => file.path === '/workspace/live-proof.json'), 'First command did not create its proof');
  await services.close();
  services = launch();
  await services.sessions.events(LOCAL_OWNER, session.id, { events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: 'After the restart, run exactly `node /workspace/rat-acceptance.cjs resume` using the environment command tool. Do not edit the script or its output. Report the command output.' }] }] }] });
  await services.sessions.dispatch(LOCAL_OWNER, session.id);
  const resumed = await completedTurn(session.id, first.id);
  const resumedCommandId = await commandResult(session.id, resumed.id, 'resume');
  const snapshot = await services.sessions.snapshotForTransfer(LOCAL_OWNER, session.id, () => services.runtime.snapshot(session.id));
  const file = (path: string) => {
    const entry = snapshot.workspace.find(entry => entry.path === path);
    assert(entry, `Missing ${path}`);
    return Buffer.from(entry.data, 'base64');
  };
  const proof = file('live-proof.json');
  assert.deepEqual(JSON.parse(proof.toString()), { nonce, uid: 10001, platform: 'linux', auth: false, socket: false, host: false, networkBlocked: true });
  assert.deepEqual(JSON.parse(file('live-resumed.json').toString()), { nonce, originalSha256: createHash('sha256').update(proof).digest('hex') });
  assert.equal(file('setup-count').toString(), 'once');
  assert.equal(file('rat-acceptance.cjs').toString(), program);
  const evidence = join(directory, `subscription-acceptance-${nonce}.json`);
  await writeFile(evidence, JSON.stringify({ version: 1, runtime: values.runtime, inference: 'chatgpt-subscription', authentication: 'existing_rat_login',
    sessionId: session.id, model, local: { firstTurnId: first.id, resumedTurnId: resumed.id, firstCommandId, resumedCommandId, restart: 'graceful', proofSha256: createHash('sha256').update(proof).digest('hex') },
    assertions: ['completed command output', 'real command artifacts', 'unchanged verification program', 'UID 10001', 'guest auth file absent', 'host path and engine socket absent', 'command networking blocked', 'workspace persisted', 'setup once', 'snapshot'],
    refresh: 'not_exercised', revokedLoginRecovery: 'not_exercised', cloud: { status: 'not_requested' }, boots: nativeRuntimes.flatMap(runtime => runtime.boots),
  }, null, 2), { mode: 0o600 });
  console.log(`Live subscription acceptance passed. Evidence: ${evidence}`);
} finally {
  await services.close();
  await writeFile(join(directory, `subscription-command-events-${nonce}.json`), JSON.stringify(commandEvents, null, 2), { mode: 0o600 });
}
