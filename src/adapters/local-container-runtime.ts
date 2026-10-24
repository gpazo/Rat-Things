import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { classifyLocalEngine, localEngineEndpoint, localIsolation, LOCAL_WORKER_IMAGE, localWorkerNames, planLocalRuntimeSetup, planWorkerImageInstall, workerPlatform,
  type LocalIsolation, type LocalRuntimeStatus, type WorkerImageManifest, type WorkerPlatform } from '../domain/local-runtime.js';
import { WORKSPACE_EXPORT_SCRIPT, type PortableFile } from '../domain/workspace-transfer.js';
import publishedImages from '../../runtime/local/images.json' with { type: 'json' };
import type { LocalRuntime, LocalStartRequest } from '../core/local-runtime-ports.js';
import { localWorkspaceIdentity } from '../domain/local-workspace.js';
import { LocalRuntimeLifecycle } from './local-runtime-lifecycle.js';
import { localWorkspaceSetupTimeoutMs } from '../domain/local-workspace-setup.js';

const exec = promisify(execFile);
const pinnedEnvironment = () => { const { DOCKER_CONTEXT: _context, DOCKER_HOST: _host, ...env } = process.env; return env; };
const command = async (args: string[], endpoint?: string) => (await exec('docker', [...(endpoint ? ['--host', endpoint] : []), ...args], { timeout: 30_000, maxBuffer: 1024 * 1024, encoding: 'utf8', ...(endpoint ? { env: pinnedEnvironment() } : {}) })).stdout.trim();
/** Building the worker image needs the Codex artifact and Dockerfile from a Rat Things checkout. */
export const localCheckout = () => existsSync(resolve('scripts/build-local-runtime.mjs')) && existsSync(resolve('runtime/local/Dockerfile'));
const previewPlatforms = () => process.env.RAT_THINGS_PREVIEW_PLATFORMS === '1';

/** Discovery follows Cua's engine classification; remote engines are deliberately rejected. */
export async function localRuntimeStatus(): Promise<LocalRuntimeStatus> {
  const checks: LocalRuntimeStatus['checks'] = [];
  let endpoint: string | undefined;
  let engine: LocalRuntimeStatus['engine'] = 'unknown';
  let platform: WorkerPlatform | undefined;
  let isolation: LocalIsolation | undefined;
  try {
    endpoint = process.env.DOCKER_CONTEXT ? undefined : process.env.DOCKER_HOST;
    endpoint ??= JSON.parse(await command(['context', 'inspect']))[0]?.Endpoints?.docker?.Host as string | undefined;
    if (!localEngineEndpoint(endpoint, process.platform)) { endpoint = undefined; throw new Error('Local engine endpoint required'); }
    engine = classifyLocalEngine(endpoint!, process.platform);
    const info = JSON.parse(await command(['info', '--format', '{{json .}}'], endpoint)) as { OperatingSystem?: string; Architecture?: string; MemTotal?: number; Runtimes?: Record<string, unknown> };
    if (info.OperatingSystem === 'Docker Desktop') engine = 'docker-desktop';
    platform = workerPlatform(info.Architecture);
    const boundary = localIsolation({ platform: process.platform, engine, runtimes: Object.keys(info.Runtimes ?? {}), workerPlatform: platform });
    if ('boundary' in boundary) {
      isolation = boundary;
      const admitted = !boundary.preview || previewPlatforms();
      checks.push(admitted ? { id: 'engine', ready: true, message: boundary.boundary === 'gvisor' ? 'Workers run under gVisor.' : 'Linux VM is running.' }
        : { id: 'engine', ready: false, message: 'This platform is in preview.', action: 'Set RAT_THINGS_PREVIEW_PLATFORMS=1 to try it; Apple silicon Macs are the supported platform.' });
    } else checks.push({ id: 'engine', ready: false, ...boundary });
    checks.push({ id: 'architecture', ready: platform !== undefined, message: 'The worker runs Linux on ARM64 or x86-64.' });
    checks.push({ id: 'memory', ready: (info.MemTotal ?? 0) >= 2 * 1024 ** 3, message: 'The Linux VM needs at least 2 GiB of memory.' });
  } catch {
    if (!checks.length) checks.push({ id: 'engine', ready: false, message: 'The local Linux VM is unavailable.', action: 'Start a local container engine, then run rat-things runtime doctor.' });
  }
  const install = planWorkerImageInstall({ platform, manifest: publishedImages as WorkerImageManifest, checkout: localCheckout() });
  const action = install.kind === 'unavailable' ? install.message : 'Run rat-things runtime setup.';
  try {
    const image = JSON.parse(await command(['image', 'inspect', LOCAL_WORKER_IMAGE], endpoint))[0] as { Architecture?: string; Os?: string };
    checks.push({ id: 'image', ready: platform !== undefined && `${image.Os}/${image.Architecture}` === platform, message: 'Rat Things Linux worker image.', action });
  } catch { checks.push({ id: 'image', ready: false, message: 'The Rat Things worker image is not installed.', action }); }
  return { ready: checks.every(check => check.ready), engine, ...(endpoint ? { endpoint } : {}), ...(platform ? { platform } : {}), ...(isolation ? { isolation } : {}),
    image: LOCAL_WORKER_IMAGE, install: install.kind, checks };
}

/** Pulls the digest-pinned published image and tags it locally; the engine verifies its content. */
export async function installPublishedWorkerImage(status: LocalRuntimeStatus) {
  const install = planWorkerImageInstall({ platform: status.platform, manifest: publishedImages as WorkerImageManifest, checkout: false });
  if (install.kind !== 'pull' || !status.endpoint) throw new Error(install.kind === 'unavailable' ? install.message : 'The local engine is unavailable.');
  await new Promise<void>((resolve, reject) => {
    const child = spawn('docker', ['--host', status.endpoint!, 'pull', '--platform', status.platform!, install.reference], { env: pinnedEnvironment(), stdio: 'inherit', shell: false });
    child.once('error', () => reject(new Error('The container engine could not start the download.')));
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('The worker image download did not complete. Run rat-things runtime setup to retry.')));
  });
  const image = JSON.parse(await command(['image', 'inspect', install.reference], status.endpoint))[0] as { Architecture?: string; Os?: string };
  if (`${image.Os}/${image.Architecture}` !== status.platform) throw new Error('The downloaded worker image does not match this Linux VM.');
  await command(['tag', install.reference, LOCAL_WORKER_IMAGE], status.endpoint);
}

/** One named workspace volume per Session. No host paths, credentials or engine socket are mounted. */
export class LocalContainerRuntime implements LocalRuntime {
  private readonly active = new Set<string>();
  private readonly lifecycle = new LocalRuntimeLifecycle();
  private endpoint: string | undefined;
  private platform: WorkerPlatform = 'linux/arm64';
  private isolation: LocalIsolation | undefined;
  private command(args: string[]) { if (!this.endpoint) throw new Error('Local engine has not been selected'); return command(args, this.endpoint); }
  public constructor(private readonly workspaceId: string) {}

  public status() { return localRuntimeStatus(); }

  public async setup(): Promise<LocalRuntimeStatus> {
    const status = await this.status();
    const plan = planLocalRuntimeSetup(status);
    if (plan.kind === 'blocked') throw new Error(plan.message);
    if (plan.kind === 'ready') return status;
    if (!status.endpoint) throw new Error('The local engine is unavailable.');
    if (plan.method === 'pull') await installPublishedWorkerImage(status);
    else await new Promise<void>((resolveBuild, reject) => {
      const child = spawn(process.execPath, [resolve('scripts/build-local-runtime.mjs')], {
        env: { ...pinnedEnvironment(), DOCKER_HOST: status.endpoint }, stdio: 'inherit', shell: false,
      });
      child.once('error', () => reject(new Error('The worker image build could not start.')));
      child.once('exit', code => code === 0 ? resolveBuild() : reject(new Error('The worker image build did not complete.')));
    });
    const installed = await this.status();
    if (installed.endpoint !== status.endpoint) throw new Error('The local container engine changed during setup. Run rat-things runtime doctor.');
    if (!installed.ready) throw new Error(installed.checks.filter(check => !check.ready).map(check => `${check.message} ${check.action ?? ''}`.trim()).join(' '));
    return installed;
  }

  public start(request: LocalStartRequest, commitWorkspaceClaim: () => Promise<void>): Promise<string> { return this.lifecycle.run(request.worker.sessionId, () => this.startWorker(request, commitWorkspaceClaim)); }
  private async startWorker(request: LocalStartRequest, commitWorkspaceClaim: () => Promise<void>): Promise<string> {
    const sessionId = request.worker.sessionId;
    const identity = localWorkspaceIdentity(request.workspace.identity);
    if (identity.sessionId !== sessionId) throw new Error('Workspace claim does not match Session');
    const status = await this.status();
    if (!status.ready) throw new Error(status.checks.filter(check => !check.ready).map(check => `${check.message} ${check.action ?? ''}`).join(' '));
    if (this.endpoint && this.endpoint !== status.endpoint) throw new Error('The local container engine changed. Restart the local workspace to select it.');
    this.adopt(status);
    const { name, volume } = localWorkerNames(this.workspaceId, sessionId);
    const stateVolume = `${volume}-state`;
    const names = (await this.command(['volume', 'ls', '--format', '{{.Name}}'])).split('\n');
    for (const target of [volume, stateVolume]) {
      if (request.workspace.kind === 'create' && names.includes(target)) throw new Error('New workspace storage already exists');
      if (request.workspace.kind === 'resume' && !names.includes(target)) throw new Error('Saved local workspace storage is missing');
    }
    await commitWorkspaceClaim();
    for (const target of [volume, stateVolume]) {
      if (request.workspace.kind === 'create') await this.command(['volume', 'create', '--label', `rat-things.workspace=${this.workspaceId}`,
        '--label', `rat-things.generation=${identity.generation}`, target]);
      const data = JSON.parse(await this.command(['volume', 'inspect', target]))[0];
      if (data.Labels?.['rat-things.workspace'] !== this.workspaceId || data.Labels?.['rat-things.generation'] !== identity.generation) throw new Error('Saved local workspace identity does not match');
    }
    await this.removeContainer(name);
    // Pin the image ID for this launch, so a tag update cannot change it mid-creation.
    const image = await this.command(['image', 'inspect', '--format', '{{.Id}}', LOCAL_WORKER_IMAGE]);
    if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Invalid worker image identity');
    await this.command(['create', '--name', name, '--label', `rat-things.workspace=${this.workspaceId}`, '--label', `rat-things.session=${sessionId}`,
      '--platform', this.platform, ...this.runtimeArguments(), '--interactive', '--init', '--cpus', '2', '--memory', '2g', '--pids-limit', '256',
      '--cap-drop', 'ALL', '--cap-add', 'SETUID', '--cap-add', 'SETGID', '--cap-add', 'CHOWN', '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'KILL',
      '--security-opt', 'no-new-privileges', '--security-opt', 'seccomp=unconfined',
      '--mount', `type=volume,source=${volume},target=/workspace`, '--mount', `type=volume,source=${stateVolume},target=/var/lib/rat-things/workspace`, '--publish', '127.0.0.1::3211', image]);
    const child = spawn('docker', ['--host', this.endpoint!, 'start', '--attach', '--interactive', name], { env: pinnedEnvironment(), stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    let diagnostic = '';
    child.stderr.on('data', (chunk: Buffer) => { const match = chunk.toString().match(/Local worker failed during (configuration|workspace|setup|transport|executor)\./); if (match) diagnostic = match[0]; });
    const lines = createInterface({ input: child.stdout });
    let timer: NodeJS.Timeout | undefined;
    const ready = new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + localWorkspaceSetupTimeoutMs(request.worker.launch.hostedConfiguration, request.workspace.kind);
      const expire = () => {
        const remaining = deadline - Date.now();
        if (remaining > 0) { timer = setTimeout(expire, Math.min(remaining, 2_147_483_647)); return; }
        reject(new Error('Local worker setup timed out. Check packages and setup commands.'));
      };
      expire();
      lines.on('line', line => { if (line === '{"status":"ready"}') resolve(); });
      child.once('error', () => reject(new Error('Local worker process failed to start.')));
      child.once('exit', () => reject(new Error(diagnostic || 'Local worker stopped during setup.')));
    });
    void ready.catch(() => {});
    try {
      let url: string | undefined;
      for (let attempt = 0; attempt < 100; attempt++) {
        const data = JSON.parse(await this.command(['inspect', name]))[0];
        const port = data.NetworkSettings?.Ports?.['3211/tcp']?.[0];
        if (data.State?.Running && port?.HostIp === '127.0.0.1' && /^\d+$/.test(port.HostPort)) { url = `http://127.0.0.1:${port.HostPort}`; break; }
        await delay(50);
      }
      if (!url) throw new Error('Local worker did not bind its private transport.');
      child.stdin.end(`${JSON.stringify({ ...request.worker, workspace: request.workspace, publicURL: url })}\n`);
      await ready;
      this.active.add(name);
      return url;
    } catch (error) {
      await this.removeContainer(name).catch(() => {});
      throw error;
    } finally { clearTimeout(timer); lines.close(); child.stdout.resume(); }
  }

  public async admitTurn(_sessionId: string): Promise<void> {}

  public stop(sessionId: string) { return this.lifecycle.run(sessionId, async () => { if (this.endpoint) await this.removeContainer(localWorkerNames(this.workspaceId, sessionId).name); }); }
  public snapshot(sessionId: string): Promise<PortableFile[]> { return this.lifecycle.run(sessionId, () => this.snapshotWorker(sessionId)); }
  private async snapshotWorker(sessionId: string): Promise<PortableFile[]> {
    const { name, volume } = localWorkerNames(this.workspaceId, sessionId);
    await this.select();
    await this.volume(volume);
    await this.volume(`${volume}-state`);
    await this.removeContainer(name);
    const result = await exec('docker', ['--host', this.endpoint!, 'run', '--rm', '--platform', this.platform, ...this.runtimeArguments(), '--network', 'none', '--read-only', '--user', '10001:10001', '--cap-drop', 'ALL',
      '--memory', '512m', '--pids-limit', '32', '--mount', `type=volume,source=${volume},target=/workspace,readonly`,
      '--entrypoint', 'node', LOCAL_WORKER_IMAGE, '-e', WORKSPACE_EXPORT_SCRIPT], { env: pinnedEnvironment(), timeout: 120_000, maxBuffer: 150 * 1024 * 1024, encoding: 'utf8' });
    return JSON.parse(result.stdout) as PortableFile[];
  }
  public close() { return this.lifecycle.close(async () => {
    const results = await Promise.allSettled([...this.active].map(name => this.removeContainer(name)));
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason as unknown);
    if (errors.length) throw new AggregateError(errors, 'Local workers failed to stop');
  }); }

  public running(sessionId: string): Promise<boolean> { return this.lifecycle.run(sessionId, () => this.workerRunning(sessionId)); }
  private async workerRunning(sessionId: string): Promise<boolean> {
    if (!this.endpoint) return false;
    try {
      const data = JSON.parse(await this.command(['inspect', localWorkerNames(this.workspaceId, sessionId).name]))[0];
      const port = data.NetworkSettings?.Ports?.['3211/tcp']?.[0];
      if (!data.State?.Running || port?.HostIp !== '127.0.0.1' || !/^\d+$/.test(port.HostPort)) return false;
      const response = await fetch(`http://127.0.0.1:${port.HostPort}/health`, { signal: AbortSignal.timeout(4000) });
      await response.body?.cancel();
      return response.ok;
    } catch { return false; }
  }
  private async select() {
    if (this.endpoint) return;
    const status = await this.status();
    if (!status.ready || !status.endpoint) throw new Error('Local runtime is unavailable');
    this.adopt(status);
  }
  private adopt(status: LocalRuntimeStatus) {
    this.endpoint = status.endpoint;
    this.platform = status.platform ?? this.platform;
    this.isolation = status.isolation;
  }
  private runtimeArguments() { return this.isolation?.runtime ? ['--runtime', this.isolation.runtime] : []; }
  private async volume(name: string) {
    const names = (await this.command(['volume', 'ls', '--format', '{{.Name}}'])).split('\n');
    if (!names.includes(name)) {
      throw new Error('The saved local workspace volume is missing');
    }
    const data = JSON.parse(await this.command(['volume', 'inspect', name]))[0];
    if (data.Labels?.['rat-things.workspace'] !== this.workspaceId) throw new Error('Local workspace volume ownership does not match');
  }
  private async removeContainer(name: string) {
    const found = await this.command(['container', 'ls', '--all', '--filter', `name=^/${name}$`, '--format', '{{.Names}}']);
    if (!found) { this.active.delete(name); return; }
    if (found !== name) throw new Error('Local worker identity does not match.');
    const data = JSON.parse(await this.command(['inspect', name]))[0];
    if (data.Config?.Labels?.['rat-things.workspace'] !== this.workspaceId) throw new Error('Local worker ownership does not match.');
    await this.command(['rm', '--force', name]);
    this.active.delete(name);
  }
}
