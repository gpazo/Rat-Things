import { spawn } from 'node:child_process';
import { lstat, opendir, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { NATIVE_PROBE_LIMITS } from '../domain/native-probe.js';
import { NativeProbeCleanupUnconfirmedError } from './local-native-runtime.js';

const probeName = /^probe-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

export class LocalNativeProbeStorage {
  private readonly executable: string;
  private readonly deadlineMs: number;

  /** The signed app supplies its own trusted helper, outside all candidate bundles and probe metadata. */
  constructor(input: { readonly trustedExecutable: string; readonly deadlineMs?: number }) {
    if (!isAbsolute(input.trustedExecutable) || /[\u0000-\u001f\u007f]/.test(input.trustedExecutable)) throw new Error('Probe recovery requires an absolute trusted helper');
    this.executable = input.trustedExecutable;
    this.deadlineMs = input.deadlineMs ?? 10_000;
    if (!Number.isSafeInteger(this.deadlineMs) || this.deadlineMs < 1 || this.deadlineMs > 30_000) throw new Error('Invalid probe recovery deadline');
  }

  async recover(directory: string): Promise<void> {
    await privateDirectory(directory);
    const names = await boundedNames(directory, NATIVE_PROBE_LIMITS.directories);
    const probes = names.map(name => {
      if (!probeName.test(name)) throw new Error('Unrecognized native probe directory');
      return join(directory, name);
    });
    for (const probe of probes) await inspectNativeProbeDirectory(probe);
    const deadline = performance.now() + this.deadlineMs;
    for (const probe of probes) await this.dispose(probe, undefined, deadline);
  }

  async dispose(directory: string, candidateBundle?: string, deadline = performance.now() + this.deadlineMs): Promise<void> {
    await inspectNativeProbeDirectory(directory);
    const executable = await realpath(this.executable);
    const state = await lstat(executable);
    if (!state.isFile() || state.nlink !== 1 || (state.mode & 0o111) === 0 || (state.mode & 0o7022) !== 0
      || (state.uid !== 0 && state.uid !== process.getuid?.()) || inside(directory, executable)
      || candidateBundle !== undefined && inside(await realpath(candidateBundle), executable)) throw new Error('Probe recovery helper is not trusted');
    while (true) {
      const remaining = Math.ceil(deadline - performance.now());
      if (remaining <= 0) throw new Error('Native probe disk remains locked');
      const status = await disposeDisk(executable, directory, Math.min(remaining, 5000));
      if (status !== 'locked') return;
      await delay(Math.min(50, Math.max(1, deadline - performance.now())));
    }
  }
}

/** A disk is deliberately left to the native inode lock operation, never a generic tree remover. */
export async function inspectNativeProbeDirectory(directory: string): Promise<void> {
  if (!isAbsolute(directory) || !probeName.test(basename(directory))) throw new Error('Invalid native probe directory');
  await privateDirectory(directory);
  const budget = { entries: 0, metadata: 0, logs: 0 };
  const walk = async (path: string, depth: number, kind: 'root' | 'boot' | 'home'): Promise<void> => {
    if (depth > NATIVE_PROBE_LIMITS.depth) throw new Error('Native probe metadata exceeds depth limit');
    const names = await boundedNames(path, NATIVE_PROBE_LIMITS.entries - budget.entries);
    for (const name of names) {
      if (++budget.entries > NATIVE_PROBE_LIMITS.entries || Buffer.byteLength(name) > 255) throw new Error('Native probe metadata exceeds entry limit');
      const file = join(path, name);
      const state = await lstat(file);
      const homeLink = kind === 'home' && state.isSymbolicLink();
      if (state.uid !== process.getuid?.() || (state.isSymbolicLink() ? !homeLink : (state.mode & 0o022) !== 0)) throw new Error('Native probe contains unsafe metadata');
      if (state.isDirectory()) {
        if (kind === 'boot' || kind === 'root' && !/^(?:boot-|rat-environment-files-)[A-Za-z0-9]{6}$/.test(name)) throw new Error('Unrecognized native probe directory');
        await walk(file, depth + 1, kind === 'root' && name.startsWith('boot-') ? 'boot' : 'home');
      } else {
        if ((!state.isFile() && !homeLink) || state.nlink !== 1 || !Number.isSafeInteger(state.size)) throw new Error('Native probe contains an unsafe file');
        if (kind === 'root' && name === 'workspace.raw') {
          if (state.size > NATIVE_PROBE_LIMITS.diskBytes) throw new Error('Native probe disk exceeds limit');
        } else if (kind === 'boot' && name === 'serial.log') {
          budget.logs += state.size;
          if (budget.logs > NATIVE_PROBE_LIMITS.logBytes) throw new Error('Native probe log exceeds limit');
        } else {
          if (kind === 'root' && name !== 'binding.json' || kind === 'boot' && name !== 'boot.json') throw new Error('Unrecognized native probe file');
          budget.metadata += state.size;
          if (budget.metadata > NATIVE_PROBE_LIMITS.metadataBytes) throw new Error('Native probe metadata exceeds limit');
        }
      }
    }
  };
  await walk(directory, 0, 'root');
}

async function privateDirectory(path: string): Promise<void> {
  const state = await lstat(path);
  if (!state.isDirectory() || state.isSymbolicLink() || state.uid !== process.getuid?.() || (state.mode & 0o777) !== 0o700) throw new Error('Native probe directory must be private');
}

async function boundedNames(path: string, limit: number): Promise<string[]> {
  const names: string[] = [];
  const folder = await opendir(path);
  for await (const entry of folder) {
    if (names.length >= limit) throw new Error('Native probe directory exceeds entry limit');
    names.push(entry.name);
  }
  return names.sort();
}

function inside(directory: string, file: string): boolean {
  const path = relative(resolve(directory), resolve(file));
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function disposeDisk(executable: string, directory: string, deadlineMs: number): Promise<'disposed' | 'absent' | 'locked'> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, ['--dispose-probe-disk', directory], { cwd: '/', env: {}, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let errorBytes = 0;
    let failure: Error | undefined;
    let reapDeadline: NodeJS.Timeout | undefined;
    const stop = (error: Error) => {
      failure ??= error;
      child.kill('SIGKILL');
      reapDeadline ??= setTimeout(() => reject(new NativeProbeCleanupUnconfirmedError('Probe recovery helper exit is unconfirmed')), 5000);
    };
    const timer = setTimeout(() => stop(new Error('Probe recovery helper timed out')), deadlineMs);
    child.on('error', () => stop(new Error('Probe recovery helper failed to start')));
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > 4096) stop(new Error('Probe recovery helper output exceeds limit'));
      else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => { errorBytes += chunk.length; if (errorBytes > 4096) stop(new Error('Probe recovery helper output exceeds limit')); });
    child.once('close', (code, signal) => {
      clearTimeout(timer); clearTimeout(reapDeadline);
      if (failure) { reject(failure); return; }
      try {
        const result: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (typeof result !== 'object' || result === null || !('schemaVersion' in result) || result.schemaVersion !== 1 || !('status' in result)
          || signal !== null || !(code === 0 && ['disposed', 'absent'].includes(String(result.status)) || code === 2 && result.status === 'locked')) throw new Error('Invalid probe recovery response');
        resolveResult(result.status as 'disposed' | 'absent' | 'locked');
      } catch { reject(new Error('Native probe disk ownership could not be verified')); }
    });
  });
}
