import { spawn } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { NativeBundleVerification, NativeBundleVerifier, NativeCopyLimits } from '../core/native-installation-ports.js';
import type { NativeVerificationFailure } from '../domain/native-release.js';

export const NATIVE_VERIFIER_LIMITS: NativeCopyLimits = Object.freeze({
  entries: 4096, fileBytes: 768 * 1024 * 1024, totalBytes: 2 * 1024 * 1024 * 1024,
  manifestBytes: 128 * 1024, depth: 32, pathBytes: 1024,
});
const limitNames = ['entries', 'fileBytes', 'totalBytes', 'manifestBytes', 'depth', 'pathBytes'] as const;
const executablePaths = Object.freeze([
  'Contents/Helpers/rat-native-worker',
  'Contents/Resources/codex/bin/codex',
  'Contents/Resources/codex/bin/codex-code-mode-host',
  'Contents/Resources/codex/codex-path/rg',
  'Contents/Resources/codex/codex-resources/zsh/bin/zsh',
]);
const stages = new Set(['arguments', 'bounds', 'filesystem', 'manifest', 'bundle-signature', 'executable-signature']);
const reasons = new Set(['unsigned', 'ad_hoc', 'wrong_team', 'wrong_identifier', 'invalid']);
const maximumDeadlineMs = 60_000;

export class LocalNativeBundleVerifier implements NativeBundleVerifier {
  private readonly executable: string;
  private readonly deadlineMs: number;

  /** The signed desktop composition supplies its own verifier, outside every candidate bundle. */
  constructor(input: { readonly trustedExecutable: string; readonly deadlineMs?: number }) {
    if (!absolutePath(input.trustedExecutable)) throw new Error('The runtime verifier requires an absolute trusted executable path');
    const deadline = input.deadlineMs ?? maximumDeadlineMs;
    if (!Number.isSafeInteger(deadline) || deadline < 1) throw new Error('The runtime verifier requires a positive deadline');
    this.executable = input.trustedExecutable;
    this.deadlineMs = Math.min(deadline, maximumDeadlineMs);
  }

  async verify(input: { readonly bundlePath: string; readonly limits: NativeCopyLimits }): Promise<NativeBundleVerification> {
    const limits = boundedLimits(input.limits);
    if (!limits || !absolutePath(input.bundlePath)) return unavailable('Runtime verifier input is invalid');
    let executable: string;
    try {
      executable = await realpath(this.executable);
      const candidate = await realpath(input.bundlePath);
      const info = await lstat(executable);
      if (inside(input.bundlePath, this.executable) || inside(candidate, executable)
        || !info.isFile() || info.nlink !== 1 || (info.mode & 0o111) === 0 || (info.mode & 0o7022) !== 0
        || (info.uid !== 0 && info.uid !== process.getuid?.())) {
        return unavailable('Runtime verifier must be a trusted executable outside the candidate bundle');
      }
    } catch { return unavailable('Runtime verifier or candidate bundle is unavailable'); }
    return runVerifier(executable, ['verify-runtime', input.bundlePath, ...limitNames.map(name => String(limits[name]))], limits, this.deadlineMs);
  }
}

function boundedLimits(value: NativeCopyLimits): NativeCopyLimits | undefined {
  if (limitNames.some(name => !Number.isSafeInteger(value[name]) || value[name] < 1)) return undefined;
  const limits = Object.fromEntries(limitNames.map(name => [name, Math.min(value[name], NATIVE_VERIFIER_LIMITS[name])])) as unknown as NativeCopyLimits;
  return limits.manifestBytes <= limits.fileBytes && limits.fileBytes <= limits.totalBytes ? limits : undefined;
}

function absolutePath(value: string): boolean {
  return isAbsolute(value) && Buffer.byteLength(value) <= 4096 && !/[\\:\u0000-\u001f\u007f]/.test(value)
    && value.split('/').slice(1).every(part => part.length > 0 && part !== '.' && part !== '..');
}

function inside(directory: string, file: string): boolean {
  const path = relative(resolve(directory), resolve(file));
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function unavailable(reason: string): NativeBundleVerification {
  return { kind: 'rejected', failure: { kind: 'verifier_unavailable', reason } };
}

function runVerifier(executable: string, arguments_: string[], limits: NativeCopyLimits, deadlineMs: number): Promise<NativeBundleVerification> {
  const maximumOutputBytes = Math.ceil(limits.manifestBytes / 3) * 4 + 8192;
  return new Promise(resolveResult => {
    let child;
    try {
      child = spawn(executable, arguments_, { cwd: '/', env: {}, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { resolveResult(unavailable('Runtime verifier could not be started')); return; }
    const output: Buffer[] = [];
    let outputBytes = 0;
    let errorBytes = 0;
    let failure: string | undefined;
    const stop = (reason: string): void => {
      failure ??= reason;
      if (child.pid !== undefined) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    };
    const deadline = setTimeout(() => stop('Runtime verification timed out'), deadlineMs);
    child.on('error', () => stop('Runtime verifier could not be started'));
    child.stdout.on('data', (value: Buffer) => {
      if (failure) return;
      outputBytes += value.length;
      if (outputBytes > maximumOutputBytes) stop('Runtime verifier output exceeds its limit');
      else output.push(value);
    });
    child.stderr.on('data', (value: Buffer) => {
      errorBytes += value.length;
      if (errorBytes > 8192) stop('Runtime verifier output exceeds its limit');
    });
    child.once('close', (code, signal) => {
      clearTimeout(deadline);
      if (failure) resolveResult(unavailable(failure));
      else if (signal !== null) resolveResult(unavailable('Runtime verifier stopped unexpectedly'));
      else resolveResult(decodeResult(Buffer.concat(output), code, limits.manifestBytes));
    });
  });
}

function decodeResult(bytes: Buffer, exitCode: number | null, manifestLimit: number): NativeBundleVerification {
  const invalid = (): NativeBundleVerification => unavailable('Runtime verifier returned an invalid response');
  let value: Record<string, unknown>;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const parsed: unknown = JSON.parse(text);
    if (!object(parsed)) return invalid();
    value = parsed;
  } catch { return invalid(); }
  if (value.schemaVersion !== 1) return invalid();
  if (exitCode === 0 && value.kind === 'authenticated') {
    const encoded = value.manifestBase64;
    if (typeof encoded !== 'string' || encoded.length > Math.ceil(manifestLimit / 3) * 4
      || encoded.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
      || !Array.isArray(value.executablePaths) || value.executablePaths.length !== executablePaths.length
      || new Set(value.executablePaths).size !== executablePaths.length
      || value.executablePaths.some(path => !executablePaths.includes(path))) return invalid();
    const manifestBytes = Buffer.from(encoded, 'base64');
    if (manifestBytes.length > manifestLimit || manifestBytes.toString('base64') !== encoded) return invalid();
    return { kind: 'authenticated', manifestBytes, executablePaths: [...executablePaths] };
  }
  if (exitCode !== 1 || value.kind !== 'rejected' || typeof value.stage !== 'string' || !stages.has(value.stage)) return invalid();
  const failure = value.failure;
  if (!object(failure) || failure.kind !== 'signature' || (failure.scope !== 'bundle' && failure.scope !== 'executable')
    || typeof failure.reason !== 'string' || !reasons.has(failure.reason)
    || (failure.osStatus !== undefined && (typeof failure.osStatus !== 'number' || !Number.isInteger(failure.osStatus)
      || failure.osStatus < -2_147_483_648 || failure.osStatus > 2_147_483_647))
    || (failure.scope === 'executable' && (typeof failure.path !== 'string' || !executablePaths.includes(failure.path)))
    || (failure.scope === 'bundle' && failure.path !== undefined)) return invalid();
  return { kind: 'rejected', failure: {
    kind: 'signature', scope: failure.scope, reason: failure.reason as Extract<NativeVerificationFailure, { kind: 'signature' }>['reason'],
    ...(failure.path === undefined ? {} : { path: failure.path as string }),
    ...(failure.osStatus === undefined ? {} : { osStatus: failure.osStatus as number }),
  } };
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
