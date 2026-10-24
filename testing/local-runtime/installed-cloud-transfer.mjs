import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, realpath, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { connectionRecord, expectedProof, localRequest, nativeIdentity, nativeRuntime, verificationProgram } from './installed-subscription.mjs';

const systemPath = '/usr/bin:/bin:/usr/sbin:/sbin';
const marker = 'RAT_INSTALLED_CLOUD_PROOF ';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(value);
const sessionId = value => identifier(value) && value.startsWith('sess_');
const modelId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value);
const within = (parent, child) => child === parent || child.startsWith(`${parent}${sep}`);
const awsEnvironment = ['HOME', 'USER', 'LOGNAME', 'AWS_PROFILE', 'AWS_DEFAULT_PROFILE', 'AWS_CONFIG_FILE',
  'AWS_SHARED_CREDENTIALS_FILE', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
  'AWS_SDK_LOAD_CONFIG', 'AWS_CA_BUNDLE', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'];

class AcceptanceFailure extends Error {}
function check(condition, message) { if (!condition) throw new AcceptanceFailure(message); }
function decode(text) {
  try { return JSON.parse(text); }
  catch { throw new AcceptanceFailure('Expected bounded JSON from the packaged CLI or acceptance evidence.'); }
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function parseAcceptanceArguments(args, environment = process.env) {
  check(environment.RAT_INSTALLED_CLOUD_ACCEPTANCE === '1', 'Set RAT_INSTALLED_CLOUD_ACCEPTANCE=1 for real AWS transfer and inference.');
  let values;
  try { ({ values } = parseArgs({ args, options: Object.fromEntries(['app', 'directory', 'evidence', 'endpoint', 'region', 'model'].map(name => [name, { type: 'string' }])) })); }
  catch { throw new AcceptanceFailure('Use --app PATH --directory PROFILE --evidence SUBSCRIPTION_JSON --endpoint HTTPS_URL --region REGION --model MODEL_ID.'); }
  check(['app', 'directory', 'evidence', 'endpoint', 'region', 'model'].every(name => values[name]), 'Explicit app, profile, subscription evidence, AWS endpoint, region, and model are required.');
  let endpoint;
  try { endpoint = new URL(values.endpoint); } catch { throw new AcceptanceFailure('Choose an HTTPS Agents API endpoint.'); }
  check(endpoint.protocol === 'https:' && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash
    && ['/', '/v1', '/v1/'].includes(endpoint.pathname), 'Choose an HTTPS Agents API endpoint without credentials, query, or fragment.');
  check(/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(values.region) && modelId(values.model), 'Choose an explicit AWS region and destination model ID.');
  return { app: resolve(values.app), directory: resolve(values.directory), evidence: resolve(values.evidence),
    endpoint: `${endpoint.origin}/v1`, region: values.region, model: values.model };
}

export function installedEnvironment(directory, temporary, region, inherited = process.env) {
  return { ...Object.fromEntries(awsEnvironment.filter(key => typeof inherited[key] === 'string').map(key => [key, inherited[key]])),
    PATH: systemPath, LANG: 'C', LC_ALL: 'C', TMPDIR: `${temporary}/`, RAT_THINGS_LOCAL_DIR: directory,
    AWS_REGION: region, AWS_DEFAULT_REGION: region };
}

export function subscriptionEvidence(value, { app, directory, releaseId }) {
  check(object(value) && value.version === 2 && value.status === 'passed' && value.runtime === 'installed-native'
    && value.app === app && value.directory === directory && value.releaseId === releaseId && uuid(value.nonce)
    && sessionId(value.sessionId) && identifier(value.environmentId) && value.environmentId.startsWith('env_') && modelId(value.model),
  'Subscription evidence must be a passed installed run for this app, profile, and included release.');
  const program = verificationProgram(value.nonce, directory);
  for (const [phase, name, turn, command] of [['first', 'firstCommand', 'firstTurnId', 'firstCommandId'], ['resume', 'resumeCommand', 'resumedTurnId', 'resumedCommandId']]) {
    const observation = value.observations?.[name];
    check(object(observation) && observation.source === 'command_execution.output' && identifier(value.local?.[turn])
      && identifier(value.local?.[command]) && observation.turnId === value.local[turn] && observation.commandId === value.local[command]
      && isDeepStrictEqual(observation.proof, expectedProof(value.nonce, program, phase)), 'Subscription command evidence differs from its exact expected proof.');
  }
  const files = expectedProof(value.nonce, program, 'resume').files;
  check(value.local.restart === 'graceful' && value.local.fileContentSource === 'command_execution.output'
    && value.local.proofSha256 === files.find(file => file.path === 'live-proof.json').sha256
    && value.local.programSha256 === sha256(program) && value.local.firstTurnId !== value.local.resumedTurnId,
  'Subscription evidence is missing its restart, source file hashes, or distinct Turns.');
  return { sessionId: value.sessionId, environmentId: value.environmentId, model: value.model, nonce: value.nonce, files,
    commands: ['firstCommand', 'resumeCommand'].map(name => value.observations[name]) };
}

export function shellArguments(command) {
  check(typeof command === 'string' && Buffer.byteLength(command) <= 32 * 1024, 'Cloud command is missing or oversized.');
  const words = []; let word = ''; let quote = null; let started = false;
  for (let index = 0; index < command.length; index++) {
    const character = command[index];
    if (quote === "'") { if (character === "'") quote = null; else word += character; continue; }
    if (quote === '"' && character === '"') { quote = null; continue; }
    check(quote || !['\n', '\r'].includes(character), 'Cloud command contains an additional shell line.');
    if (!quote && /\s/.test(character)) { if (started) { words.push(word); word = ''; started = false; } continue; }
    started = true;
    if (!quote && ["'", '"'].includes(character)) { quote = character; continue; }
    if (character === '\\') {
      check(index + 1 < command.length, 'Incomplete command escaping.');
      const next = command[++index];
      if (quote === '"' && !['$', '`', '"', '\\', '\n'].includes(next)) word += '\\';
      if (next !== '\n') word += next;
      continue;
    }
    check(!['$', '`'].includes(character) && (quote || !';|&<>()*?[]~#'.includes(character)), 'Cloud command contains shell expansion or extra operations.');
    word += character;
  }
  check(!quote, 'Unclosed cloud command quoting.');
  if (started) words.push(word);
  return words;
}

export function commandArguments(command) {
  const words = shellArguments(command);
  return words.length === 3 && ['/bin/sh', '/usr/bin/sh', 'sh', '/bin/bash', '/usr/bin/bash', 'bash', '/bin/zsh', 'zsh'].includes(words[0]) && ['-c', '-lc'].includes(words[1])
    ? shellArguments(words[2]) : words;
}

export function cloudCommand(nonce, source) {
  check(uuid(nonce) && sessionId(source.sessionId), 'Invalid cloud proof identity.');
  const proof = { schemaVersion: 1, nonce, sourceSessionId: source.sessionId, files: source.files, setupCount: 'once' };
  const file = { path: `installed-cloud-proof-${nonce}.json`, bytes: Buffer.byteLength(JSON.stringify(proof)), sha256: sha256(JSON.stringify(proof)) };
  const output = `${marker}${JSON.stringify({ ...proof, createdFile: file })}\n`;
  const program = `const fs=require('node:fs'),assert=require('node:assert/strict'),crypto=require('node:crypto');const expected=${JSON.stringify(source.files)};const files=expected.map(file=>{const bytes=fs.readFileSync('/workspace/'+file.path);return{path:file.path,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')}});assert.deepEqual(files,expected);assert.equal(fs.readFileSync('/workspace/setup-count','utf8'),'once');const proof={schemaVersion:1,nonce:${JSON.stringify(nonce)},sourceSessionId:${JSON.stringify(source.sessionId)},files,setupCount:'once'};const bytes=Buffer.from(JSON.stringify(proof));fs.writeFileSync('/workspace/'+${JSON.stringify(file.path)},bytes,{flag:'wx'});console.log(${JSON.stringify(marker)}+JSON.stringify({...proof,createdFile:{path:${JSON.stringify(file.path)},bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')}}));`;
  return { argv: ['node', '-e', program], command: `node -e '${program.replaceAll("'", "'\"'\"'")}'`, output, file };
}

export function commandProof(items, turnId, expected) {
  const candidates = items.filter(item => item.type === 'command_execution' && item.turn_id === turnId
    && item.status === 'completed' && item.exit_code === 0 && item.output === expected.output);
  check(candidates.length === 1 && identifier(candidates[0].id), 'Cloud Turn did not contain one successful command with exact expected stdout.');
  check(isDeepStrictEqual(commandArguments(candidates[0].command), expected.argv), 'Cloud command argv differs from the requested proof program.');
  return { commandId: candidates[0].id, turnId, source: 'command_execution.output', argv: expected.argv,
    stdout: expected.output, stdoutSha256: sha256(expected.output), createdFile: expected.file };
}

export function historyContent(items) {
  return items.map(item => Object.fromEntries(Object.entries(item).filter(([key]) => !['id', 'turn_id', 'session_id', 'created_at', 'updated_at'].includes(key))));
}

function settings(session) {
  check(object(session.agent) && object(session.metadata), 'Session settings are unavailable.');
  return { agent: Object.fromEntries(Object.entries(session.agent).filter(([key]) => !['id', 'name', 'model'].includes(key))), metadata: session.metadata };
}

function idleSession(value, expectedId, expectedModel, environmentId) {
  check(object(value) && value.id === expectedId && value.object === 'agent.session' && value.status === 'idle'
    && Array.isArray(value.required_actions) && value.required_actions.length === 0
    && Array.isArray(value.vault_ids) && value.vault_ids.length === 0 && value.agent?.model === expectedModel
    && value.environment?.type === 'openai_hosted' && identifier(value.environment.id)
    && (!environmentId || value.environment.id === environmentId), 'Expected an idle managed Session with the selected model, environment, and no required actions or vaults.');
  return value;
}

function sourceCommands(items, source) {
  for (const [index, observation] of source.commands.entries()) {
    const matches = items.filter(item => item.id === observation.commandId && item.turn_id === observation.turnId
      && item.type === 'command_execution' && item.status === 'completed' && item.exit_code === 0);
    const phase = index === 0 ? 'first' : 'resume';
    check(matches.length === 1 && isDeepStrictEqual(commandArguments(matches[0].command), ['node', '/workspace/rat-acceptance.cjs', phase]), 'Source history no longer contains the accepted local command.');
    check(typeof matches[0].output === 'string' && matches[0].output.split(/\r?\n/).filter(line => line.startsWith('RAT_INSTALLED_SUBSCRIPTION_PROOF ')).length === 1
      && matches[0].output.split(/\r?\n/).includes(`RAT_INSTALLED_SUBSCRIPTION_PROOF ${JSON.stringify(observation.proof)}`), 'Source command proof differs from subscription evidence.');
  }
}

export function transferPlan(value, source, destination, expectedId) {
  check(object(value) && uuid(value.id) && (!expectedId || value.id === expectedId)
    && value.source_session_id === source.sessionId && value.source_model === source.model && value.model === destination.model
    && value.destination?.baseURL === destination.endpoint && value.destination?.region === destination.region
    && ['preparing', 'ready', 'uploading', 'importing', 'complete', 'failed'].includes(value.status)
    && ['files', 'bytes', 'history_items', 'uploaded_parts', 'total_parts'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0)
    && value.uploaded_parts <= value.total_parts && (value.destination_session_id === null || sessionId(value.destination_session_id)),
  'Transfer receipt does not match the selected source, destination, model, or progress contract.');
  return { id: value.id, status: value.status, files: value.files, bytes: value.bytes, historyItems: value.history_items,
    uploadedParts: value.uploaded_parts, totalParts: value.total_parts, destinationSessionId: value.destination_session_id };
}

export function cliDocuments(output, transfer = false) {
  check(typeof output === 'string' && Buffer.byteLength(output) <= 8 * 1024 ** 2, 'Packaged CLI output exceeded its limit.');
  const values = []; let rest = output.trimStart();
  while (rest.startsWith('{')) {
    let depth = 0; let quoted = false; let escaped = false; let end = -1;
    for (let index = 0; index < rest.length; index++) {
      const character = rest[index];
      if (quoted) { if (escaped) escaped = false; else if (character === '\\') escaped = true; else if (character === '"') quoted = false; }
      else if (character === '"') quoted = true;
      else if ('{['.includes(character)) { depth++; check(depth <= 100, 'Packaged CLI JSON nesting exceeded its limit.'); }
      else if ('}]'.includes(character) && --depth === 0) { end = index + 1; break; }
    }
    check(end > 0, 'Incomplete packaged CLI JSON.');
    values.push(decode(rest.slice(0, end))); rest = rest.slice(end).trimStart();
    check(values.length <= (transfer ? 2 : 1), 'Unexpected additional packaged CLI JSON.');
  }
  check(rest.trim() === '' || transfer && values.at(-1)?.status === 'ready'
    && rest.trim() === `Review the destination and snapshot above. Copy with: rat-things transfer run ${values.at(-1).id}`, 'Unexpected text in packaged CLI output.');
  return values;
}

export async function allItems(cli, scope, group, id) {
  const items = []; const seen = new Set(); let after;
  for (let page = 0; page < 100; page++) {
    const value = await cli(scope, ['sessions', group, id, '--limit', '100', '--order', 'asc', ...(after ? ['--after', after] : [])]);
    check(object(value) && value.object === 'list' && Array.isArray(value.data) && value.data.length <= 100
      && value.data.every(object) && typeof value.has_more === 'boolean', 'Invalid paginated Session response.');
    items.push(...value.data);
    check(Buffer.byteLength(JSON.stringify(items)) <= 2 * 1024 ** 2, 'Session history exceeded the transfer limit.');
    if (!value.has_more) return items;
    after = value.data.at(-1)?.id;
    check(identifier(after) && !seen.has(after), 'Session pagination did not advance.'); seen.add(after);
  }
  throw new AcceptanceFailure('Session pagination exceeded its limit.');
}

export async function transferScenario({ source, endpoint, region, model, nonce }, { cli, restart, record, signal, now = Date.now, sleep = delay }) {
  const destination = { endpoint, region, model };
  const before = idleSession(await cli('local', ['sessions', 'get', source.sessionId]), source.sessionId, source.model, source.environmentId);
  const history = await allItems(cli, 'local', 'items', source.sessionId);
  sourceCommands(history, source);
  const historyDigest = sha256(canonical(historyContent(history))); const settingsDigest = sha256(canonical(settings(before)));
  await record('source', { sessionId: source.sessionId, environmentId: source.environmentId, model: source.model,
    historyItems: history.length, historyContentSha256: historyDigest, settingsSha256: settingsDigest, files: source.files });
  const planned = await cli('local', ['transfer', 'plan', source.sessionId, '--api-url', endpoint, '--region', region, '--model', model]);
  const plan = transferPlan(planned, source, destination);
  await record('plan', plan);
  check(plan.status === 'ready' && plan.historyItems === history.length && plan.files >= source.files.length
    && plan.bytes >= source.files.reduce((sum, file) => sum + file.bytes, 0) && plan.totalParts > 0, 'Transfer did not prepare the expected source snapshot.');
  const copied = transferPlan(await cli('local', ['transfer', 'run', plan.id]), source, destination, plan.id);
  await record('copy', copied);
  check(copied.status === 'complete' && sessionId(copied.destinationSessionId) && copied.uploadedParts === copied.totalParts, 'Transfer did not finish copying the source snapshot.');
  check(['files', 'bytes', 'historyItems', 'totalParts'].every(key => copied[key] === plan[key]), 'Copy changed the reviewed transfer snapshot.');
  await restart();
  const retrieved = transferPlan(await cli('local', ['transfer', 'status', plan.id]), source, destination, plan.id);
  const repeated = transferPlan(await cli('local', ['transfer', 'run', plan.id]), source, destination, plan.id);
  check(isDeepStrictEqual(retrieved, copied) && isDeepStrictEqual(repeated, copied), 'Restart and same-ID retry changed the completed transfer receipt.');
  await record('retry', { transferId: plan.id, destinationSessionId: copied.destinationSessionId, serviceRestart: 'graceful', completedReceiptReused: true });
  const cloudId = copied.destinationSessionId;
  const imported = idleSession(await cli('cloud', ['sessions', 'get', cloudId]), cloudId, model);
  const importedHistory = await allItems(cli, 'cloud', 'items', cloudId);
  check(sha256(canonical(historyContent(importedHistory))) === historyDigest && sha256(canonical(settings(imported))) === settingsDigest,
    'Cloud import changed source history content or stable Session settings.');
  check((await allItems(cli, 'cloud', 'turns', cloudId)).length === 0, 'Cloud import executed a Turn before an ordinary message.');
  await record('import', { sessionId: cloudId, environmentId: imported.environment.id, model, idle: true, turns: 0,
    historyItems: importedHistory.length, historyContentSha256: historyDigest, settingsSha256: settingsDigest });
  const command = cloudCommand(nonce, source);
  await record('commandRequest', { sessionId: cloudId, idempotencyKey: nonce, argv: command.argv, expectedStdoutSha256: sha256(command.output) });
  await cli('cloud', ['sessions', 'send', cloudId, '--idempotency-key', nonce, '--input',
    `Run exactly this command once using the environment command tool. Do not edit files or produce the proof yourself. Report its output.\n${command.command}`]);
  const deadline = now() + 600_000; let turnId;
  while (now() < deadline) {
    signal.throwIfAborted();
    const turns = await allItems(cli, 'cloud', 'turns', cloudId);
    check(turns.length <= 1, 'Cloud proof unexpectedly created multiple Turns.');
    const turn = turns[0];
    if (turn && ['completed', 'failed', 'cancelled'].includes(turn.status)) {
      check(identifier(turn.id), 'Cloud Turn identity is invalid.');
      await record('cloudTurn', { id: turn.id, status: turn.status });
    }
    check(!turn || !['failed', 'cancelled'].includes(turn.status), 'Cloud proof Turn failed or was cancelled.');
    if (turn?.status === 'completed') { check(identifier(turn.id), 'Cloud Turn identity is invalid.'); turnId = turn.id; break; }
    await sleep(2000, undefined, { signal });
  }
  check(turnId, 'Cloud proof Turn exceeded its deadline.');
  const completedHistory = await allItems(cli, 'cloud', 'items', cloudId);
  check(sha256(canonical(historyContent(completedHistory.slice(0, history.length)))) === historyDigest, 'Cloud execution changed imported history.');
  await record('command', commandProof(completedHistory, turnId, command));
  idleSession(await cli('cloud', ['sessions', 'get', cloudId]), cloudId, model, imported.environment.id);
  const after = idleSession(await cli('local', ['sessions', 'get', source.sessionId]), source.sessionId, source.model, source.environmentId);
  check(sha256(canonical(settings(after))) === settingsDigest
    && sha256(canonical(historyContent(await allItems(cli, 'local', 'items', source.sessionId)))) === historyDigest,
  'Cloud continuation changed the local source Session settings or history.');
  await record('sourceRetained', { sessionId: source.sessionId, model: source.model, idle: true, historyUnchanged: true, settingsUnchanged: true });
  return { transferId: plan.id, sourceSessionId: source.sessionId, destinationSessionId: cloudId, turnId };
}

async function checkedFile(path, maximum, privateFile = false) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat({ bigint: true });
    check(before.isFile() && before.nlink === 1n && before.size <= BigInt(maximum)
      && (!privateFile || Number(before.uid) === process.getuid() && (before.mode & 0o077n) === 0n), 'Acceptance input is linked, special, oversized, or non-private.');
    const chunks = []; let size = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) { size += chunk.length; check(size <= maximum, 'Acceptance input exceeded its limit.'); chunks.push(chunk); }
    const after = await file.stat({ bigint: true });
    check(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode'].every(key => before[key] === after[key]) && BigInt(size) === before.size, 'Acceptance input changed while reading.');
    return Buffer.concat(chunks);
  } finally { await file.close(); }
}

async function absent(path) {
  try { await lstat(path); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}

async function withinTime(promise, milliseconds) {
  let timer;
  try { return await Promise.race([promise, new Promise(resolveTimeout => { timer = setTimeout(() => resolveTimeout(null), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

export function packagedProcesses(launcher, cwd, environment, signal) {
  const active = new Set();
  const interrupt = () => { for (const state of active) state.child.kill('SIGTERM'); };
  signal.addEventListener('abort', interrupt);
  function start(args) {
    signal.throwIfAborted();
    const child = spawn(launcher, args, { cwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const state = { child, chunks: [], bytes: 0, failed: false, result: null, done: undefined };
    active.add(state);
    for (const channel of ['stdout', 'stderr']) child[channel].on('data', chunk => {
      state.bytes += chunk.length;
      if (state.bytes > 8 * 1024 ** 2) { state.failed = true; child.kill('SIGTERM'); }
      else if (channel === 'stdout') state.chunks.push(chunk);
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
      throw new AcceptanceFailure('Packaged CLI did not stop within its deadline; profile retained.');
    }
    check(!state.failed && (!requireSuccess || result.code === 0), 'Packaged CLI did not exit successfully.');
  }
  return { start, stop, command: async args => {
    const state = start(args); let result = await withinTime(state.done, args[0] === 'transfer' ? 600_000 : 120_000);
    const timedOut = !result;
    if (!result) { await stop(state, false); result = state.result; }
    return { code: result?.code, failed: state.failed || timedOut, output: Buffer.concat(state.chunks).toString('utf8') };
  }, close: async () => {
    const results = await Promise.allSettled([...active].map(state => stop(state, false)));
    signal.removeEventListener('abort', interrupt);
    check(results.every(result => result.status === 'fulfilled'), 'Packaged CLI cleanup was not confirmed; profile retained.');
  } };
}

export async function runInstalledCloudTransfer(options) {
  options = parseAcceptanceArguments(['--app', options.app, '--directory', options.directory, '--evidence', options.evidence,
    '--endpoint', options.endpoint, '--region', options.region, '--model', options.model]);
  check(process.platform === 'darwin' && process.arch === 'arm64', 'Installed cloud transfer acceptance requires an Apple silicon Mac.');
  const app = await realpath(options.app); const directory = await realpath(options.directory); const inputPath = await realpath(options.evidence);
  const info = await lstat(directory);
  check(app.endsWith('.app') && (await lstat(app)).isDirectory() && info.isDirectory() && info.uid === process.getuid()
    && (info.mode & 0o077) === 0 && !within(app, directory) && !within(directory, app) && within(directory, inputPath), 'Choose a private profile with its subscription evidence outside the packaged app.');
  const launcher = join(app, 'Contents/MacOS/rat-things');
  check(await realpath(launcher) === launcher && (await lstat(launcher)).isFile(), 'Packaged CLI launcher is missing or linked.');
  const manifestPath = join(app, 'Contents/Resources/Runtime.bundle/Contents/Resources/runtime-manifest.json');
  check(await realpath(manifestPath) === manifestPath, 'Included runtime manifest is linked.');
  const manifestBytes = await checkedFile(manifestPath, 128 * 1024); const releaseId = sha256(manifestBytes); const manifest = decode(manifestBytes);
  const inputBytes = await checkedFile(inputPath, 256 * 1024, true);
  const source = subscriptionEvidence(decode(inputBytes), { app, directory, releaseId });
  const connectionPath = join(directory, 'connection.json');
  check(await absent(connectionPath), 'Stop the profile service before running acceptance; an existing connection will not be borrowed or removed.');
  const work = await mkdtemp(join(directory, 'installed-cloud-transfer-'));
  for (const name of ['tmp', 'cwd']) await mkdir(join(work, name), { mode: 0o700 });
  const evidencePath = join(work, 'evidence.json'); const nonce = randomUUID();
  const controller = new AbortController(); const interrupt = () => controller.abort();
  const deadline = setTimeout(interrupt, 30 * 60_000);
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  const environment = installedEnvironment(directory, join(work, 'tmp'), options.region);
  const children = packagedProcesses(launcher, join(work, 'cwd'), environment, controller.signal);
  const evidence = { version: 1, status: 'running', startedAt: new Date().toISOString(), app, directory, releaseId, nonce,
    runtime: 'installed-native', sourceSessionId: source.sessionId, sourceEvidence: { path: inputPath, sha256: sha256(inputBytes) },
    destination: { endpoint: options.endpoint, region: options.region, model: options.model },
    environment: { path: systemPath, workingDirectory: 'private_profile', hostCredentialChain: true, inheritedNames: Object.keys(environment).filter(key => awsEnvironment.includes(key)) },
    observations: {}, cleanup: { sourceSession: 'preserved', destinationSession: 'preserved_if_created', uploadedParts: 'preserved_for_deployment_cleanup', service: 'owned' },
    limits: ['four subscription proof files are checked by command after the public transfer snapshot; no host snapshot or credential files are read',
      'history comparison excludes top-level item and Turn IDs, Session IDs, and created/updated timestamps; ordered content and stable Session settings must match',
      'retry proves completed transfer receipt reuse after graceful service restart; interrupted upload, lost import acknowledgement, and abrupt recovery are not exercised',
      'same transfer ID is reused; no claim is made about listing or counting private uploaded parts', 'no clean-machine or notarization assessment'] };
  const save = () => writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  const record = async (name, value) => {
    evidence.observations[name] = value;
    if (name === 'lastTransferReceipt') { evidence.transferId = value.id; if (value.destinationSessionId) evidence.destinationSessionId = value.destinationSessionId; }
    await save();
  };
  let service; let connection; let selected; let failure;
  async function cli(scope, args) {
    check(service && !service.result && !service.failed, 'Owned packaged service is no longer running.');
    check(isDeepStrictEqual(connectionRecord(decode(await checkedFile(connectionPath, 4096, true))), connection), 'The profile connection changed during acceptance.');
    const result = await children.command([...args, ...(scope === 'cloud' ? ['--api-url', options.endpoint, '--region', options.region] : [])]);
    const values = cliDocuments(result.output, args[0] === 'transfer');
    let transferId = args[1] === 'plan' ? undefined : args[2];
    if (args[0] === 'transfer') for (const value of values) {
      const receipt = transferPlan(value, source, options, transferId); transferId = receipt.id;
      await record('lastTransferReceipt', receipt);
    }
    check(!result.failed && result.code === 0, 'Packaged CLI command failed or exceeded its deadline; retained IDs remain in evidence.');
    if (args[0] === 'sessions' && args[1] === 'send') { check(values.length === 0, 'Session send returned unexpected output.'); return; }
    check(values.length > 0, 'Packaged CLI did not return its requested resource.');
    return values.at(-1);
  }
  async function start(phase) {
    check(await absent(connectionPath), 'A service connection already exists for this profile.');
    const previous = connection; connection = undefined;
    service = children.start(['serve', '--port', '0', '--max-sessions', '1']);
    const readyBy = Date.now() + 180_000;
    while (Date.now() < readyBy) {
      controller.signal.throwIfAborted(); check(!service.result && !service.failed, 'Packaged service exited before readiness.');
      if (!connection && !await absent(connectionPath)) connection = connectionRecord(decode(await checkedFile(connectionPath, 4096, true)));
      if (connection) {
        check(!previous || previous.token !== connection.token, 'Restart did not rotate the local connection token.');
        const status = await localRequest(connection, 'GET', '/workspace/runtime', undefined, controller.signal);
        const ownedReady = Buffer.concat(service.chunks).toString('utf8').includes(`Your local workspace is ready at ${connection.baseURL}\nSaved on this computer: ${directory}\n`);
        if (status.ready && ownedReady) break;
        check(status.ready || status.installation?.state === 'checking', 'Set up the included native runtime before cloud acceptance.');
      }
      await delay(100, undefined, { signal: controller.signal });
    }
    check(connection && Date.now() < readyBy, 'Packaged service readiness exceeded its deadline.');
    await record(`${phase}Identity`, nativeIdentity(await localRequest(connection, 'GET', '/workspace', undefined, controller.signal), manifest, directory));
    const ready = nativeRuntime(await cli('local', ['runtime', 'status', '--json']), releaseId);
    check(!selected || isDeepStrictEqual(selected, ready), 'Service restart changed the selected runtime.'); selected = ready;
    await record(`${phase}Runtime`, ready);
  }
  async function stop() {
    check(service && !service.result, 'Packaged service exited before the requested stop.');
    await children.stop(service); service = undefined;
    check(await absent(connectionPath), 'Packaged service left its connection record after shutdown.');
  }
  try {
    await save(); await start('first');
    Object.assign(evidence, await transferScenario({ ...options, source, nonce }, { cli, record, signal: controller.signal,
      restart: async () => { await stop(); await start('restarted'); } }));
    await stop(); evidence.status = 'passed';
  } catch (error) {
    failure = error instanceof AcceptanceFailure ? error.message : controller.signal.aborted ? 'Acceptance interrupted or exceeded its deadline.' : 'Installed cloud transfer acceptance failed.';
    evidence.status = 'failed'; evidence.failure = failure;
  } finally {
    try { await children.close(); check(await absent(connectionPath), 'Packaged CLI cleanup left a connection record.'); evidence.cleanup.service = 'stopped'; }
    catch { failure = 'Packaged CLI cleanup was not confirmed; profile retained.'; evidence.failure = failure; evidence.status = 'failed'; evidence.cleanup.service = 'unconfirmed'; }
    clearTimeout(deadline); process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
    evidence.finishedAt = new Date().toISOString(); await save();
  }
  if (failure) throw new AcceptanceFailure(`${failure} Evidence: ${evidencePath}`);
  return { evidencePath, transferId: evidence.transferId, destinationSessionId: evidence.destinationSessionId };
}

if (process.argv[1] && await realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runInstalledCloudTransfer(parseAcceptanceArguments(process.argv.slice(2)));
    console.log(`Installed cloud transfer acceptance passed. Transfer: ${result.transferId}. Session: ${result.destinationSessionId}. Evidence: ${result.evidencePath}`);
  } catch (error) {
    console.error(error instanceof AcceptanceFailure ? error.message : 'Installed cloud transfer acceptance could not start.');
    process.exitCode = 1;
  }
}
