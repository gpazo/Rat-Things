import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, chmod, chown, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { CodexRpcClient } from '../adapters/codex-rpc.js';
import { assertNativeHistory, nativeCheckpointEvidence, type NativeCheckpointEvidence, type NativeCheckpointManifest } from '../domain/native-checkpoint.js';
import type { CodexAppServerRequest } from './codex-app-server.js';
import { stopCheckpointWriters } from './checkpoint-writers.js';

export interface PreparedColdVerification {
  verify(manifest: NativeCheckpointManifest): Promise<NativeCheckpointEvidence>;
  close(): Promise<void>;
}

/** Reject ambient effects rather than interpreting arbitrary configuration as safe. */
export function assertCheckpointStartupSafe(value: unknown, sessionConfig: unknown): void {
  if (!record(value) || !record(value.config)) throw new Error('Native checkpoint configuration is unavailable');
  for (const config of [value.config, sessionConfig ?? {}]) {
    if (!record(config)) throw new Error('Native checkpoint configuration is unsupported');
    for (const key of ['hooks', 'mcp_servers', 'plugins', 'notify', 'apps', 'browser_use', 'computer_use', 'desktop']) {
      const item = config[key];
      if (item !== undefined && item !== null && !(record(item) && Object.keys(item).length === 0) && !(Array.isArray(item) && item.length === 0)) throw new Error('Native checkpoint does not support active startup integrations');
    }
    for (const key of ['experimental_thread_store', 'experimental_thread_store_endpoint', 'sqlite_home']) {
      if (config[key] !== undefined && config[key] !== null) throw new Error('Native checkpoint storage configuration is unsupported');
    }
  }
}

/** Only the dedicated Linux worker may stop this UID and bind exact native paths. */
export async function prepareCodexColdVerification(options: { request: CodexAppServerRequest; stateRoot: string; manifest: NativeCheckpointManifest }): Promise<PreparedColdVerification> {
  const { request, stateRoot, manifest } = options;
  if (manifest.threads.some(thread => thread.cwd !== '/workspace' || typeof thread.modelProvider !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(thread.modelProvider))) throw new Error('Cold native checkpoint thread paths or providers are unsupported');
  if (manifest.threads.some(thread => ['ollama', 'lmstudio'].includes(String(thread.modelProvider)))) throw new Error('Cold native checkpoint provider is not yet supported');
  const uid = request.identity?.uid;
  const gid = request.identity?.gid;
  const home = request.environment.CODEX_HOME;
  const sqlite = request.environment.CODEX_SQLITE_HOME;
  if (process.platform !== 'linux' || process.getuid?.() !== 0 || !Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) || !uid || !gid
    || !request.managedPolicy || request.executionWorkspace !== '/workspace' || !home || !within(stateRoot, home)
    || !within(stateRoot, request.workspace) || (sqlite && !within(home, sqlite)) || !isAbsolute(request.binary)) throw new Error('Cold native checkpoint requires an isolated Linux guest with durable native storage');
  for (const path of [stateRoot, home, request.workspace]) if (await realpath(path) !== resolve(path)) throw new Error('Cold native checkpoint paths must not be symbolic links');
  const identity = { uid: uid!, gid: gid! };
  const binary = await realpath(request.binary);
  const bwrap = resolve(dirname(binary), '../codex-resources/bwrap');
  await access(bwrap, constants.X_OK);
  const directory = await mkdtemp(join(tmpdir(), 'rat-cold-native-'));
  // Root owns every staging name. A live agent may traverse the preflight
  // directories but cannot replace them or plant a candidate symlink.
  await chmod(directory, 0o711);
  const candidate = join(directory, 'candidate');
  const disposable = join(directory, 'verify');
  let closed = false;
  let attempted = false;
  let rpc: CodexRpcClient | undefined;
  const close = async () => {
    if (closed) return;
    closed = true;
    await rpc?.close();
    // The UID belongs exclusively to this stopped worker; this also reaps any
    // verifier descendants after a failed protocol request or a clean EOF.
    if (attempted) await stopCheckpointWriters(identity.uid);
    await rm(directory, { recursive: true, force: true });
  };
  try {
    await mkdir(disposable, { mode: 0o711 });
    await ownedDirectory(join(disposable, 'home'), identity);
    await ownedDirectory(join(disposable, 'workspace'), identity);
    const args = namespaceArguments({ binary, bwrap, home, sqlite, workspace: request.workspace, disposable, identity });
    // Check namespace support before sealing durable authority or stopping Codex.
    await checkedProcess(bwrap, [...args, '--', '/usr/bin/true'], identity);
    return {
      close,
      verify: async manifest => {
        if (closed || attempted) throw new Error('Cold native verifier is unavailable');
        attempted = true;
        const custodian = { uid: 0, gid: 0 };
        await ownedDirectory(candidate, custodian);
        await ownedDirectory(join(candidate, 'home'), custodian);
        await ownedDirectory(join(candidate, 'workspace'), custodian);
        await copyPersistence(home, join(candidate, 'home'), custodian);
        await copyTree(request.workspace, join(candidate, 'workspace'), custodian);
        const candidateDigest = await treeDigest(candidate);
        await rm(disposable, { recursive: true, force: true });
        await copyTree(candidate, disposable, identity);
        await chown(disposable, 0, 0); await chmod(disposable, 0o711);
        // Never copy auth/config/rules/plugins from CODEX_HOME. This complete
        // replacement configuration disables integrations before process startup.
        await rm(join(disposable, 'workspace', '.codex'), { recursive: true, force: true });
        await writeFile(join(disposable, 'home', 'config.toml'), verifierConfiguration(manifest), { mode: 0o600 });
        await chown(join(disposable, 'home', 'config.toml'), identity.uid, identity.gid);
        let activity = false;
        let configurationFailure: Error | undefined;
        rpc = new CodexRpcClient({ binary: bwrap, binaryArguments: [...args, '--', binary, 'app-server'], cwd: '/', environment: {}, identity,
          onEvent: event => {
            if (event.method === 'configWarning') configurationFailure ??= new Error('Cold native verifier configuration is invalid');
            if (event.requestId !== undefined || /^(turn\/(started|completed)|item\/|error$)/.test(event.method)) activity = true;
          }, onServerRequest: async () => { activity = true; throw new Error('Cold native verifier cannot perform tools'); },
        });
        try {
          await rpc.initialize();
          if (configurationFailure) throw configurationFailure;
          for (const expected of manifest.threads) {
            const result = await rpc.call('thread/read', { threadId: expected.id, includeTurns: true });
            assertNativeHistory(expected, record(result) ? result.thread : undefined, String(expected.id));
          }
          for (const expected of manifest.threads) {
            await rpc.call('thread/resume', { threadId: expected.id,
              ...(expected.id === manifest.rootThreadId ? { cwd: '/workspace', approvalPolicy: 'never', sandbox: 'read-only',
                config: { 'features.goals': false, 'features.hooks': false, 'features.plugins': false, 'features.apps': false, 'mcp_servers': {} } } : {}) });
            const result = await rpc.call('thread/read', { threadId: expected.id, includeTurns: true });
            assertNativeHistory(expected, record(result) ? result.thread : undefined, manifest.rootThreadId);
          }
          await rpc.closeCheckpoint();
          await stopCheckpointWriters(identity.uid);
          if (configurationFailure) throw configurationFailure;
          if (activity) throw new Error('Cold native verification attempted activity');
          if (await treeDigest(candidate) !== candidateDigest) throw new Error('Cold native candidate changed during verification');
          return nativeCheckpointEvidence(manifest);
        } catch (error) {
          // A fallback warning can arrive before a native request also fails to load config.
          throw configurationFailure ?? error;
        } finally { await rpc.close(); await stopCheckpointWriters(identity.uid); }
      },
    };
  } catch (error) { await close(); throw error; }
}

function namespaceArguments(options: { binary: string; bwrap: string; home: string; sqlite: string | undefined; workspace: string; disposable: string; identity: { uid: number; gid: number } }): string[] {
  const { binary, bwrap, home, sqlite, workspace, disposable } = options;
  return ['--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL', '--clearenv',
    '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/home/agent',
    '--ro-bind', binary, binary,
    '--dir', '/rat-cold-bin', '--ro-bind', bwrap, '/rat-cold-bin/bwrap',
    '--bind', join(disposable, 'home'), home,
    '--ro-bind', join(disposable, 'workspace'), workspace,
    ...(workspace === '/workspace' ? [] : ['--ro-bind', join(disposable, 'workspace'), '/workspace']),
    '--setenv', 'PATH', '/rat-cold-bin:/usr/bin:/bin', '--setenv', 'HOME', '/home/agent', '--setenv', 'CODEX_HOME', home,
    ...(sqlite ? ['--setenv', 'CODEX_SQLITE_HOME', sqlite] : []),
    '--setenv', 'AWS_EC2_METADATA_DISABLED', 'true', '--setenv', 'AWS_CONFIG_FILE', '/dev/null', '--setenv', 'AWS_SHARED_CREDENTIALS_FILE', '/dev/null',
    '--setenv', 'LOG_FORMAT', 'json', '--setenv', 'RUST_LOG', 'warn', '--chdir', '/workspace'];
}
function verifierConfiguration(manifest: NativeCheckpointManifest): string {
  // Keep built-in OpenAI intact. Its prewarm has no credentials and can only
  // reach a closed loopback address in the private network namespace.
  // Built-in Bedrock permits endpoint overrides, not generic provider replacement.
  // Its auth prewarm may fail without credentials; native read/resume remains local.
  const providers = [...new Set(manifest.threads.map(thread => String(thread.modelProvider)))].filter(provider => provider !== 'openai').map(provider =>
    ['amazon-bedrock', 'amazon-bedrock-runtime'].includes(provider)
      ? `\n[model_providers.${JSON.stringify(provider)}]\nbase_url = "http://127.0.0.1:1"\n`
      : `\n[model_providers.${JSON.stringify(provider)}]\nname = "Offline checkpoint verifier"\nbase_url = "http://127.0.0.1:1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n`).join('');
  return 'openai_base_url = "http://127.0.0.1:1"\napproval_policy = "never"\nsandbox_mode = "read-only"\ncli_auth_credentials_store = "file"\nnotify = []\nweb_search = "disabled"\n[features]\nplugins = false\napps = false\nhooks = false\ngoals = false\nmulti_agent = true\nmulti_agent_v2 = true\nresponses_websockets = false\nresponses_websockets_v2 = false\ncode_mode_prewarm = false\nshell_snapshot = false\nshell_snapshot_v2 = false\n' + providers;
}
function within(root: string, path: string): boolean { const part = relative(root, path); return isAbsolute(root) && isAbsolute(path) && part !== '' && part !== '..' && !part.startsWith('../') && !isAbsolute(part); }
async function ownedDirectory(path: string, identity: { uid: number; gid: number }): Promise<void> {
  try { await mkdir(path, { mode: 0o700 }); } catch (error) { if (!record(error) || error.code !== 'EEXIST') throw error; }
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Cold native destination must be a real directory');
  await chmod(path, 0o700); await chown(path, identity.uid, identity.gid);
}
async function copyPersistence(source: string, destination: string, identity: { uid: number; gid: number }): Promise<void> {
  for (const name of await readdir(source)) {
    if (['sessions', 'archived_sessions', 'sqlite'].includes(name) || /^(state|thread_history|goals|memories|queue)_\d+\.sqlite(?:-wal|-shm)?$/.test(name)) {
      await copyTree(join(source, name), join(destination, name), identity);
    }
  }
}
async function copyTree(source: string, destination: string, identity: { uid: number; gid: number }, root = source, budget = { entries: 0, bytes: 0 }): Promise<void> {
  const stat = await lstat(source);
  if (++budget.entries > 100_000 || (budget.bytes += stat.isFile() ? stat.size : 0) > 512 * 1024 * 1024) throw new Error('Cold native candidate exceeds copy bounds');
  if (stat.isDirectory()) {
    await ownedDirectory(destination, identity);
    for (const name of await readdir(source)) await copyTree(join(source, name), join(destination, name), identity, root, budget);
  } else if (stat.isFile()) {
    await copyFile(source, destination, constants.COPYFILE_EXCL); await chmod(destination, 0o600); await chown(destination, identity.uid, identity.gid);
  } else if (stat.isSymbolicLink()) {
    const target = await readlink(source);
    if (!within(root, resolve(dirname(source), target))) throw new Error('Cold native candidate has an external symbolic link');
    await symlink(target, destination);
  } else throw new Error('Cold native candidate contains a non-regular file');
}
async function treeDigest(root: string): Promise<string> {
  const digest = createHash('sha256');
  const visit = async (path: string): Promise<void> => {
    const stat = await lstat(path); digest.update(JSON.stringify([relative(root, path), stat.isFile() ? stat.size : null]));
    if (stat.isDirectory()) { digest.update('directory'); for (const name of (await readdir(path)).sort()) await visit(join(path, name)); }
    else if (stat.isFile()) { digest.update('file'); digest.update(await readFile(path)); }
    else if (stat.isSymbolicLink()) { digest.update('link'); digest.update(await readlink(path)); }
    else throw new Error('Cold native candidate contains a non-regular file');
  };
  await visit(root); return digest.digest('hex');
}
async function checkedProcess(binary: string, args: string[], identity: { uid: number; gid: number }): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, args, { cwd: '/', env: {}, ...identity, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 10_000);
    child.once('error', () => { clearTimeout(timer); reject(new Error('Cold native namespace could not start')); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('Cold native namespace is unavailable')); });
  });
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
