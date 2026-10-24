import { expect, it, vi } from 'vitest';
import type { PinnedNativeRelease } from '../../src/core/native-installation-ports.js';
import type { NativeDisposableWorkerRequest, NativeDisposableWorker } from '../../src/adapters/local-native-runtime.js';
import { NativeProbeCleanupUnconfirmedError } from '../../src/adapters/local-native-runtime.js';
import { EnvironmentFilesCleanupUnconfirmedError, type codexEnvironmentFiles } from '../../src/adapters/codex-environment-files.js';
import { LocalNativeReleaseProbe } from '../../src/runner/local-native-probe.js';
import { nativeReleaseId } from '../../src/domain/native-release.js';
import { workspaceDigests } from '../../src/domain/workspace-checkpoint.js';

const release: PinnedNativeRelease = { id: nativeReleaseId('a'.repeat(64)), bundlePath: '/signed/Runtime.bundle',
  helperPath: '/signed/Runtime.bundle/Contents/Helpers/rat-native-worker', hostCodexPath: '/signed/Runtime.bundle/Contents/Resources/codex/bin/codex',
  manifest: { schemaVersion: 1, version: 'fixture', files: [], compatibility: {
    hostTarget: 'aarch64-apple-darwin', guestTarget: 'aarch64-unknown-linux-gnu', minimumMacOS: '14.0',
    appProtocol: { minimum: 1, maximum: 1 }, controllerProtocol: { minimum: 1, maximum: 1 }, workerProtocol: 1,
    workspaceFormat: { read: [1], write: 1 }, accountStateFormat: 1, profileSchema: 1,
  } } };

function fixture(deadlineMs = 1000) {
  const events: string[] = [];
  const inputs: NativeDisposableWorkerRequest[] = [];
  const files = vi.fn<typeof codexEnvironmentFiles>(async options => {
    events.push('command');
    if (!Array.isArray(options.operation)) throw new Error('Expected one command batch');
    const write = options.operation[0];
    return [{ path: write.path, size_bytes: 32 }, { data: write.data, size_bytes: 32 }];
  });
  const storage = { recover: vi.fn(async () => {}), dispose: vi.fn(async () => { events.push('dispose'); }) };
  const request = vi.fn<typeof fetch>(async () => new Response('', { status: 403 }));
  const runtime = { async withDisposableWorker<T>(input: NativeDisposableWorkerRequest, check: (worker: NativeDisposableWorker) => Promise<T>): Promise<T> {
    inputs.push(input); events.push('registered');
    try { return await check({ publicURL: 'http://127.0.0.1:43210', signal: input.signal }); }
    finally { events.push('stopped'); }
  } };
  const probe = new LocalNativeReleaseProbe({ runtime, trustedRecoveryExecutable: '/signed/app/recovery', deadlineMs,
    dependencies: { files, request, storage } });
  return { probe, inputs, events, files, storage, request, runtime };
}

it('proves an isolated fixed command round trip before releasing a candidate', async () => {
  const test = fixture();
  await expect(test.probe.run({ release, directory: '/private/probe' })).resolves.toEqual({ kind: 'ready' });
  expect(test.events).toEqual(['registered', 'command', 'stopped', 'dispose']);
  const input = test.inputs[0]!;
  expect(input.release).toBe(release);
  expect(input.request.workspace.identity.setupDigest).toBe(workspaceDigests(input.request.worker.launch).setupDigest);
  expect(input.request.worker.launch).toMatchObject({ environment: { type: 'none' }, input: [] });
  expect(input.request.worker.harnessKey).not.toBe(input.request.worker.executorKey);
  expect(test.request.mock.calls[0]![1]).toMatchObject({ method: 'POST', body: '{}', redirect: 'error', headers: { 'content-type': 'application/json' } });
  expect(test.files).toHaveBeenCalledOnce();
  expect(test.files.mock.calls[0]![0]).toMatchObject({ binary: release.hostCodexPath, temporaryHomeParent: '/private/probe',
    registryURL: 'http://127.0.0.1:43210', environmentId: input.request.worker.environmentId, harnessKey: input.request.worker.harnessKey,
    environment: { PATH: '/signed/Runtime.bundle/Contents/Resources/codex/bin:/signed/Runtime.bundle/Contents/Resources/codex/codex-path:/usr/bin:/bin:/usr/sbin:/sbin' } });
  expect(Object.keys(test.files.mock.calls[0]![0].environment!)).toEqual(['PATH']);
});

it.each([200, 404, 503])('refuses an unauthenticated response of %s without issuing the command', async status => {
  const test = fixture();
  test.request.mockResolvedValue(new Response('', { status }));
  await expect(test.probe.run({ release, directory: '/private/probe' })).resolves.toMatchObject({ kind: 'failed' });
  expect(test.files).not.toHaveBeenCalled();
  expect(test.events).toEqual(['registered', 'stopped', 'dispose']);
});

it('refuses a marker mismatch after confirmed stop and disposal', async () => {
  const test = fixture();
  test.files.mockResolvedValue([{ size_bytes: 32 }, { data: 'wrong', size_bytes: 32 }]);
  await expect(test.probe.run({ release, directory: '/private/probe' })).resolves.toMatchObject({ kind: 'failed' });
  expect(test.events).toEqual(['registered', 'stopped', 'dispose']);
});

it('cancels its command at a finite deadline and waits for cleanup', async () => {
  const test = fixture(20);
  test.files.mockImplementation(async ({ signal }) => new Promise((_resolve, reject) => {
    signal!.addEventListener('abort', () => { test.events.push('command-exited'); reject(new Error('Aborted')); }, { once: true });
  }));
  await expect(test.probe.run({ release, directory: '/private/probe' })).resolves.toMatchObject({ kind: 'failed' });
  expect(test.events).toEqual(['registered', 'command-exited', 'stopped', 'dispose']);
});

it.each([new NativeProbeCleanupUnconfirmedError('Helper alive'), new EnvironmentFilesCleanupUnconfirmedError('Codex alive'),
  new AggregateError([new EnvironmentFilesCleanupUnconfirmedError('Codex alive'), new Error('Stop failed')])])('retains all data when any child exit is unconfirmed', async failure => {
  const test = fixture();
  test.files.mockRejectedValue(failure);
  await expect(test.probe.run({ release, directory: '/private/probe' })).rejects.toBe(failure);
  expect(test.storage.dispose).not.toHaveBeenCalled();
  await expect(test.probe.recover({ directory: '/private/probes' })).rejects.toBe(failure);
  expect(test.storage.recover).not.toHaveBeenCalled();
  await expect(test.probe.close()).rejects.toBe(failure);
});

it('rejects failed disk disposal so the installer retains probe metadata', async () => {
  const test = fixture();
  test.storage.dispose.mockRejectedValue(new Error('Disk locked'));
  await expect(test.probe.run({ release, directory: '/private/probe' })).rejects.toThrow('Disk locked');
});

it('reports unsuccessful orphan recovery without authorizing installer cleanup', async () => {
  const test = fixture();
  test.storage.recover.mockRejectedValue(new Error('Locked disk'));
  await expect(test.probe.recover({ directory: '/private/probes' })).resolves.toMatchObject({ kind: 'failed', failure: { reason: 'recovery' } });
});

it('stops accepted command work before close resolves and rejects any later run', async () => {
  const test = fixture();
  let entered!: () => void;
  const active = new Promise<void>(resolve => { entered = resolve; });
  test.files.mockImplementation(async ({ signal }) => new Promise((_resolve, reject) => {
    entered();
    signal!.addEventListener('abort', () => { test.events.push('command-exited'); reject(new Error('Stopped')); }, { once: true });
  }));
  const running = test.probe.run({ release, directory: '/private/probe' });
  await active;
  await test.probe.close();
  await expect(running).resolves.toMatchObject({ kind: 'failed' });
  expect(test.events).toEqual(['registered', 'command-exited', 'stopped', 'dispose']);
  await expect(test.probe.run({ release, directory: '/private/probe' })).rejects.toThrow('stopping');
});

it('does not start an accepted operation after synchronous close', async () => {
  const test = fixture();
  const running = test.probe.run({ release, directory: '/private/probe' });
  const observed = expect(running).rejects.toThrow('stopping');
  await test.probe.close(); await observed;
  expect(test.inputs).toEqual([]);
});
