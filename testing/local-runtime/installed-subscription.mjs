import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, realpath, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';

const systemPath = '/usr/bin:/bin:/usr/sbin:/sbin';
const marker = 'RAT_INSTALLED_SUBSCRIPTION_PROOF ';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(value);
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const within = (parent, child) => child === parent || child.startsWith(`${parent}${sep}`);

class AcceptanceFailure extends Error {}
function check(condition, message) { if (!condition) throw new AcceptanceFailure(message); }
function decode(bytes) {
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw new AcceptanceFailure('Expected bounded JSON from the packaged local service.'); }
}

export function parseAcceptanceArguments(args, environment = process.env) {
  check(environment.RAT_INSTALLED_SUBSCRIPTION_ACCEPTANCE === '1', 'Set RAT_INSTALLED_SUBSCRIPTION_ACCEPTANCE=1 for real ChatGPT subscription inference.');
  let values;
  try { ({ values } = parseArgs({ args, options: Object.fromEntries(['app', 'directory', 'model'].map(name => [name, { type: 'string' }])) })); }
  catch { throw new AcceptanceFailure('Use --app PATH --directory EXISTING_PRIVATE_PROFILE [--model MODEL_ID].'); }
  check(values.app && values.directory, 'Use --app PATH --directory EXISTING_PRIVATE_PROFILE [--model MODEL_ID].');
  check(values.model === undefined || /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(values.model), 'Choose a valid subscription model ID.');
  return { app: resolve(values.app), directory: resolve(values.directory), ...(values.model ? { model: values.model } : {}) };
}

export function installedEnvironment(directory, home, temporary) {
  return { HOME: home, TMPDIR: `${temporary}/`, LANG: 'C', LC_ALL: 'C', PATH: systemPath, RAT_THINGS_LOCAL_DIR: directory };
}

export function signedAccount(value) {
  check(object(value) && value.harness === 'codex' && value.provider === 'chatgpt'
    && value.signed_in === true && value.account_type === 'chatgpt', 'ChatGPT sign-in is required in this profile. Complete packaged rat-things login first.');
  return { harness: 'codex', provider: 'chatgpt', signed_in: true, account_type: 'chatgpt' };
}

export function nativeRuntime(value, releaseId) {
  const state = value?.installation;
  check(object(value) && object(state) && value.ready === true && value.platform === 'linux/arm64'
    && value.image === `native:${releaseId}` && state.state === 'ready' && state.active === releaseId
    && (state.previous === null || hex(state.previous)) && state.pending === null && state.failure === null
    && Number.isSafeInteger(state.generation) && state.generation > 0, 'The included native runtime must be selected and ready. Run packaged rat-things runtime setup first.');
  return { ready: true, releaseId, generation: state.generation, previous: state.previous };
}

export function nativeIdentity(value, manifest, directory) {
  check(object(value) && value.kind === 'local' && value.directory === directory && value.max_sessions === 1
    && value.model_execution === 'subscription' && value.harness === 'codex' && value.environment === 'managed_local'
    && value.service?.kind === 'native' && object(value.service.protocol), 'The packaged launcher did not start the selected native subscription workspace.');
  const actual = value.service.protocol;
  const expected = manifest?.compatibility;
  check(object(expected) && expected.hostTarget === 'aarch64-apple-darwin' && expected.guestTarget === 'aarch64-unknown-linux-gnu'
    && actual.hostTarget === expected.hostTarget && actual.guestTarget === expected.guestTarget
    && ['workerProtocol', 'accountStateFormat', 'profileSchema'].every(key => Number.isSafeInteger(expected[key]) && actual[key] === expected[key])
    && ['appProtocol', 'controllerProtocol'].every(key => object(expected[key]) && Number.isSafeInteger(actual[key])
      && actual[key] >= expected[key].minimum && actual[key] <= expected[key].maximum)
    && object(expected.workspaceFormat) && Array.isArray(expected.workspaceFormat.read)
    && actual.workspaceFormat === expected.workspaceFormat.write && expected.workspaceFormat.read.includes(actual.workspaceFormat), 'Native service protocol differs from the included release.');
  return { kind: 'native', protocol: Object.fromEntries(['hostTarget', 'guestTarget', 'appProtocol', 'controllerProtocol', 'workerProtocol',
    'workspaceFormat', 'accountStateFormat', 'profileSchema'].map(key => [key, actual[key]])) };
}

export function verificationProgram(nonce, directory) {
  return `const fs=require('node:fs'),assert=require('node:assert/strict'),crypto=require('node:crypto');
(async()=>{const nonce=${JSON.stringify(nonce)},phase=process.argv[2],sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
assert(['first','resume'].includes(phase));
let networkBlocked=false;try{await fetch('http://127.0.0.1:3211',{signal:AbortSignal.timeout(1000)})}catch{networkBlocked=true}
const observations={nonce,uid:process.getuid(),platform:process.platform,auth:fs.existsSync('/home/agent/.codex/auth.json'),socket:fs.existsSync('/var/run/docker.sock'),host:fs.existsSync(${JSON.stringify(directory)}),networkBlocked};
assert.deepEqual(observations,{nonce,uid:10001,platform:'linux',auth:false,socket:false,host:false,networkBlocked:true});
const setupCount=fs.readFileSync('/workspace/setup-count','utf8');assert.equal(setupCount,'once');
if(phase==='first')fs.writeFileSync('/workspace/live-proof.json',JSON.stringify(observations),{flag:'wx'});
const original=fs.readFileSync('/workspace/live-proof.json');assert.deepEqual(JSON.parse(original),observations);
if(phase==='resume')fs.writeFileSync('/workspace/live-resumed.json',JSON.stringify({nonce,originalSha256:sha(original)}),{flag:'wx'});
const paths=['rat-acceptance.cjs','live-proof.json','setup-count',...(phase==='resume'?['live-resumed.json']:[])];
const files=paths.map(path=>{const bytes=fs.readFileSync('/workspace/'+path);return{path,bytes:bytes.length,sha256:sha(bytes)}});
console.log(${JSON.stringify(marker)}+JSON.stringify({schemaVersion:1,nonce,phase,observations,setupCount,files}));
})().catch(()=>{console.error('Installed subscription command verification failed.');process.exitCode=1});`;
}

export function expectedProof(nonce, program, phase) {
  const observations = { nonce, uid: 10001, platform: 'linux', auth: false, socket: false, host: false, networkBlocked: true };
  const proof = JSON.stringify(observations);
  const contents = [['rat-acceptance.cjs', program], ['live-proof.json', proof], ['setup-count', 'once'],
    ...(phase === 'resume' ? [['live-resumed.json', JSON.stringify({ nonce, originalSha256: digest(proof) })]] : [])];
  return { schemaVersion: 1, nonce, phase, observations, setupCount: 'once',
    files: contents.map(([path, bytes]) => ({ path, bytes: Buffer.byteLength(bytes), sha256: digest(bytes) })) };
}

function page(value, description) {
  check(object(value) && Array.isArray(value.data) && value.data.length <= 100 && value.data.every(object), `Invalid ${description} response.`);
  return value.data;
}

export function commandProof(items, turnId, nonce, program, phase) {
  const command = `node /workspace/rat-acceptance.cjs ${phase}`;
  const forms = new Set([command, ...['sh', 'bash', '/bin/sh', '/bin/bash', '/usr/bin/sh', '/usr/bin/bash'].flatMap(shell =>
    ['-c', '-lc'].flatMap(flag => ["'", '"'].map(quote => `${shell} ${flag} ${quote}${command}${quote}`)))]);
  const candidates = page(items, 'Session items').filter(item => item.type === 'command_execution' && item.turn_id === turnId
    && typeof item.command === 'string' && forms.has(item.command.trim()) && item.status === 'completed' && item.exit_code === 0);
  check(candidates.length === 1 && identifier(candidates[0].id), `Missing one successful ${phase} environment command.`);
  const item = candidates[0];
  check(typeof item.output === 'string' && Buffer.byteLength(item.output) <= 16 * 1024, `Missing bounded ${phase} command output.`);
  const lines = item.output.split(/\r?\n/).filter(line => line.startsWith(marker));
  check(lines.length === 1, `Missing one structured ${phase} command proof.`);
  const proof = decode(Buffer.from(lines[0].slice(marker.length)));
  check(isDeepStrictEqual(proof, expectedProof(nonce, program, phase)), `The ${phase} command proof differs from the expected nonce, isolation, setup count, or file hashes.`);
  return { commandId: item.id, turnId, source: 'command_execution.output', proof };
}

export function listedFiles(value, environmentId, expected) {
  const files = page(value, 'environment files');
  const listed = expected.map(file => {
    const matches = files.filter(entry => entry.path === `/workspace/${file.path}`);
    check(matches.length === 1 && matches[0].object === 'agent.environment.file' && matches[0].environment_id === environmentId
      && matches[0].size_bytes === file.bytes, 'Environment file listing differs from command-observed file sizes.');
    return { path: matches[0].path, bytes: matches[0].size_bytes };
  });
  return { source: 'environment.files', files: listed };
}

export async function subscriptionScenario({ nonce, directory, model }, { request, restart, record, signal, now = Date.now, sleep = delay }) {
  const program = verificationProgram(nonce, directory);
  const session = await request('POST', '/agents/sessions', {
    agent: { model, multi_agent: { enabled: false } },
    environment: { type: 'openai_hosted', network: { access: 'disabled' },
      setup_commands: [{ command: 'node -e "require(\'node:fs\').appendFileSync(\'/workspace/setup-count\',\'once\')"' }],
      files: [{ type: 'inline', path: '/workspace/rat-acceptance.cjs', data: Buffer.from(program).toString('base64') }] },
    input: 'Run exactly `node /workspace/rat-acceptance.cjs first` using the environment command tool. Do not edit the script or create its output yourself. Report the command output. This is a local runtime acceptance check.',
  });
  check(object(session) && identifier(session.id) && session.id.startsWith('sess_') && session.agent?.model === model
    && session.environment?.type === 'openai_hosted' && identifier(session.environment.id) && session.environment.id.startsWith('env_'), 'The API did not create the requested managed Session.');
  const sessionId = session.id; const environmentId = session.environment.id;
  await record('session', { sessionId, environmentId, model, programSha256: digest(program) });
  async function completedTurn(excluding) {
    const deadline = now() + 240_000;
    while (now() < deadline) {
      signal.throwIfAborted();
      const turns = page(await request('GET', `/agents/sessions/${sessionId}/turns?limit=100&order=desc`), 'Session turns');
      const turn = turns.find(entry => entry.id !== excluding);
      if (turn?.status === 'completed') { check(identifier(turn.id), 'Invalid completed Turn identity.'); return turn.id; }
      check(!turn || !['failed', 'cancelled'].includes(turn.status), 'The real subscription Turn failed or was cancelled.');
      await sleep(250, undefined, { signal });
    }
    throw new AcceptanceFailure('The real subscription Turn did not complete within four minutes.');
  }
  async function proof(phase, turnId) {
    const command = commandProof(await request('GET', `/agents/sessions/${sessionId}/items?limit=100&order=desc`), turnId, nonce, program, phase);
    await record(`${phase}Command`, command);
    const listing = listedFiles(await request('GET', `/agents/environments/${environmentId}/files?path=%2Fworkspace&limit=100&order=asc`), environmentId, command.proof.files);
    await record(`${phase}Files`, listing);
    return command;
  }
  const firstTurnId = await completedTurn();
  const first = await proof('first', firstTurnId);
  await restart();
  const restored = await request('GET', `/agents/sessions/${sessionId}`);
  check(restored?.id === sessionId && restored.agent?.model === model && restored.environment?.id === environmentId
    && restored.environment.type === 'openai_hosted', 'The same Session and environment did not survive the packaged service restart.');
  await request('POST', `/agents/sessions/${sessionId}/events`, { events: [{ type: 'agent.session.input.message',
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'After the restart, run exactly `node /workspace/rat-acceptance.cjs resume` using the environment command tool. Do not edit the script or its output. Report the command output.' }] }] }] });
  const resumedTurnId = await completedTurn(firstTurnId);
  const resumed = await proof('resume', resumedTurnId);
  return { sessionId, environmentId, model,
    local: { firstTurnId, resumedTurnId, firstCommandId: first.commandId, resumedCommandId: resumed.commandId,
      restart: 'graceful', proofSha256: first.proof.files.find(file => file.path === 'live-proof.json').sha256,
      programSha256: digest(program), fileContentSource: 'command_execution.output', snapshot: 'not_exercised' } };
}

async function checkedFile(path, maximum, privateFile = false) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat({ bigint: true });
    check(before.isFile() && before.nlink === 1n && before.size <= BigInt(maximum)
      && (!privateFile || Number(before.uid) === process.getuid() && (before.mode & 0o077n) === 0n), 'Unexpected linked, special, oversized, or non-private acceptance input.');
    const chunks = []; let size = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      size += chunk.length; check(size <= maximum, 'Acceptance input exceeded its byte limit.'); chunks.push(chunk);
    }
    const after = await file.stat({ bigint: true });
    check(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode'].every(key => before[key] === after[key]) && BigInt(size) === before.size, 'Acceptance input changed while reading.');
    return Buffer.concat(chunks);
  } finally { await file.close(); }
}

async function absent(path) {
  try { await lstat(path); return false; }
  catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}

export function connectionRecord(value) {
  check(object(value) && hex(value.token) && typeof value.baseURL === 'string', 'Invalid private connection record.');
  let url;
  try { url = new URL(value.baseURL); } catch { throw new AcceptanceFailure('Invalid private connection endpoint.'); }
  check(url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port && url.pathname === '/v1'
    && !url.username && !url.password && !url.search && !url.hash, 'Connection must use authenticated loopback.');
  return { baseURL: url.href, token: value.token };
}

export async function localRequest(connection, method, path, body, signal) {
  connection = connectionRecord(connection);
  const status = ['/workspace', '/workspace/runtime', '/workspace/subscription', '/models'];
  const session = '/agents/sessions/sess_[A-Za-z0-9_-]{1,195}';
  const allowed = method === 'GET' && (status.includes(path) || new RegExp(`^${session}$`).test(path)
    || new RegExp(`^${session}/(?:items|turns)\\?limit=100&order=desc$`).test(path)
    || /^\/agents\/environments\/env_[A-Za-z0-9_-]{1,196}\/files\?path=%2Fworkspace&limit=100&order=asc$/.test(path))
    || method === 'POST' && (path === '/agents/sessions' || new RegExp(`^${session}/events$`).test(path));
  check(allowed, 'Unexpected installed subscription request.');
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  check(!payload || payload.length <= 64 * 1024, 'Acceptance request exceeded its byte limit.');
  return new Promise((resolveResponse, reject) => {
    const failure = () => reject(new AcceptanceFailure('Authenticated local acceptance request failed.'));
    const outgoing = httpRequest(`${connection.baseURL}${path}`, { method, agent: false, maxHeaderSize: 16 * 1024,
      headers: { authorization: `Bearer ${connection.token}`, ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}) },
      signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]) }, response => {
      const expected = path.endsWith('/events') ? 204 : 200;
      if (response.statusCode !== expected) { response.destroy(); failure(); return; }
      const chunks = []; let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 2 * 1024 ** 2) { response.destroy(); reject(new AcceptanceFailure('Local acceptance response exceeded its byte limit.')); }
        else chunks.push(chunk);
      });
      response.once('error', failure);
      response.once('end', () => {
        try { resolveResponse(expected === 204 ? undefined : decode(Buffer.concat(chunks))); } catch (error) { reject(error); }
      });
    });
    outgoing.once('error', failure); outgoing.end(payload);
  });
}

async function withinTime(promise, milliseconds) {
  let timer;
  try { return await Promise.race([promise, new Promise(resolveTimeout => { timer = setTimeout(() => resolveTimeout(null), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

function processes(launcher, cwd, environment, signal) {
  const active = new Set();
  const interrupt = () => { for (const state of active) state.child.kill('SIGTERM'); };
  signal.addEventListener('abort', interrupt);
  function start(args) {
    signal.throwIfAborted();
    const child = spawn(launcher, args, { cwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const state = { child, output: '', bytes: 0, failed: false, result: null, done: undefined };
    active.add(state);
    for (const channel of ['stdout', 'stderr']) child[channel].on('data', chunk => {
      state.bytes += chunk.length;
      if (state.bytes > 1024 * 1024) { state.failed = true; child.kill('SIGTERM'); }
      else if (channel === 'stdout') state.output += chunk.toString('utf8');
    });
    state.done = new Promise(resolveDone => {
      child.once('error', () => { state.failed = true; });
      child.once('close', (code, stoppedBy) => { state.result = { code, stoppedBy }; active.delete(state); resolveDone(state.result); });
    });
    return state;
  }
  async function stop(state, requireSuccess = true) {
    if (!state.result) state.child.kill('SIGTERM');
    const result = await withinTime(state.done, 60_000);
    if (!result) {
      try { process.kill(-state.child.pid, 'SIGKILL'); } catch {}
      await withinTime(state.done, 5000);
      throw new AcceptanceFailure('Packaged CLI did not finish graceful shutdown; profile retained.');
    }
    check(!state.failed && (!requireSuccess || result.code === 0), 'Packaged CLI did not exit successfully.');
  }
  return { start, stop, command: async args => {
    const state = start(args); const result = await withinTime(state.done, 180_000);
    if (!result) { await stop(state, false); throw new AcceptanceFailure('Packaged CLI command exceeded its deadline.'); }
    check(!state.failed && result.code === 0, 'Packaged CLI command failed.');
    return decode(Buffer.from(state.output));
  }, close: async () => {
    const results = await Promise.allSettled([...active].map(state => stop(state, false)));
    signal.removeEventListener('abort', interrupt);
    check(results.every(result => result.status === 'fulfilled'), 'Packaged CLI cleanup was not confirmed; profile retained.');
  } };
}

export async function runInstalledSubscription(options) {
  check(process.env.RAT_INSTALLED_SUBSCRIPTION_ACCEPTANCE === '1', 'Set RAT_INSTALLED_SUBSCRIPTION_ACCEPTANCE=1 for real ChatGPT subscription inference.');
  check(process.platform === 'darwin' && process.arch === 'arm64', 'Installed subscription acceptance requires an Apple silicon Mac.');
  const app = await realpath(options.app); const directory = await realpath(options.directory);
  const info = await lstat(directory);
  check(app.endsWith('.app') && (await lstat(app)).isDirectory(), 'Choose the packaged Rat Things app.');
  check(info.isDirectory() && info.uid === process.getuid() && (info.mode & 0o077) === 0
    && !within(app, directory) && !within(directory, app), 'Choose an existing private profile outside the app, owned by your user.');
  const launcher = join(app, 'Contents/MacOS/rat-things');
  check(await realpath(launcher) === launcher && (await lstat(launcher)).isFile(), 'The packaged command-line launcher is missing or linked.');
  const manifestPath = join(app, 'Contents/Resources/Runtime.bundle/Contents/Resources/runtime-manifest.json');
  check(await realpath(manifestPath) === manifestPath, 'The included runtime manifest is linked.');
  const manifestBytes = await checkedFile(manifestPath, 128 * 1024);
  const manifest = decode(manifestBytes); const releaseId = digest(manifestBytes);
  const connectionPath = join(directory, 'connection.json');
  check(await absent(connectionPath), 'The profile already has a connection record. Stop its service before running acceptance.');
  const work = await mkdtemp(join(directory, 'installed-subscription-acceptance-'));
  for (const name of ['home', 'tmp', 'cwd']) await mkdir(join(work, name), { mode: 0o700 });
  const evidencePath = join(work, 'evidence.json'); const nonce = randomUUID();
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  const children = processes(launcher, join(work, 'cwd'), installedEnvironment(directory, join(work, 'home'), join(work, 'tmp')), controller.signal);
  const evidence = { version: 2, status: 'running', startedAt: new Date().toISOString(), app, directory, releaseId, nonce,
    runtime: 'installed-native', inference: 'chatgpt-subscription', authentication: 'existing_rat_login',
    environment: { path: systemPath, home: 'private_profile', workingDirectory: 'private_profile', inheritedEnvironment: false }, observations: {},
    snapshot: 'not_exercised', refresh: 'not_exercised', revokedLoginRecovery: 'not_exercised', cloud: { status: 'not_requested' },
    limits: ['file contents, hashes, isolation and setup count are command-observed, not independently read in a host snapshot',
      'network assertion checks one refused guest-loopback request under the disabled-network policy',
      'no clean-physical-machine or notarization assessment', 'no explicit account refresh, revoked-login recovery, abrupt failure or cloud transfer'] };
  let service; let connection; let selection; let failure;
  const save = () => writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  const record = async (name, value) => {
    evidence.observations[name] = value;
    if (name === 'session') Object.assign(evidence, value);
    await save();
  };
  const request = (method, path, body) => localRequest(connection, method, path, body, controller.signal);
  async function stop(phase) {
    check(service && !service.result, 'Packaged service exited before its requested graceful stop.');
    await children.stop(service); service = undefined;
    check(await absent(connectionPath), 'The packaged service did not remove its own connection record.');
    await record(`${phase}Shutdown`, { graceful: true, connectionRemoved: true });
  }
  async function start(phase) {
    check(await absent(connectionPath), 'A service connection already exists for this profile.');
    const previous = connection; connection = undefined;
    service = children.start(['serve', '--port', '0', '--max-sessions', '1']);
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      controller.signal.throwIfAborted();
      check(!service.result && !service.failed, 'Packaged service exited before readiness.');
      if (!connection && !await absent(connectionPath)) connection = connectionRecord(decode(await checkedFile(connectionPath, 4096, true)));
      if (connection) {
        check(!previous || connection.token !== previous.token, 'Restart did not create a new packaged service connection.');
        const status = await request('GET', '/workspace/runtime');
        if (status.ready) break;
        check(status.installation?.state === 'checking', 'The native runtime must be set up before live subscription acceptance.');
      }
      await delay(100, undefined, { signal: controller.signal });
    }
    check(connection && Date.now() < deadline, 'Packaged service readiness exceeded its deadline.');
    await record(`${phase}Identity`, nativeIdentity(await request('GET', '/workspace'), manifest, directory));
    const ready = nativeRuntime(await children.command(['runtime', 'status', '--json']), releaseId);
    check(!selection || isDeepStrictEqual(selection, ready), 'Restart changed the selected native release.');
    selection = ready;
    await record(`${phase}Runtime`, ready);
    await record(`${phase}Account`, signedAccount(await request('GET', '/workspace/subscription')));
  }
  try {
    await save();
    await start('first');
    const catalog = await request('GET', '/models');
    const model = options.model ?? catalog?.default_model;
    check(typeof model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(model)
      && Array.isArray(catalog?.data) && catalog.data.some(entry => entry?.id === model), 'Choose an available subscription model with --model.');
    const result = await subscriptionScenario({ nonce, directory, model }, { request, record, signal: controller.signal,
      restart: async () => { await stop('first'); await start('resumed'); } });
    Object.assign(evidence, result);
    await stop('resumed');
    evidence.status = 'passed';
  } catch (error) {
    failure = error instanceof AcceptanceFailure ? error.message : controller.signal.aborted ? 'Acceptance interrupted.' : 'Installed subscription acceptance failed.';
    evidence.status = 'failed'; evidence.failure = failure;
  } finally {
    try { await children.close(); check(await absent(connectionPath), 'Packaged CLI cleanup left a connection record.'); }
    catch { failure = 'Packaged CLI cleanup was not confirmed; profile retained.'; evidence.status = 'failed'; evidence.cleanup = 'unconfirmed'; evidence.failure = failure; }
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
    evidence.finishedAt = new Date().toISOString(); await save();
  }
  if (failure) throw new AcceptanceFailure(`${failure} Evidence: ${evidencePath}`);
  return { evidencePath, sessionId: evidence.sessionId };
}

if (process.argv[1] && await realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runInstalledSubscription(parseAcceptanceArguments(process.argv.slice(2)));
    console.log(`Installed subscription acceptance passed. Session: ${result.sessionId}. Evidence: ${result.evidencePath}`);
  } catch (error) {
    console.error(error instanceof AcceptanceFailure ? error.message : 'Installed subscription acceptance could not start.');
    process.exitCode = 1;
  }
}
