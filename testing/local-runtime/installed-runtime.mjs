import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';

const manifestPath = 'Contents/Resources/runtime-manifest.json';
const signaturePaths = ['CodeDirectory', 'CodeRequirements', 'CodeResources', 'CodeSignature'].map(name => `Contents/_CodeSignature/${name}`);
const systemPath = '/usr/bin:/bin:/usr/sbin:/sbin';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const within = (parent, child) => child === parent || child.startsWith(`${parent}${sep}`);
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);

class AcceptanceFailure extends Error {}
function check(condition, message) { if (!condition) throw new AcceptanceFailure(message); }
function decode(bytes) {
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw new AcceptanceFailure('Expected bounded JSON output.'); }
}

export function parseAcceptanceArguments(args, environment = process.env) {
  check(environment.RAT_INSTALLED_RUNTIME_ACCEPTANCE === '1', 'Set RAT_INSTALLED_RUNTIME_ACCEPTANCE=1 to run installed native acceptance.');
  let values;
  try { ({ values } = parseArgs({ args, options: { app: { type: 'string' }, directory: { type: 'string' } } })); }
  catch { throw new AcceptanceFailure('Use --app PATH --directory NEW_EMPTY_PROFILE.'); }
  check(values.app && values.directory, 'Use --app PATH --directory NEW_EMPTY_PROFILE.');
  return { app: resolve(values.app), directory: resolve(values.directory) };
}

export function installedEnvironment(directory, home, temporary) {
  return { HOME: home, TMPDIR: `${temporary}/`, LANG: 'C', LC_ALL: 'C', PATH: systemPath, RAT_THINGS_LOCAL_DIR: directory };
}

export function runtimeSummary(value, expected, fresh = false) {
  check(object(value) && object(value.installation), 'Installed runtime status is missing.');
  const state = value.installation;
  check(['checking', 'needs_setup', 'ready', 'failed', 'stopping'].includes(state.state)
    && typeof value.ready === 'boolean' && integer(state.generation), 'Invalid native runtime status.');
  check(value.platform === 'linux/arm64' && value.image === (fresh ? 'native:unselected' : `native:${expected}`), 'Runtime identity differs from the included release.');
  check(state.active === (fresh ? null : expected) && state.previous === null && state.pending === null && state.failure === null,
    'Runtime selection is not the fresh included release.');
  if (fresh) check(!value.ready && state.generation === 0 && ['checking', 'needs_setup'].includes(state.state), 'The profile was already set up.');
  else check(value.ready && state.state === 'ready' && state.generation > 0, 'The selected native runtime is not ready.');
  return { ready: value.ready, state: state.state, releaseId: state.active, generation: state.generation };
}

export function setupSummary(output) {
  const changes = output.trim().split(/\r?\n/).map(line => decode(Buffer.from(line)));
  const id = changes[0]?.id;
  check(typeof id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id), 'Setup did not return a change receipt.');
  for (const change of changes) {
    check(object(change) && change.id === id && change.action === 'setup' && integer(change.created_at) && integer(change.updated_at)
      && ['queued', 'working', 'complete'].includes(change.status), 'Setup did not complete successfully.');
    if (change.status === 'working') check(['checking', 'recovering', 'copying', 'verifying', 'probing', 'selecting'].includes(change.phase), 'Unknown setup phase.');
  }
  check(changes.at(-1)?.status === 'complete', 'Setup did not report complete after the real probe.');
  return { id, status: 'complete', observedPhases: [...new Set(changes.filter(change => change.status === 'working').map(change => change.phase))] };
}

export function nativeIdentity(value, manifest, directory) {
  check(object(value) && value.kind === 'local' && object(value.service) && value.service.kind === 'native'
    && object(value.service.protocol) && value.directory === directory, 'The packaged launcher did not start the selected native workspace.');
  const actual = value.service.protocol;
  const expected = manifest.compatibility;
  check(actual.hostTarget === expected.hostTarget && actual.guestTarget === expected.guestTarget
    && ['workerProtocol', 'accountStateFormat', 'profileSchema'].every(key => actual[key] === expected[key])
    && ['appProtocol', 'controllerProtocol'].every(key => integer(actual[key]) && actual[key] >= expected[key].minimum && actual[key] <= expected[key].maximum)
    && actual.workspaceFormat === expected.workspaceFormat.write && expected.workspaceFormat.read.includes(actual.workspaceFormat),
  'The native service protocol differs from the included release.');
  return { kind: 'native', protocol: Object.fromEntries(['hostTarget', 'guestTarget', 'appProtocol', 'controllerProtocol', 'workerProtocol',
    'workspaceFormat', 'accountStateFormat', 'profileSchema'].map(key => [key, actual[key]])) };
}

export function unsignedAccount(value) {
  check(object(value) && value.harness === 'codex' && value.provider === 'chatgpt' && value.signed_in === false
    && value.account_type === null && value.email === null && value.plan === null, 'The fresh profile did not report an unsigned ChatGPT account.');
  return { harness: 'codex', provider: 'chatgpt', signed_in: false, account_type: null, email: null, plan: null };
}

async function checkedFile(path, maximum = 128 * 1024, capture = true) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat({ bigint: true });
    check(before.isFile() && before.nlink === 1n && before.size <= BigInt(maximum), 'Unexpected linked, special, or oversized acceptance input.');
    const hash = createHash('sha256'); const chunks = []; let bytes = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      bytes += chunk.length;
      check(bytes <= maximum, 'Acceptance input exceeds its byte limit.');
      hash.update(chunk);
      if (capture) chunks.push(chunk);
    }
    const identity = state => [state.dev, state.ino, state.size, state.mtimeNs, state.ctimeNs, state.mode].map(String).join(':');
    check(identity(before) === identity(await file.stat({ bigint: true })) && BigInt(bytes) === before.size, 'Acceptance input changed while reading.');
    return { bytes, sha256: hash.digest('hex'), identity: identity(before), mode: Number(before.mode), uid: Number(before.uid),
      ...(capture ? { data: Buffer.concat(chunks) } : {}) };
  } finally { await file.close(); }
}

async function absence(path) {
  try { await lstat(path); return false; }
  catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}

function manifestInventory(value) {
  check(object(value) && value.schemaVersion === 1 && object(value.compatibility) && Array.isArray(value.files)
    && value.files.length > 0 && value.files.length <= 4096, 'Invalid included runtime manifest.');
  const compatibility = value.compatibility;
  check(compatibility.hostTarget === 'aarch64-apple-darwin' && compatibility.guestTarget === 'aarch64-unknown-linux-gnu'
    && object(compatibility.workspaceFormat) && Array.isArray(compatibility.workspaceFormat.read)
    && integer(compatibility.workspaceFormat.write)
    && ['workerProtocol', 'accountStateFormat', 'profileSchema'].every(key => integer(compatibility[key]))
    && ['appProtocol', 'controllerProtocol'].every(key => object(compatibility[key]) && integer(compatibility[key].minimum)
      && integer(compatibility[key].maximum) && compatibility[key].minimum <= compatibility[key].maximum), 'Invalid included runtime compatibility.');
  const safePath = path => typeof path === 'string' && path.startsWith('Contents/') && Buffer.byteLength(path) <= 1024
    && path.normalize('NFC') === path && !/[\\:\u0000-\u001f\u007f]/.test(path) && path.split('/').length <= 32
    && path.split('/').every(part => part && part !== '.' && part !== '..' && Buffer.byteLength(part) <= 255);
  const inventory = value.files.map(file => {
    check(object(file) && safePath(file.path) && !file.path.endsWith('/auth.json') && hex(file.sha256) && integer(file.bytes) && file.bytes <= 768 * 1024 ** 2
      && ['resource', 'host-executable'].includes(file.kind) && ![manifestPath, ...signaturePaths].includes(file.path), 'Invalid included file inventory.');
    return { path: file.path, bytes: file.bytes, sha256: file.sha256, executable: file.kind === 'host-executable' };
  });
  check(new Set(inventory.map(file => file.path.toLowerCase())).size === inventory.length
    && inventory.reduce((total, file) => total + file.bytes, 0) <= 2 * 1024 ** 3, 'Included runtime inventory exceeds its limits.');
  return inventory;
}

async function copiedRelease(directory, releaseId, expected) {
  const root = join(directory, 'runtime');
  check(equal((await readdir(join(root, 'versions'))).sort(), [releaseId]), 'The fresh profile contains another installed release.');
  for (const name of ['staging', 'probes']) check((await readdir(join(root, name))).length === 0, 'Setup left unfinished runtime work.');
  const selection = decode((await checkedFile(join(root, 'selection.json'), 16 * 1024)).data);
  check(object(selection) && selection.schemaVersion === 1 && selection.active === releaseId && selection.previous === null
    && selection.pending === null && integer(selection.generation) && selection.generation > 0, 'The saved selection differs from the included release.');
  const version = join(root, 'versions', releaseId);
  const wrapper = await lstat(version);
  check(wrapper.isDirectory() && wrapper.uid === process.getuid() && (wrapper.mode & 0o222) === 0
    && equal(await readdir(version), ['Runtime.bundle']), 'Installed version is not sealed and profile-owned.');
  const bundle = join(version, 'Runtime.bundle'); const files = []; const identities = []; let entries = 0;
  const expectedFiles = new Map(expected.map(file => [file.path, file]));
  const expectedDirectories = new Set(expected.flatMap(file => file.path.split('/').slice(0, -1).map((_, index) => file.path.split('/').slice(0, index + 1).join('/'))));
  async function visit(path, relative = '') {
    const state = await lstat(path);
    check((!relative || expectedDirectories.has(relative)) && state.isDirectory() && state.uid === process.getuid()
      && (state.mode & 0o222) === 0, 'Installed runtime directory is not sealed and profile-owned.');
    identities.push([relative, String(state.dev), String(state.ino), String(state.mtimeMs), state.mode]);
    for (const name of (await readdir(path)).sort()) {
      check(++entries <= 4096 && relative.split('/').length <= 32, 'Installed runtime exceeds its entry limit.');
      const child = relative ? `${relative}/${name}` : name;
      const status = await lstat(join(path, name));
      if (status.isDirectory()) await visit(join(path, name), child);
      else {
        const wanted = expectedFiles.get(child);
        check(wanted && status.isFile(), 'Installed runtime has an unexpected file.');
        const file = await checkedFile(join(path, name), wanted.bytes, false);
        check(file.uid === process.getuid() && (file.mode & 0o222) === 0 && Boolean(file.mode & 0o111) === wanted.executable
          && file.bytes === wanted.bytes && file.sha256 === wanted.sha256, 'Copied signed runtime bytes or permissions differ.');
        files.push({ path: child, bytes: file.bytes, sha256: file.sha256, executable: wanted.executable });
        identities.push([child, file.identity]);
      }
    }
  }
  await visit(bundle);
  check(files.length === expected.length, 'Installed runtime is missing signed files.');
  return { selection: { active: selection.active, previous: null, pending: null, generation: selection.generation },
    files: files.length, bytes: files.reduce((total, file) => total + file.bytes, 0),
    contentSha256: digest(JSON.stringify(files)), filesystemSha256: digest(JSON.stringify(identities)) };
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
  function start(args, extra = {}) {
    signal.throwIfAborted();
    const child = spawn(launcher, args, { cwd, env: { ...environment, ...extra }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const state = { child, stdout: '', stderr: '', failure: null, result: null, done: undefined };
    active.add(state);
    for (const channel of ['stdout', 'stderr']) child[channel].on('data', chunk => {
      if (state.failure) return;
      if (Buffer.byteLength(state.stdout) + Buffer.byteLength(state.stderr) + chunk.length > 1024 * 1024) {
        state.failure = 'Packaged launcher output exceeded its limit.'; child.kill('SIGTERM');
      } else state[channel] += chunk.toString('utf8');
    });
    state.done = new Promise(resolveDone => {
      child.once('error', () => { state.failure = 'Could not launch the packaged CLI.'; });
      child.once('close', (code, stoppedBy) => {
        state.result = { code, stoppedBy }; active.delete(state); resolveDone(state.result);
      });
    });
    return state;
  }
  async function stop(state, successful = true) {
    if (!state.result) state.child.kill('SIGTERM');
    let result = await withinTime(state.done, 60_000);
    if (!result) {
      try { process.kill(-state.child.pid, 'SIGKILL'); } catch {}
      await withinTime(state.done, 5000);
      throw new AcceptanceFailure('Packaged CLI did not finish graceful shutdown; profile retained.');
    }
    check(!state.failure && (!successful || result.code === 0), state.failure ?? 'Packaged service did not exit successfully.');
  }
  async function command(args, extra = {}, timeout = 180_000) {
    const state = start(args, extra);
    const result = await withinTime(state.done, timeout);
    if (!result) { await stop(state, false); throw new AcceptanceFailure('Packaged CLI command exceeded its deadline.'); }
    check(!state.failure, state.failure ?? 'Packaged CLI command failed.');
    return { ...result, stdout: state.stdout, stderr: state.stderr };
  }
  return { start, stop, command, close: async () => {
    const results = await Promise.allSettled([...active].map(state => stop(state, false)));
    signal.removeEventListener('abort', interrupt);
    check(results.every(result => result.status === 'fulfilled'), 'Packaged CLI cleanup was not confirmed; profile retained.');
  } };
}

async function readConnection(directory) {
  const record = decode((await checkedFile(join(directory, 'connection.json'), 4096)).data);
  check(object(record) && hex(record.token) && typeof record.baseURL === 'string', 'Invalid local connection record.');
  let url;
  try { url = new URL(record.baseURL); } catch { throw new AcceptanceFailure('Invalid local connection endpoint.'); }
  check(url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port && url.pathname === '/v1'
    && !url.username && !url.password && !url.search && !url.hash, 'Connection must use authenticated loopback.');
  return { baseURL: url.href, token: record.token };
}

async function request(connection, path, signal) {
  check(['/workspace', '/workspace/runtime', '/workspace/subscription'].includes(path)
    || /^\/workspace\/runtime\/changes\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(path), 'Unexpected acceptance request.');
  return new Promise((resolveResponse, reject) => {
    const failure = () => reject(new AcceptanceFailure('Authenticated local status request failed.'));
    const outgoing = httpRequest(`${connection.baseURL}${path}`, { method: 'GET', agent: false, maxHeaderSize: 16 * 1024,
      headers: { authorization: `Bearer ${connection.token}` }, signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) }, response => {
      if (response.statusCode !== 200) { response.destroy(); failure(); return; }
      const chunks = []; let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 32 * 1024) {
          response.destroy(); reject(new AcceptanceFailure('Local status response exceeded its limit.'));
        } else chunks.push(chunk);
      });
      response.once('error', failure);
      response.once('end', () => {
        try { resolveResponse(decode(Buffer.concat(chunks))); } catch (error) { reject(error); }
      });
    });
    outgoing.once('error', failure);
    outgoing.end();
  });
}

export async function runInstalledAcceptance(options) {
  check(process.env.RAT_INSTALLED_RUNTIME_ACCEPTANCE === '1', 'Set RAT_INSTALLED_RUNTIME_ACCEPTANCE=1 to run installed native acceptance.');
  check(process.platform === 'darwin' && process.arch === 'arm64', 'Installed native acceptance requires an Apple silicon Mac.');
  const app = await realpath(options.app);
  check(app.endsWith('.app') && (await lstat(app)).isDirectory(), 'Choose the packaged Rat Things app.');
  const launcher = join(app, 'Contents/MacOS/rat-things');
  check(await realpath(launcher) === launcher && (await lstat(launcher)).isFile(), 'The packaged command-line launcher is missing or linked.');
  const source = join(app, 'Contents/Resources/Runtime.bundle');
  const manifestFile = await checkedFile(join(source, manifestPath));
  const manifest = decode(manifestFile.data); const releaseId = manifestFile.sha256;
  const inventory = manifestInventory(manifest);
  const expected = [...inventory, { path: manifestPath, bytes: manifestFile.bytes, sha256: releaseId, executable: false }];
  for (const path of signaturePaths) {
    const file = await checkedFile(join(source, path), 16 * 1024 ** 2, false);
    expected.push({ path, bytes: file.bytes, sha256: file.sha256, executable: false });
  }
  const parent = await realpath(dirname(options.directory));
  const requested = join(parent, options.directory.split(sep).at(-1));
  check(!within(app, requested) && !within(requested, app), 'The acceptance profile must be outside the app.');
  try { await mkdir(requested, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const info = await lstat(requested);
  check(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid() && (info.mode & 0o077) === 0
    && (await readdir(requested)).length === 0, 'Choose a new or empty private profile directory.');
  const directory = await realpath(requested);
  const work = join(directory, 'installed-runtime-acceptance');
  await mkdir(work, { mode: 0o700 });
  for (const name of ['home', 'tmp', 'cwd']) await mkdir(join(work, name), { mode: 0o700 });
  const evidencePath = join(work, 'evidence.json');
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  const environment = installedEnvironment(directory, join(work, 'home'), join(work, 'tmp'));
  const children = processes(launcher, join(work, 'cwd'), environment, controller.signal);
  const evidence = { schemaVersion: 1, status: 'running', startedAt: new Date().toISOString(), app, directory, releaseId,
    environment: { path: systemPath, home: 'private_profile', workingDirectory: 'private_profile', inheritedEnvironment: false }, observations: {},
    limits: ['fresh profile on this host, not a clean physical machine', 'no notarization assessment', 'no login, token refresh, model inference, rollback, or cloud transfer'] };
  let failure;
  const record = async (name, value) => {
    evidence.observations[name] = value;
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  };
  const connectionAbsent = async () => check(await absence(join(directory, 'connection.json')), 'A CLI-owned local service did not remove its connection record.');
  async function serve() {
    const child = children.start(['serve', '--port', '0']);
    const deadline = Date.now() + 180_000;
    let connection;
    while (Date.now() < deadline) {
      controller.signal.throwIfAborted();
      check(!child.result && !child.failure, 'Packaged service exited before readiness.');
      if (!connection && !await absence(join(directory, 'connection.json'))) connection = await readConnection(directory);
      if (connection) {
        const status = await request(connection, '/workspace/runtime', controller.signal);
        if (status.ready) return { child, connection };
        check(status.installation?.state === 'checking', 'The installed runtime failed to become ready.');
      }
      await delay(100, undefined, { signal: controller.signal });
    }
    throw new AcceptanceFailure('Native service readiness exceeded its deadline.');
  }
  try {
    await record('profile', { initiallyEmpty: true });
    for (const name of ['CODEX_BINARY', 'RAT_THINGS_CONSOLE_NODE', 'RAT_THINGS_CONSOLE_SERVER', 'RAT_THINGS_CONSOLE_BIN', 'RAT_NATIVE_SOURCE_IMAGE']) {
      const result = await children.command(['runtime', 'status', '--json'], { [name]: join(work, 'must-not-run') });
      check(result.code !== 0 && result.stderr.includes(`The installed app does not accept the executable override ${name}`), 'The packaged launcher accepted an executable override.');
    }
    await connectionAbsent();
    await record('executableOverrides', { rejected: 5 });
    const fresh = await children.command(['runtime', 'status', '--json']);
    check(fresh.code === 0, 'Fresh packaged runtime status failed.');
    await record('freshRuntime', runtimeSummary(decode(Buffer.from(fresh.stdout)), releaseId, true));
    await connectionAbsent();
    check((await readdir(join(directory, 'runtime/versions'))).length === 0, 'Fresh status unexpectedly installed a release.');
    const setup = await children.command(['runtime', 'setup', '--json'], {}, 10 * 60_000);
    check(setup.code === 0, 'Packaged runtime setup failed.');
    const receipt = setupSummary(setup.stdout);
    await record('setup', receipt);
    await connectionAbsent();
    const installed = await copiedRelease(directory, releaseId, expected);
    await record('copiedRelease', installed);
    for (const phase of ['afterSetup', 'afterRestart']) {
      const service = await serve();
      await record(`${phase}Identity`, nativeIdentity(await request(service.connection, '/workspace', controller.signal), manifest, directory));
      const status = await children.command(['runtime', 'status', '--json']);
      check(status.code === 0, 'Packaged runtime status failed after selection.');
      const ready = runtimeSummary(decode(Buffer.from(status.stdout)), releaseId);
      check(ready.generation === installed.selection.generation, 'Service restart changed the selected generation.');
      await record(`${phase}Runtime`, ready);
      await record(`${phase}Account`, unsignedAccount(await request(service.connection, '/workspace/subscription', controller.signal)));
      const saved = await request(service.connection, `/workspace/runtime/changes/${receipt.id}`, controller.signal);
      check(saved.id === receipt.id && saved.action === 'setup' && saved.status === 'complete', 'Setup receipt did not survive service restart.');
      check(!service.child.result, 'Packaged service exited before the requested graceful stop.');
      await children.stop(service.child);
      await connectionAbsent();
      await record(`${phase}Shutdown`, { graceful: true, connectionRemoved: true });
    }
    const restarted = await copiedRelease(directory, releaseId, expected);
    check(equal(installed, restarted), 'Service restart replaced or changed installed runtime bytes.');
    await record('restartReuse', { sameSelection: true, sameContent: true, sameFilesystemIdentity: true });
    evidence.status = 'passed';
  } catch (error) {
    failure = error instanceof AcceptanceFailure ? error.message : controller.signal.aborted ? 'Acceptance interrupted.' : 'Installed acceptance operation failed.';
    evidence.status = 'failed'; evidence.failure = failure;
  } finally {
    try { await children.close(); }
    catch { evidence.status = 'failed'; evidence.cleanup = 'unconfirmed'; failure = 'Packaged CLI cleanup was not confirmed; profile retained.'; evidence.failure = failure; }
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
    evidence.finishedAt = new Date().toISOString();
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  }
  if (failure) throw new AcceptanceFailure(`${failure} Evidence: ${evidencePath}`);
  return { evidencePath, releaseId };
}

if (process.argv[1] && await realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runInstalledAcceptance(parseAcceptanceArguments(process.argv.slice(2)));
    console.log(`Installed native acceptance passed. Release: ${result.releaseId}. Evidence: ${result.evidencePath}`);
  } catch (error) {
    console.error(error instanceof AcceptanceFailure ? error.message : 'Installed native acceptance could not start.');
    process.exitCode = 1;
  }
}
