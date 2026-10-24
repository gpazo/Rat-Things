import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { LocalStartRequest } from '../core/local-runtime-ports.js';
import type { NativeProbeResult, NativeReleaseProbe, PinnedNativeRelease } from '../core/native-installation-ports.js';
import { sessionAgent } from '../core/session-planning.js';
import { workspaceDigests } from '../domain/workspace-checkpoint.js';
import { codexEnvironmentFiles, EnvironmentFilesCleanupUnconfirmedError } from '../adapters/codex-environment-files.js';
import { LocalNativeRuntime, NativeProbeCleanupUnconfirmedError } from '../adapters/local-native-runtime.js';
import { LocalNativeProbeStorage } from '../adapters/local-native-probe-storage.js';

export class LocalNativeReleaseProbe implements NativeReleaseProbe {
  private readonly storage: Pick<LocalNativeProbeStorage, 'recover' | 'dispose'>;
  private readonly files: typeof codexEnvironmentFiles;
  private readonly request: typeof fetch;
  private readonly deadlineMs: number;
  private readonly pending = new Set<Promise<NativeProbeResult>>();
  private readonly controllers = new Set<AbortController>();
  private unconfirmed: unknown;
  private closing: Promise<void> | undefined;

  constructor(private readonly options: {
    readonly runtime: Pick<LocalNativeRuntime, 'withDisposableWorker'>;
    readonly trustedRecoveryExecutable: string;
    readonly deadlineMs?: number;
    readonly dependencies?: {
      readonly storage?: Pick<LocalNativeProbeStorage, 'recover' | 'dispose'>;
      readonly files?: typeof codexEnvironmentFiles;
      readonly request?: typeof fetch;
    };
  }) {
    this.storage = options.dependencies?.storage ?? new LocalNativeProbeStorage({ trustedExecutable: options.trustedRecoveryExecutable });
    this.files = options.dependencies?.files ?? codexEnvironmentFiles;
    this.request = options.dependencies?.request ?? fetch;
    this.deadlineMs = options.deadlineMs ?? 120_000;
    if (!Number.isSafeInteger(this.deadlineMs) || this.deadlineMs < 1 || this.deadlineMs > 120_000) throw new Error('Invalid native probe deadline');
  }

  recover(input: { readonly directory: string }): Promise<NativeProbeResult> {
    return this.operate(() => this.recoverProbe(input));
  }

  private async recoverProbe(input: { readonly directory: string }): Promise<NativeProbeResult> {
    try { await this.storage.recover(input.directory); return { kind: 'ready' }; }
    catch (error) {
      if (cleanupUnconfirmed(error)) throw error;
      return failed('recovery');
    }
  }

  run(input: { readonly release: PinnedNativeRelease; readonly directory: string }): Promise<NativeProbeResult> {
    return this.operate(() => this.runProbe(input));
  }

  private async runProbe(input: { readonly release: PinnedNativeRelease; readonly directory: string }): Promise<NativeProbeResult> {
    const controller = new AbortController();
    this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(new Error('Native release probe timed out')), this.deadlineMs);
    const request = probeRequest();
    let failure: unknown;
    try {
      await this.options.runtime.withDisposableWorker({ ...input, request, signal: controller.signal }, async ({ publicURL, signal }) => {
        const denied = await this.request(`${publicURL}/cloud/environment/${request.worker.environmentId}/connect`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', redirect: 'error', signal,
        });
        await denied.body?.cancel();
        if (denied.status !== 401 && denied.status !== 403) throw new Error('Native probe accepted an unauthenticated harness');
        const marker = randomBytes(32).toString('base64');
        const path = '/workspace/.rat-native-release-probe';
        const result = await this.files({ binary: input.release.hostCodexPath,
          environment: { PATH: [join(input.release.bundlePath, 'Contents/Resources/codex/bin'),
            join(input.release.bundlePath, 'Contents/Resources/codex/codex-path'), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':') },
          temporaryHomeParent: input.directory, registryURL: publicURL, environmentId: request.worker.environmentId,
          harnessKey: request.worker.harnessKey, workspace: '/workspace', signal,
          operation: [{ operation: 'write', path, data: marker }, { operation: 'read', path, offset: 0, length: 32 }],
        });
        signal.throwIfAborted();
        if (!Array.isArray(result) || result.length !== 2 || !record(result[0]) || result[0].path !== path || result[0].size_bytes !== 32
          || !record(result[1]) || result[1].data !== marker || result[1].size_bytes !== 32) throw new Error('Native probe marker did not round trip');
      });
    } catch (error) {
      if (cleanupUnconfirmed(error)) throw error;
      failure = error;
    } finally { clearTimeout(timer); this.controllers.delete(controller); }
    await this.storage.dispose(input.directory, input.release.bundlePath);
    return failure === undefined ? { kind: 'ready' } : failed('failed');
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      for (const controller of this.controllers) controller.abort(new Error('Native release probe is stopping'));
      await Promise.allSettled(this.pending);
      if (this.unconfirmed !== undefined) throw this.unconfirmed;
    })();
    return this.closing;
  }

  private operate(work: () => Promise<NativeProbeResult>): Promise<NativeProbeResult> {
    if (this.closing) return Promise.reject(new Error('Native release probe is stopping'));
    if (this.unconfirmed !== undefined) return Promise.reject(this.unconfirmed);
    const operation = Promise.resolve().then(() => {
      if (this.closing) throw new Error('Native release probe is stopping');
      if (this.unconfirmed !== undefined) throw this.unconfirmed;
      return work();
    }).catch(error => {
      if (cleanupUnconfirmed(error)) this.unconfirmed ??= error;
      throw error;
    });
    this.pending.add(operation);
    void operation.finally(() => this.pending.delete(operation)).catch(() => {});
    return operation;
  }
}

function probeRequest(): LocalStartRequest {
  const sessionId = `sess_probe${randomUUID().replaceAll('-', '')}`;
  const launch = { sessionId, turnId: '', agent: sessionAgent({ model: 'native-release-probe' }, 'agent_nativeprobe', 0),
    environment: { type: 'none' as const }, input: [] };
  return { workspace: { kind: 'create', identity: { version: 1, sessionId, generation: randomUUID(), setupDigest: workspaceDigests(launch).setupDigest } },
    worker: { ownerId: 'native-release-probe', sessionId, environmentId: `env_probe${randomUUID().replaceAll('-', '')}`,
      executorKey: randomBytes(32).toString('base64url'), harnessKey: randomBytes(32).toString('base64url'), launch } };
}

function cleanupUnconfirmed(error: unknown): boolean {
  return error instanceof NativeProbeCleanupUnconfirmedError || error instanceof EnvironmentFilesCleanupUnconfirmedError
    || error instanceof AggregateError && error.errors.some(cleanupUnconfirmed);
}

function failed(reason: 'recovery' | 'failed'): NativeProbeResult {
  return { kind: 'failed', failure: { kind: 'probe', reason,
    detail: reason === 'recovery' ? 'Disposable native workspace ownership could not be confirmed' : 'Disposable native worker readiness failed' } };
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
