import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rm, statfs, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import type { LocalRuntime, LocalStartRequest, LocalWorkerConfiguration } from '../core/local-runtime-ports.js';
import type { PinnedNativeRelease } from '../core/native-installation-ports.js';
import type { LocalRuntimeStatus } from '../domain/local-runtime.js';
import { localWorkspaceIdentity, sameLocalWorkspace, type LocalWorkspaceIdentity, type LocalWorkspaceIntent } from '../domain/local-workspace.js';
import { archiveWorkspace, type PortableFile } from '../domain/workspace-transfer.js';
import { LocalRuntimeLifecycle } from './local-runtime-lifecycle.js';
import { readNativeHostFacts } from './local-native-host.js';
import { LocalRuntimeAdmissionError, nativeAdmission, linuxKvmAdmission, type NativeHostFacts, type NativeResources } from '../domain/local-native-admission.js';
import { localWorkspaceSetupTimeoutMs } from '../domain/local-workspace-setup.js';

export type NativeRuntimeSource =
  | { readonly kind: 'trusted-release'; readonly release: PinnedNativeRelease }
  | { readonly kind: 'development-assets'; readonly directory: string }
  | { readonly kind: 'linux-kvm-development'; readonly directory: string };
export type NativeRuntimeSourceProvider = () => NativeRuntimeSource | Promise<NativeRuntimeSource>;
interface NativeRuntimeFile { readonly path: string; readonly sha256: string }
interface NativeRuntimeImage {
  readonly provenance: NativeRuntimeSource['kind'];
  readonly id: string;
  readonly helper: NativeRuntimeFile;
  readonly kernel: NativeRuntimeFile;
  readonly initrd: NativeRuntimeFile;
  readonly dependencies?: readonly NativeRuntimeFile[];
}
interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
interface BootRecord { sessionId: string; mode: string; controlReadyMs: number; cpuCount: number; memoryMiB: number }
type ControlRequest = { operation: 'ping' | 'health' | 'stop' | 'snapshot' } | { operation: 'start'; configuration: LocalWorkerConfiguration };
interface DiskBinding { identity: LocalWorkspaceIdentity; device: string; inode: string; filesystemUUID: string }
export interface NativeMachine {
  readonly started: Promise<number>;
  readonly exited: Promise<unknown>;
  alive(): boolean;
  control(request: ControlRequest, timeoutMs?: number): Promise<unknown>;
  stop(): Promise<void>;
  kill(): void;
}
export interface NativeRuntimeDependencies {
  hostFacts?(): Promise<NativeHostFacts>;
  availableDiskBytes?(): Promise<number>;
  machine?(binary: string, configuration: string): NativeMachine;
  configuredCapacity?: number;
}
export interface NativeRuntimeOptions {
  readonly cpuCount?: 1;
  readonly developmentStorage?: 'native-proof' | 'linux-kvm-workspaces';
  readonly dependencies?: NativeRuntimeDependencies;
}
type Reservation = { sessionId: string; kind: 'pending'; operation: 'worker' | 'snapshot' | 'probe' } | { sessionId: string; kind: 'running' };
const workspaceBytes = 256 * 1024 ** 2;
const probeStopDeadlineMs = 5000;
export class NativeProbeCleanupUnconfirmedError extends Error {}
export interface NativeDisposableWorkerRequest {
  readonly release: PinnedNativeRelease;
  readonly directory: string;
  readonly request: LocalStartRequest;
  readonly signal: AbortSignal;
}
export interface NativeDisposableWorker {
  readonly publicURL: string;
  readonly signal: AbortSignal;
}

class NativeVM implements NativeMachine {
  readonly child: ChildProcessWithoutNullStreams;
  readonly exited: Promise<number | null>;
  readonly started: Promise<number>;
  readonly pending = new Map<number, Pending>();
  private sequence = 0;
  private buffer = '';

  constructor(binary: string, configuration: string) {
    this.child = spawn(binary, [configuration], { stdio: 'pipe', shell: false });
    let ready: (port: number) => void;
    let failed: (error: Error) => void;
    this.started = new Promise<number>((resolveStart, reject) => { ready = resolveStart; failed = reject; });
    const deadline = setTimeout(() => this.child.kill('SIGKILL'), 30_000);
    this.exited = new Promise(resolveExit => {
      this.child.once('close', code => {
        clearTimeout(deadline);
        failed(new Error('Native VM exited before readiness'));
        for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('Native VM control disconnected')); }
        this.pending.clear();
        resolveExit(code);
      });
    });
    this.child.once('error', error => { clearTimeout(deadline); failed(error); });
    this.child.stdin.on('error', () => { this.child.kill('SIGKILL'); });
    this.child.stderr.resume();
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      if (this.buffer.length > 150 * 1024 ** 2) { this.child.kill('SIGKILL'); return; }
      let newline: number;
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
        try {
          const event = JSON.parse(line) as { status?: string; relayPort?: number; id?: number; error?: string; result?: unknown };
          if (event.status === 'started' && Number.isInteger(event.relayPort) && event.relayPort! > 0 && event.relayPort! <= 65535) {
            clearTimeout(deadline); ready(event.relayPort!);
          } else if (event.status === 'failed' || event.status === 'invalid_configuration') {
            this.child.kill('SIGKILL');
          } else if (event.id !== undefined) {
            const request = this.pending.get(event.id);
            if (!request) continue;
            this.pending.delete(event.id); clearTimeout(request.timer);
            if (event.error) request.reject(new Error(event.error)); else request.resolve(event.result);
          }
        } catch { this.child.kill('SIGKILL'); }
      }
    });
  }

  kill() { this.child.kill('SIGKILL'); }

  alive() { return this.child.exitCode === null && this.child.signalCode === null; }

  control(request: ControlRequest, timeoutMs = 90_000) {
    if (!this.alive()) return Promise.reject(new Error('Native VM is stopped'));
    const id = ++this.sequence;
    const frame = JSON.stringify({ id, ...request, timeoutMs }) + '\n';
    if (Buffer.byteLength(frame) > 8 * 1024 ** 2) return Promise.reject(new Error('Native worker configuration exceeds 8 MiB'));
    return new Promise<unknown>((resolveControl, reject) => {
      const deadline = Date.now() + timeoutMs;
      const expire = () => {
        const pending = this.pending.get(id);
        if (!pending) return;
        const remaining = deadline - Date.now();
        // Large admitted command lists must not overflow Node's 32-bit timer delay.
        if (remaining > 0) { pending.timer = setTimeout(expire, Math.min(remaining, 2_147_483_647)); return; }
        this.pending.delete(id); this.child.kill('SIGKILL'); reject(new Error('Native guest control timed out'));
      };
      const timer = setTimeout(expire, Math.min(timeoutMs, 2_147_483_647));
      this.pending.set(id, { resolve: resolveControl, reject, timer });
      this.child.stdin.write(frame);
    });
  }

  async stop() {
    if (!this.alive()) { await this.exited; return; }
    try {
      await this.control({ operation: 'stop' });
      const deadline = setTimeout(() => this.child.kill('SIGKILL'), 5000);
      try { if (await this.exited !== 0) throw new Error('Native VM did not stop cleanly'); }
      finally { clearTimeout(deadline); }
    } catch (error) {
      this.child.kill('SIGKILL'); await this.exited; throw error;
    }
  }
}

async function hashFile(path: string, signal?: AbortSignal) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
  return hash.digest('hex');
}

function trustedReleaseImage(release: PinnedNativeRelease): NativeRuntimeImage {
  const helper = release.manifest.files.find(file => join(release.bundlePath, file.path) === release.helperPath);
  const kernel = release.manifest.files.find(file => file.path === 'Contents/Resources/linux/Image');
  const initrd = release.manifest.files.find(file => file.path === 'Contents/Resources/linux/worker-initramfs.gz');
  if (helper?.kind !== 'host-executable' || helper.role !== 'vm-helper' || kernel?.kind !== 'resource' || initrd?.kind !== 'resource') {
    throw new Error('Native release is missing the required runtime payloads or has mismatched roles');
  }
  return { provenance: 'trusted-release', id: release.id,
    helper: { path: release.helperPath, sha256: helper.sha256 },
    kernel: { path: join(release.bundlePath, kernel.path), sha256: kernel.sha256 },
    initrd: { path: join(release.bundlePath, initrd.path), sha256: initrd.sha256 } };
}

function developmentImage(directory: string, value: unknown): NativeRuntimeImage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid native development image manifest');
  const manifest = value as Record<string, unknown>;
  const file = (name: string, sha256: unknown): NativeRuntimeFile => {
    if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Invalid native development image manifest');
    return { path: join(directory, name), sha256 };
  };
  const initrd = file('worker-initramfs.gz', manifest.initrdSha256);
  return { provenance: 'development-assets', id: initrd.sha256, initrd,
    kernel: file('Image', manifest.kernelSha256), helper: file('rat-native-worker', manifest.helperSha256) };
}

function linuxDevelopmentImage(directory: string, value: unknown): NativeRuntimeImage {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Linux KVM assets require an x86-64 Linux host');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Linux KVM image manifest');
  const manifest = value as Record<string, unknown>;
  if (manifest.version !== 1 || manifest.target !== 'x86_64-unknown-linux-gnu' || !Array.isArray(manifest.files)
    || manifest.files.length > 20000) throw new Error('Invalid Linux KVM image manifest');
  const file = (name: string, sha256: unknown): NativeRuntimeFile => {
    if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Invalid Linux KVM image digest');
    return { path: join(directory, name), sha256 };
  };
  const paths = new Set<string>();
  const dependencies = manifest.files.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object') throw new Error('Invalid Linux KVM dependency');
    const item = entry as Record<string, unknown>;
    if (typeof item.path !== 'string' || !item.path.startsWith('qemu/') || item.path.length > 4096 || item.path.includes('\\')
      || item.path.includes('\0') || item.path.split('/').some(part => part === '..' || part === '.' || part === '') || paths.has(item.path)) {
      throw new Error('Invalid Linux KVM dependency path');
    }
    paths.add(item.path);
    return file(item.path, item.sha256);
  });
  if (!paths.has('qemu/usr/bin/qemu-system-x86_64')) throw new Error('Linux KVM image has no pinned QEMU executable');
  const initrd = file('worker-initramfs.gz', manifest.initrdSha256);
  return { provenance: 'linux-kvm-development', id: initrd.sha256, initrd,
    kernel: file('Image', manifest.kernelSha256), helper: file('rat-linux-worker', manifest.helperSha256), dependencies };
}

const imageAdmission = (image: Pick<NativeRuntimeImage, 'provenance'>) => image.provenance === 'linux-kvm-development' ? linuxKvmAdmission : nativeAdmission;

async function linuxImageFiles(directory: string): Promise<string[]> {
  if (!(await lstat(directory)).isDirectory()) throw new Error('Linux KVM asset directories cannot be symlinks');
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await linuxImageFiles(path));
    else if (entry.isFile()) files.push(path);
    else throw new Error('Linux KVM assets cannot contain symlinks or special files');
  }
  return files;
}

export class LocalNativeRuntime implements LocalRuntime {
  private readonly machines = new Map<string, NativeMachine>();
  private readonly unallocated = new Set<string>();
  private reservation: Reservation | undefined;
  private readonly exited = new WeakSet<NativeMachine>();
  private readonly lifecycle = new LocalRuntimeLifecycle();
  private readonly probes = new Set<AbortController>();
  private readonly disposable = new WeakSet<NativeMachine>();
  private readonly cpuCount: 1;
  private readonly dependencies: NativeRuntimeDependencies;
  private readonly workspaceRoot: 'native-workspaces' | 'native-proof' | 'linux-kvm-workspaces';
  readonly boots: BootRecord[] = [];
  constructor(private readonly directory: string, private readonly source: NativeRuntimeSourceProvider, options: NativeRuntimeOptions = {}) {
    this.cpuCount = options.cpuCount ?? 1;
    this.dependencies = options.dependencies ?? {};
    this.workspaceRoot = options.developmentStorage ?? 'native-workspaces';
  }

  async status(): Promise<LocalRuntimeStatus> {
    const image = await this.verifyImage();
    const admission = imageAdmission(image)({ ...await this.capacityFacts(image.helper.path), requestedCPUCount: this.cpuCount,
      slotAvailable: this.reservation === undefined, requiredDiskBytes: workspaceBytes });
    return { ready: admission.kind !== 'unsupported', engine: 'unknown', platform: image.provenance === 'linux-kvm-development' ? 'linux/amd64' : 'linux/arm64',
      image: `${image.provenance === 'trusted-release' ? 'native' : image.provenance === 'linux-kvm-development' ? 'linux-kvm-development' : 'native-proof'}:${image.id}`,
      native: { configuredCapacity: this.dependencies.configuredCapacity ?? 1, effectiveCapacity: admission.effectiveCapacity,
        occupied: this.reservation !== undefined, admission },
      checks: [{ id: 'image', ready: true, message: image.provenance === 'trusted-release' ? 'Verified native runtime image' : image.provenance === 'linux-kvm-development' ? 'Locally built Linux KVM development image. File integrity checked.' : 'Verified opt-in native worker proof image' },
        { id: 'host', ready: admission.kind !== 'unsupported', message: admission.kind === 'unsupported' ? admission.message : 'One native VM, one CPU and 2 GiB of guest memory.' }] };
  }

  private async image(): Promise<NativeRuntimeImage> {
    const source = await this.source();
    if (source.kind === 'trusted-release') return trustedReleaseImage(source.release);
    const manifest = JSON.parse(await readFile(join(source.directory, 'manifest.json'), 'utf8'));
    return source.kind === 'linux-kvm-development' ? linuxDevelopmentImage(source.directory, manifest) : developmentImage(source.directory, manifest);
  }

  private async verifyImage(candidate?: NativeRuntimeImage, signal?: AbortSignal) {
    const image = candidate ?? await this.image();
    if (image.provenance === 'linux-kvm-development') {
      const declared = image.dependencies!.map(file => file.path).sort();
      const actual = (await linuxImageFiles(join(dirname(image.helper.path), 'qemu'))).sort();
      if (JSON.stringify(actual) !== JSON.stringify(declared)) throw new Error('Linux KVM dependency inventory has missing or unlisted files');
      const kernel = await open(image.kernel.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const bytes = Buffer.alloc(0x238);
        const read = await kernel.read(bytes, 0, bytes.length, 0);
        if (read.bytesRead !== bytes.length || bytes.readUInt16LE(0x1fe) !== 0xaa55 || bytes.toString('ascii', 0x202, 0x206) !== 'HdrS'
          || !(bytes.readUInt16LE(0x236) & 1)) throw new Error('Linux KVM requires an x86-64 Linux boot image');
      } finally { await kernel.close(); }
    }
    for (const file of [image.initrd, image.kernel, image.helper, ...image.dependencies ?? []]) {
      if (image.provenance === 'linux-kvm-development') {
        const state = await lstat(file.path);
        if (!state.isFile() || state.mode & 0o022) throw new Error('Linux KVM assets must be regular files without group or other write permission');
      }
      if (await hashFile(file.path, signal) !== file.sha256) throw new Error('Native runtime image integrity check failed');
    }
    return image;
  }

  private async capacityFacts(helper: string) {
    const [facts, availableDiskBytes] = await Promise.all([
      this.dependencies.hostFacts?.() ?? readNativeHostFacts(helper),
      this.dependencies.availableDiskBytes?.() ?? statfs(this.directory, { bigint: true }).then(filesystem => {
        const available = filesystem.bavail * filesystem.bsize;
        return Number(available > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : available);
      }),
    ]);
    return { facts, availableDiskBytes };
  }

  private async reserve(sessionId: string, operation: 'worker' | 'snapshot' | 'probe', candidate?: NativeRuntimeImage, signal?: AbortSignal) {
    const image = await this.verifyImage(candidate, signal);
    const reading = this.capacityFacts(image.helper.path);
    const facts = await (signal ? cancelledCheck(reading, signal) : reading);
    signal?.throwIfAborted();
    const requiredDiskBytes = workspaceBytes + (image.provenance === 'linux-kvm-development' ? (await lstat(image.initrd.path)).size + 1024 ** 2 : 0);
    const admission = imageAdmission(image)({ ...facts, requestedCPUCount: this.cpuCount, requiredDiskBytes,
      existingAllocation: this.machines.get(sessionId)?.alive() === true,
      slotAvailable: !this.reservation || this.reservation.sessionId === sessionId && this.reservation.kind === 'running' });
    if (admission.kind !== 'admitted') throw new LocalRuntimeAdmissionError(admission);
    this.reservation = { sessionId, kind: 'pending', operation };
    return { image, resources: admission.resources };
  }

  private releaseOperation(sessionId: string) {
    if (this.reservation?.sessionId !== sessionId) return;
    this.reservation = this.machines.has(sessionId) ? { sessionId, kind: 'running' } : undefined;
  }

  setup(): Promise<LocalRuntimeStatus> { return this.lifecycle.run('native-readiness', () => this.probe()); }
  private async probe(): Promise<LocalRuntimeStatus> {
    const sessionId = `sess_probe${randomUUID().replaceAll('-', '')}`;
    const { image, resources } = await this.reserve(sessionId, 'probe');
    const identity: LocalWorkspaceIdentity = { version: 1, sessionId, generation: randomUUID(), setupDigest: '0'.repeat(64) };
    try {
      const binding = await this.diskBinding(sessionId, { kind: 'create', identity });
      await this.boot(sessionId, 'fresh', binding, resources, image);
    } finally {
      try { await this.stopWorker(sessionId); }
      finally {
        this.releaseOperation(sessionId);
        if (!this.machines.has(sessionId)) await rm(this.workspaceDirectory(sessionId), { recursive: true, force: true });
      }
    }
    return this.status();
  }

  private workspaceDirectory(sessionId: string) {
    if (!/^sess_[a-zA-Z0-9]+$/.test(sessionId)) throw new Error('Invalid Session identity');
    return join(this.directory, this.workspaceRoot, sessionId);
  }

  private async diskBinding(sessionId: string, intent?: LocalWorkspaceIntent, directory = this.workspaceDirectory(sessionId)): Promise<DiskBinding> {
    const disk = join(directory, 'workspace.raw');
    const path = join(directory, 'binding.json');
    if (intent?.kind === 'create') {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const folderState = await lstat(directory);
      if (!folderState.isDirectory() || folderState.isSymbolicLink()) throw new Error('Invalid native workspace directory');
      const previous = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
      if (previous) throw new Error('Native workspace binding already exists');
      const file = await open(disk, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      let binding: DiskBinding;
      try {
        await file.truncate(workspaceBytes); await file.sync();
        const state = await file.stat({ bigint: true });
        binding = { identity: intent.identity, device: String(state.dev), inode: String(state.ino), filesystemUUID: randomUUID() };
      } finally { await file.close(); }
      const receipt = await open(path, 'wx', 0o600);
      try { await receipt.writeFile(JSON.stringify(binding)); await receipt.sync(); } finally { await receipt.close(); }
      const folder = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await folder.sync(); } finally { await folder.close(); }
      return binding;
    }
    const folderState = await lstat(directory);
    if (!folderState.isDirectory() || folderState.isSymbolicLink()) throw new Error('Invalid native workspace directory');
    const receipt = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let binding: DiskBinding;
    try {
      const state = await receipt.stat();
      if (!state.isFile() || state.size > 4096 || state.nlink !== 1) throw new Error('Invalid native workspace binding');
      binding = JSON.parse(await receipt.readFile('utf8')) as DiskBinding;
    } finally { await receipt.close(); }
    const identity = localWorkspaceIdentity(binding.identity);
    if (identity.sessionId !== sessionId || intent && !sameLocalWorkspace(identity, intent.identity)
      || typeof binding.filesystemUUID !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(binding.filesystemUUID)) throw new Error('Native workspace binding does not match');
    const file = await open(disk, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const state = await file.stat({ bigint: true });
      if (!state.isFile() || state.nlink !== 1n || String(state.dev) !== binding.device || String(state.ino) !== binding.inode) throw new Error('Native workspace disk was replaced');
    } finally { await file.close(); }
    return binding;
  }

  private async boot(sessionId: string, mode: 'fresh' | 'existing' | 'readonly', binding: DiskBinding, allocation: NativeResources, image: NativeRuntimeImage, directory = this.workspaceDirectory(sessionId), signal?: AbortSignal) {
    const disk = join(directory, 'workspace.raw');
    const run = await mkdtemp(join(directory, 'boot-'));
    const serialLog = join(run, 'serial.log');
    const configuration = join(run, 'boot.json');
    const resources = { cpuCount: allocation.cpuCount, memoryMiB: allocation.memoryMiB };
    await writeFile(serialLog, '', { mode: 0o600 });
    await writeFile(configuration, JSON.stringify({ kernel: image.kernel.path, initrd: image.initrd.path, disk,
      serialLog, workspace: mode, device: binding.device, inode: binding.inode, filesystemUUID: binding.filesystemUUID, ...resources }), { mode: 0o600 });
    signal?.throwIfAborted();
    const start = performance.now();
    const binary = image.helper.path;
    const vm = this.dependencies.machine?.(binary, configuration) ?? new NativeVM(binary, configuration);
    const deadline = setTimeout(() => vm.kill(), 60_000);
    this.machines.set(sessionId, vm);
    if (signal) this.disposable.add(vm);
    void vm.exited.then(() => {
      this.exited.add(vm);
      if (this.machines.get(sessionId) === vm) this.machines.delete(sessionId);
      if (this.reservation?.kind === 'running' && this.reservation.sessionId === sessionId) this.reservation = undefined;
    });
    try {
      const port = await interrupted(vm.started, signal);
      let connected = false;
      for (let attempt = 0; attempt < 150; attempt++) {
        try { await interrupted(vm.control({ operation: 'ping' }), signal); connected = true; break; }
        catch { signal?.throwIfAborted(); if (!vm.alive()) throw new Error(`Native guest stopped. Inspect ${serialLog}`); await delay(200); }
      }
      if (!connected) throw new Error(`Native guest boot timed out. Inspect ${serialLog}`);
      this.boots.push({ sessionId, mode, controlReadyMs: Math.round(performance.now() - start), ...resources });
      return { vm, publicURL: `http://127.0.0.1:${port}` };
    } catch (error) {
      vm.kill();
      if (signal) await confirmedExit(vm); else await vm.exited;
      if (this.machines.get(sessionId) === vm) this.machines.delete(sessionId);
      throw error;
    } finally { clearTimeout(deadline); }
  }

  withDisposableWorker<T>(input: NativeDisposableWorkerRequest, check: (worker: NativeDisposableWorker) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const abort = () => controller.abort(new Error('Native release probe was cancelled'));
    input.signal.addEventListener('abort', abort, { once: true });
    if (input.signal.aborted) abort();
    this.probes.add(controller);
    const operation = this.lifecycle.run('native-release-probe', async () => {
      const deadline = setTimeout(abort, 120_000);
      const sessionId = input.request.worker.sessionId;
      let operationError: unknown;
      try {
        controller.signal.throwIfAborted();
        if (!isAbsolute(input.directory) || !/^probe-[a-f0-9-]{36}$/.test(basename(input.directory))) throw new Error('Invalid disposable native directory');
        const state = await lstat(input.directory);
        if (!state.isDirectory() || state.isSymbolicLink() || state.uid !== process.getuid?.() || (state.mode & 0o777) !== 0o700) throw new Error('Disposable native directory must be private');
        const identity = localWorkspaceIdentity(input.request.workspace.identity);
        if (input.request.workspace.kind !== 'create' || identity.sessionId !== sessionId || !/^sess_probe[a-f0-9]{32}$/.test(sessionId)) throw new Error('Invalid disposable native identity');
        const { image, resources } = await this.reserve(sessionId, 'probe', trustedReleaseImage(input.release), controller.signal);
        controller.signal.throwIfAborted();
        const binding = await this.diskBinding(sessionId, input.request.workspace, input.directory);
        controller.signal.throwIfAborted();
        const { vm, publicURL } = await this.boot(sessionId, 'fresh', binding, resources, image, input.directory, controller.signal);
        const kill = () => vm.kill();
        controller.signal.addEventListener('abort', kill, { once: true });
        try {
          const configuration = { ...input.request.worker, workspace: input.request.workspace, publicURL };
          const registration = await interrupted(vm.control({ operation: 'start', configuration }), controller.signal);
          if (!ready(registration) || !vm.alive()) throw new Error('Native probe worker registration failed');
          const health = await interrupted(vm.control({ operation: 'health' }, 5000), controller.signal);
          if (!ready(health) || !vm.alive()) throw new Error('Native probe executor is unavailable');
          return await cancelledCheck(check({ publicURL, signal: controller.signal }), controller.signal);
        } finally { controller.signal.removeEventListener('abort', kill); }
      } catch (error) { operationError = error; throw error; } finally {
        clearTimeout(deadline);
        try { await this.stopProbeWorker(sessionId); }
        catch (error) { throw operationError === undefined ? error : new AggregateError([operationError, error], 'Native probe and cleanup failed'); }
        finally { this.releaseOperation(sessionId); }
      }
    });
    return operation.finally(() => { input.signal.removeEventListener('abort', abort); this.probes.delete(controller); });
  }

  private async stopProbeWorker(sessionId: string): Promise<void> {
    const vm = this.machines.get(sessionId);
    if (!vm) return;
    try {
      await bounded(vm.stop(), probeStopDeadlineMs, () => new Error('Native probe stop timed out'));
    } catch (error) {
      vm.kill();
      await confirmedExit(vm);
      throw error;
    }
    await confirmedExit(vm);
  }

  start(request: LocalStartRequest, commitWorkspaceClaim: () => Promise<void>) { return this.lifecycle.run(request.worker.sessionId, () => this.startWorker(request, commitWorkspaceClaim)); }

  private async startWorker(request: LocalStartRequest, commitWorkspaceClaim: () => Promise<void>) {
    const sessionId = request.worker.sessionId;
    if (localWorkspaceIdentity(request.workspace.identity).sessionId !== sessionId) throw new Error('Workspace claim does not match Session');
    this.workspaceDirectory(sessionId);
    this.unallocated.delete(sessionId);
    const { image, resources } = await this.reserve(sessionId, 'worker').catch(async error => {
      // Only a rejected fresh reservation proves that this runtime never called
      // the durable claim or allocated storage. Absence after restart proves neither.
      if (request.workspace.kind === 'create' && !this.machines.has(sessionId) && await this.workspaceAbsent(sessionId)) {
        this.unallocated.add(sessionId);
      }
      throw error;
    });
    try {
      await commitWorkspaceClaim();
      const binding = await this.diskBinding(sessionId, request.workspace);
      await this.stopWorker(sessionId);
      const { vm, publicURL } = await this.boot(sessionId, request.workspace.kind === 'create' ? 'fresh' : 'existing', binding, resources, image);
      try {
        const input = { ...request.worker, workspace: request.workspace, publicURL };
        await vm.control({ operation: 'start', configuration: input },
          localWorkspaceSetupTimeoutMs(input.launch.hostedConfiguration, request.workspace.kind));
        if (!vm.alive()) throw new Error('Native worker stopped during registration');
        return publicURL;
      } catch (error) { await this.stopWorker(sessionId); throw error; }
    } finally { this.releaseOperation(sessionId); }
  }

  admitTurn(sessionId: string): Promise<void> { return this.lifecycle.run(sessionId, async () => {
    const source = await this.source();
    const helper = source.kind === 'trusted-release' ? source.release.helperPath : join(source.directory, source.kind === 'linux-kvm-development' ? 'rat-linux-worker' : 'rat-native-worker');
    const facts = await this.capacityFacts(helper);
    const admission = imageAdmission({ provenance: source.kind })({ ...facts, requestedCPUCount: this.cpuCount, requiredDiskBytes: 0, existingAllocation: true,
      slotAvailable: this.reservation?.sessionId === sessionId && this.reservation.kind === 'running' });
    if (admission.kind !== 'admitted') throw new LocalRuntimeAdmissionError(admission);
    if (!await this.workerRunning(sessionId)) throw new Error('The isolated native worker is unavailable');
  }); }

  stop(sessionId: string) { return this.lifecycle.run(sessionId, async () => {
    if (this.machines.has(sessionId)) await this.stopWorker(sessionId);
    else await this.confirmColdStop(sessionId);
  }); }
  private async confirmColdStop(sessionId: string) {
    if (this.unallocated.has(sessionId)) {
      if (await this.workspaceAbsent(sessionId)) return;
      this.unallocated.delete(sessionId);
    }
    const source = await this.source();
    if (source.kind !== 'linux-kvm-development') return;
    const image = await this.verifyImage();
    const binding = await this.diskBinding(sessionId);
    const disk = join(this.workspaceDirectory(sessionId), 'workspace.raw');
    const configuration = JSON.stringify({ disk, device: binding.device, inode: binding.inode, filesystemUUID: binding.filesystemUUID });
    const deadline = Date.now() + 3000;
    for (;;) {
      const result = await promisify(execFile)(image.helper.path, ['--workspace-idle', configuration], { env: {}, timeout: 1000, maxBuffer: 4096, encoding: 'utf8' });
      const state = JSON.parse(result.stdout) as { stopped?: unknown };
      if (state.stopped === true) return;
      if (state.stopped !== false || Date.now() >= deadline) throw new Error('Native predecessor cleanup could not be confirmed');
      await delay(100);
    }
  }
  private async workspaceAbsent(sessionId: string): Promise<boolean> {
    const workspace = this.workspaceDirectory(sessionId);
    try {
      const root = await lstat(join(this.directory, this.workspaceRoot));
      if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Invalid native workspace root');
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
    try { await lstat(workspace); return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
  }
  private async stopWorker(sessionId: string) {
    const vm = this.machines.get(sessionId);
    if (!vm) return;
    try { await vm.stop(); await vm.exited; }
    finally {
      if (this.exited.has(vm)) {
        if (this.machines.get(sessionId) === vm) this.machines.delete(sessionId);
        if (this.reservation?.kind === 'running' && this.reservation.sessionId === sessionId) this.reservation = undefined;
      }
    }
  }

  running(sessionId: string) { return this.lifecycle.run(sessionId, () => this.workerRunning(sessionId)); }
  private async workerRunning(sessionId: string) {
    const vm = this.machines.get(sessionId);
    if (!vm?.alive()) return false;
    try { return ready(await vm.control({ operation: 'health' }, 5000)) && vm.alive(); }
    catch { return false; }
  }

  snapshot(sessionId: string): Promise<PortableFile[]> { return this.lifecycle.run(sessionId, () => this.snapshotWorker(sessionId)); }
  private async snapshotWorker(sessionId: string): Promise<PortableFile[]> {
    this.workspaceDirectory(sessionId);
    const { image, resources } = await this.reserve(sessionId, 'snapshot');
    try {
      const binding = await this.diskBinding(sessionId);
      await this.stopWorker(sessionId);
      const { vm } = await this.boot(sessionId, 'readonly', binding, resources, image);
      try {
        const files = await vm.control({ operation: 'snapshot' }) as PortableFile[];
        archiveWorkspace(files);
        return files;
      } finally { await this.stopWorker(sessionId); }
    } finally { this.releaseOperation(sessionId); }
  }

  close() {
    for (const probe of this.probes) probe.abort(new Error('Local runtime is shutting down'));
    return this.lifecycle.close(async () => {
      const results = await Promise.allSettled([...this.machines].map(([sessionId, vm]) => this.disposable.has(vm) ? this.stopProbeWorker(sessionId) : this.stopWorker(sessionId)));
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason as unknown);
      if (errors.length) throw new AggregateError(errors, 'Native workers failed to stop cleanly');
    });
  }
}

function ready(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'ready' in value && value.ready === true;
}

async function confirmedExit(vm: NativeMachine): Promise<void> {
  await bounded(vm.exited, probeStopDeadlineMs, () => new NativeProbeCleanupUnconfirmedError('Native probe helper exit is unconfirmed'));
}

function bounded<T>(work: Promise<T>, milliseconds: number, error: () => Error): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(error()), milliseconds);
    void work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function interrupted<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason as unknown);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function cancelledCheck<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const abort = () => { timer ??= setTimeout(() => reject(new NativeProbeCleanupUnconfirmedError('Native probe command cleanup is unconfirmed')), probeStopDeadlineMs); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    void work.then(resolve, reject).finally(() => { clearTimeout(timer); signal.removeEventListener('abort', abort); });
  });
}
