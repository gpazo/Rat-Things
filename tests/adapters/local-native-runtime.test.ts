import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { LocalNativeRuntime, NativeProbeCleanupUnconfirmedError, type NativeRuntimeSourceProvider } from '../../src/adapters/local-native-runtime.js';
import type { PinnedNativeRelease } from '../../src/core/native-installation-ports.js';
import { decodeAuthenticatedNativeManifest, nativeBundlePath, nativeReleaseId } from '../../src/domain/native-release.js';
import { FixtureMachine, gate, startRequest, supportedHost } from '../simulation/native-runtime-fixtures.js';

const helper = 'Contents/Helpers/rat-native-worker';
const kernel = 'Contents/Resources/linux/Image';
const initrd = 'Contents/Resources/linux/worker-initramfs.gz';
const codex = 'Contents/Resources/codex/bin/codex';
const digest = createHash('sha256').update('fixture').digest('hex');
interface BootConfiguration { kernel: string; initrd: string; disk: string; workspace: string; cpuCount: number; memoryMiB: number }

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'rat-native-source-'));
  const bundlePath = join(directory, 'Runtime.bundle');
  const files = [
    { path: helper, kind: 'host-executable', role: 'vm-helper' },
    { path: codex, kind: 'host-executable', role: 'host-codex' },
    { path: kernel, kind: 'resource' },
    { path: initrd, kind: 'resource' },
  ].map(file => ({ ...file, bytes: 7, sha256: digest }));
  for (const file of files) {
    const path = join(bundlePath, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'fixture');
  }
  const manifest = decodeAuthenticatedNativeManifest({ schemaVersion: 1, version: 'fixture', files, compatibility: {
    hostTarget: 'aarch64-apple-darwin', guestTarget: 'aarch64-unknown-linux-gnu', minimumMacOS: '14.0',
    appProtocol: { minimum: 1, maximum: 1 }, controllerProtocol: { minimum: 1, maximum: 1 }, workerProtocol: 1,
    workspaceFormat: { read: [1], write: 1 }, accountStateFormat: 1, profileSchema: 1,
  } });
  const release: PinnedNativeRelease = { bundlePath, manifest, helperPath: join(bundlePath, helper), hostCodexPath: join(bundlePath, codex),
    id: nativeReleaseId(createHash('sha256').update(JSON.stringify(manifest)).digest('hex')) };
  const development = join(directory, 'development');
  await mkdir(development);
  for (const file of ['rat-native-worker', 'Image', 'worker-initramfs.gz']) await writeFile(join(development, file), 'fixture');
  await writeFile(join(development, 'manifest.json'), JSON.stringify({ helperSha256: digest, kernelSha256: digest, initrdSha256: digest }));
  const machines: FixtureMachine[] = [];
  const onMachine = vi.fn<(machine: FixtureMachine) => void>();
  const launches: { binary: string; configuration: BootConfiguration }[] = [];
  const source = vi.fn<NativeRuntimeSourceProvider>(() => ({ kind: 'trusted-release', release }));
  const hostFacts = vi.fn(async () => supportedHost);
  const runtime = new LocalNativeRuntime(directory, source, { dependencies: { hostFacts, availableDiskBytes: async () => 1024 ** 3,
    machine(binary, path) {
      const configuration = JSON.parse(readFileSync(path, 'utf8')) as BootConfiguration;
      launches.push({ binary, configuration });
      const machine = new FixtureMachine(configuration);
      machines.push(machine); onMachine(machine);
      return machine;
    } } });
  return { directory, development, release, source, runtime, launches, hostFacts, machines, onMachine,
    async close() { await runtime.close(); await rm(directory, { recursive: true, force: true }); } };
}

it('is inert until requested and uses the pinned helper and fixed authenticated payloads', async () => {
  const test = await fixture();
  const request = startRequest();
  try {
    expect(test.source).not.toHaveBeenCalled();
    expect(test.launches).toEqual([]);
    await expect(test.runtime.status()).resolves.toMatchObject({ ready: true, image: `native:${test.release.id}` });
    await test.runtime.start(request, async () => {});
    expect(test.launches).toEqual([{ binary: test.release.helperPath, configuration: expect.objectContaining({
      kernel: join(test.release.bundlePath, kernel), initrd: join(test.release.bundlePath, initrd),
      disk: join(test.directory, 'native-workspaces', request.worker.sessionId, 'workspace.raw'),
      workspace: 'fresh', cpuCount: 1, memoryMiB: 2048,
    }) }]);
    expect((await lstat(test.launches[0]!.configuration.disk)).size).toBe(256 * 1024 ** 2);
    await expect(lstat(join(test.directory, 'native-proof'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await test.close(); }
});

it('passes the full sequential setup budget on create and only root restoration on resume', async () => {
  const test = await fixture();
  const request = startRequest();
  request.worker.launch.hostedConfiguration = { packages: { system: ['git'], npm: ['typescript'], python: ['pytest'] },
    setup_commands: [{ command: 'compile first target' }, { command: 'compile second target' }] };
  try {
    await test.runtime.start(request, async () => {});
    expect(test.machines[0]!.control).toHaveBeenCalledWith(expect.objectContaining({ operation: 'start' }), 3_110_000);
    await test.runtime.stop(request.worker.sessionId);
    await test.runtime.start({ ...request, workspace: { ...request.workspace, kind: 'resume' } }, async () => {});
    expect(test.machines[1]!.control).toHaveBeenCalledWith(expect.objectContaining({ operation: 'start' }), 670_000);
  } finally { await test.close(); }
});

it('refuses an unavailable source before a claim, host query, or workspace allocation', async () => {
  const test = await fixture();
  const claim = vi.fn(async () => {});
  try {
    test.source.mockImplementation(() => { throw new Error('Release is not selected'); });
    await expect(test.runtime.start(startRequest(), claim)).rejects.toThrow('Release is not selected');
    expect(claim).not.toHaveBeenCalled();
    expect(test.hostFacts).not.toHaveBeenCalled();
    expect(test.launches).toEqual([]);
    await expect(lstat(join(test.directory, 'native-workspaces'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await test.close(); }
});

it.each([helper, kernel, initrd])('requires the authenticated inventory entry for %s', async path => {
  const test = await fixture();
  try {
    const manifest = { ...test.release.manifest, files: test.release.manifest.files.filter(file => file.path !== path) };
    test.source.mockReturnValue({ kind: 'trusted-release', release: { ...test.release, manifest } });
    await expect(test.runtime.status()).rejects.toThrow('required runtime payloads');
    expect(test.hostFacts).not.toHaveBeenCalled();
    expect(test.launches).toEqual([]);
  } finally { await test.close(); }
});

it.each([helper, kernel, initrd])('rejects a mismatched payload role for %s', async path => {
  const test = await fixture();
  try {
    const manifest = { ...test.release.manifest, files: test.release.manifest.files.map(file => file.path !== path ? file
      : { ...file, kind: 'host-executable' as const, role: 'host-companion' as const }) };
    test.source.mockReturnValue({ kind: 'trusted-release', release: { ...test.release, manifest } });
    await expect(test.runtime.status()).rejects.toThrow('mismatched roles');
    expect(test.hostFacts).not.toHaveBeenCalled();
  } finally { await test.close(); }
});

it('requires the pinned helper path to identify the VM helper in the authenticated manifest', async () => {
  const test = await fixture();
  try {
    test.source.mockReturnValue({ kind: 'trusted-release', release: { ...test.release, helperPath: test.release.hostCodexPath } });
    await expect(test.runtime.status()).rejects.toThrow('mismatched roles');
    expect(test.hostFacts).not.toHaveBeenCalled();
  } finally { await test.close(); }
});

it.each([kernel, initrd])('does not substitute an inventory entry outside the fixed Linux path for %s', async path => {
  const test = await fixture();
  try {
    const manifest = { ...test.release.manifest, files: test.release.manifest.files.map(file => file.path === path
      ? { ...file, path: nativeBundlePath(path.replace('/linux/', '/')) } : file) };
    test.source.mockReturnValue({ kind: 'trusted-release', release: { ...test.release, manifest } });
    await expect(test.runtime.status()).rejects.toThrow('required runtime payloads');
  } finally { await test.close(); }
});

it.each([helper, kernel, initrd])('verifies %s against the authenticated digest before the claim', async path => {
  const test = await fixture();
  const claim = vi.fn(async () => {});
  try {
    await writeFile(join(test.release.bundlePath, path), 'changed payload');
    await expect(test.runtime.start(startRequest(), claim)).rejects.toThrow('integrity check failed');
    expect(claim).not.toHaveBeenCalled();
    expect(test.hostFacts).not.toHaveBeenCalled();
    expect(test.launches).toEqual([]);
  } finally { await test.close(); }
});

it('carries one resolved image through an awaited claim into boot', async () => {
  const test = await fixture();
  const held = gate();
  const claim = vi.fn(async () => held.promise);
  try {
    const starting = test.runtime.start(startRequest(), claim);
    await vi.waitFor(() => expect(claim).toHaveBeenCalledOnce());
    test.source.mockImplementation(() => { throw new Error('No second source selection'); });
    held.release();
    await expect(starting).resolves.toBe('http://127.0.0.1:3211');
    expect(test.source).toHaveBeenCalledOnce();
    expect(test.launches[0]!.binary).toBe(test.release.helperPath);
  } finally { held.release(); await test.close(); }
});

it('leaves existing proof disks untouched and requires production storage for resume', async () => {
  const test = await fixture();
  const request = startRequest();
  const proofDisk = join(test.directory, 'native-proof', request.worker.sessionId, 'workspace.raw');
  try {
    await mkdir(dirname(proofDisk), { recursive: true });
    await writeFile(proofDisk, 'existing proof workspace');
    await expect(test.runtime.start({ ...request, workspace: { ...request.workspace, kind: 'resume' } }, async () => {})).rejects.toMatchObject({ code: 'ENOENT' });
    expect(test.launches).toEqual([]);
    await expect(lstat(join(test.directory, 'native-workspaces'))).rejects.toMatchObject({ code: 'ENOENT' });
    await test.runtime.start(request, async () => {});
    expect(test.launches[0]!.configuration.disk).toBe(join(test.directory, 'native-workspaces', request.worker.sessionId, 'workspace.raw'));
    expect(await readFile(proofDisk, 'utf8')).toBe('existing proof workspace');
  } finally { await test.close(); }
});

it('normalizes explicitly supplied development assets without treating them as an installed release', async () => {
  const test = await fixture();
  try {
    test.source.mockReturnValue({ kind: 'development-assets', directory: test.development });
    await expect(test.runtime.status()).resolves.toMatchObject({ image: `native-proof:${digest}` });
    await test.runtime.start(startRequest(), async () => {});
    expect(test.launches[0]).toMatchObject({ binary: join(test.development, 'rat-native-worker'), configuration: {
      kernel: join(test.development, 'Image'), initrd: join(test.development, 'worker-initramfs.gz'),
    } });
  } finally { await test.close(); }
});

it('preserves Turn admission without rereading image metadata for the running development worker', async () => {
  const test = await fixture();
  const request = startRequest();
  try {
    test.source.mockReturnValue({ kind: 'development-assets', directory: test.development });
    await test.runtime.start(request, async () => {});
    await rm(join(test.development, 'manifest.json'));
    await expect(test.runtime.admitTurn(request.worker.sessionId)).resolves.toBeUndefined();
    expect(test.launches).toHaveLength(1);
  } finally { await test.close(); }
});

it.each([null, {}, { helperSha256: 'invalid', kernelSha256: digest, initrdSha256: digest }])('rejects invalid development metadata before using the helper', async manifest => {
  const test = await fixture();
  try {
    test.source.mockReturnValue({ kind: 'development-assets', directory: test.development });
    await writeFile(join(test.development, 'manifest.json'), JSON.stringify(manifest));
    await expect(test.runtime.status()).rejects.toThrow('Invalid native development image manifest');
    expect(test.hostFacts).not.toHaveBeenCalled();
    expect(test.launches).toEqual([]);
  } finally { await test.close(); }
});

async function disposable(test: Awaited<ReturnType<typeof fixture>>, signal = new AbortController().signal) {
  const directory = join(test.directory, `probe-${randomUUID()}`);
  await mkdir(directory, { mode: 0o700 });
  return { release: test.release, directory, request: startRequest(`sess_probe${randomUUID().replaceAll('-', '')}`), signal };
}

it('probes an explicit candidate before selection and excludes user workers and snapshots from the shared slot', async () => {
  const test = await fixture();
  const held = gate();
  const entered = gate();
  try {
    const input = await disposable(test);
    test.source.mockImplementation(() => { throw new Error('No ordinary release is selected'); });
    const probing = test.runtime.withDisposableWorker(input, async ({ publicURL }) => { entered.release(); await held.promise; return publicURL; });
    await entered.promise;
    expect(test.source).not.toHaveBeenCalled();
    expect(test.machines[0]!.control.mock.calls.map(([request]) => request.operation)).toEqual(['ping', 'start', 'health']);
    expect(test.launches[0]!.configuration.disk).toBe(join(input.directory, 'workspace.raw'));
    test.source.mockReturnValue({ kind: 'trusted-release', release: test.release });
    await expect(test.runtime.start(startRequest(), async () => {})).rejects.toMatchObject({ decision: { kind: 'wait', code: 'local_capacity' } });
    await expect(test.runtime.snapshot('sess_another')).rejects.toMatchObject({ decision: { kind: 'wait', code: 'local_capacity' } });
    held.release();
    await expect(probing).resolves.toBe('http://127.0.0.1:3211');
    expect(test.machines[0]!.alive()).toBe(false);
    await test.runtime.start(startRequest(), async () => {});
    expect(test.machines.filter(machine => machine.alive())).toHaveLength(1);
    expect((await lstat(join(input.directory, 'workspace.raw'))).size).toBe(256 * 1024 ** 2);
  } finally { held.release(); await test.close(); }
});

it('does not allocate a disposable disk while a user worker holds the slot', async () => {
  const test = await fixture();
  try {
    await test.runtime.start(startRequest(), async () => {});
    const input = await disposable(test);
    await expect(test.runtime.withDisposableWorker(input, async () => {})).rejects.toMatchObject({ decision: { kind: 'wait', code: 'local_capacity' } });
    await expect(lstat(join(input.directory, 'workspace.raw'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(test.machines).toHaveLength(1);
  } finally { await test.close(); }
});

it.each(['start', 'health'])('requires successful %s before allowing a probe command', async operation => {
  const test = await fixture();
  const check = vi.fn(async () => {});
  try {
    test.onMachine.mockImplementation(machine => { machine.beforeControl = async current => { if (current === operation) throw new Error('Registration failed'); }; });
    await expect(test.runtime.withDisposableWorker(await disposable(test), check)).rejects.toThrow();
    expect(check).not.toHaveBeenCalled();
    expect(test.machines[0]!.alive()).toBe(false);
    test.onMachine.mockReset();
    await test.runtime.start(startRequest(), async () => {});
  } finally { await test.close(); }
});

it('waits for confirmed stop after a failed command before releasing its reservation', async () => {
  const test = await fixture();
  const stop = gate();
  try {
    test.onMachine.mockImplementation(machine => { machine.beforeStop = () => stop.promise; });
    const probing = test.runtime.withDisposableWorker(await disposable(test), async () => { throw new Error('Bad marker'); });
    const observed = expect(probing).rejects.toThrow('Bad marker');
    await vi.waitFor(() => expect(test.machines[0]?.stop).toHaveBeenCalledOnce());
    await expect(test.runtime.start(startRequest(), async () => {})).rejects.toMatchObject({ decision: { kind: 'wait', code: 'local_capacity' } });
    stop.release(); await observed;
    expect(test.machines[0]!.alive()).toBe(false);
  } finally { stop.release(); await test.close(); }
});

it('aborts a boot that never reports readiness and reaps the helper', async () => {
  const test = await fixture();
  const abort = new AbortController();
  try {
    test.onMachine.mockImplementation(machine => { Object.defineProperty(machine, 'started', { value: new Promise(() => {}) }); });
    const probing = test.runtime.withDisposableWorker(await disposable(test, abort.signal), async () => {});
    const observed = expect(probing).rejects.toThrow();
    await vi.waitFor(() => expect(test.machines).toHaveLength(1));
    abort.abort(new Error('Probe deadline'));
    await observed;
    expect(test.machines[0]!.alive()).toBe(false);
  } finally { await test.close(); }
});

it('keeps the disposable probe deadline short even when its configuration has a long setup budget', async () => {
  const test = await fixture();
  const entered = gate();
  const setup = gate();
  try {
    const input = await disposable(test);
    input.request.worker.launch.hostedConfiguration = { setup_commands: [{ command: 'long fixture setup' }, { command: 'more fixture setup' }] };
    test.onMachine.mockImplementation(machine => {
      machine.beforeControl = async operation => { if (operation === 'start') { entered.release(); await setup.promise; } };
    });
    vi.useFakeTimers();
    const probing = test.runtime.withDisposableWorker(input, async () => {});
    const observed = expect(probing).rejects.toThrow('cancelled');
    await entered.promise;
    await vi.advanceTimersByTimeAsync(120_000);
    await observed;
    expect(test.machines[0]!.alive()).toBe(false);
  } finally { vi.useRealTimers(); setup.release(); await test.close(); }
});

it('retains admission and rejects an unconfirmed helper exit', async () => {
  const test = await fixture();
  let finish: (() => void) | undefined;
  try {
    test.onMachine.mockImplementation(machine => {
      finish = machine.kill.bind(machine);
      machine.kill = () => {};
      machine.unconfirmedStopError = new Error('Stop did not confirm exit');
    });
    const input = await disposable(test);
    await expect(test.runtime.withDisposableWorker(input, async () => {})).rejects.toBeInstanceOf(NativeProbeCleanupUnconfirmedError);
    expect(test.machines[0]!.alive()).toBe(true);
    expect((await lstat(join(input.directory, 'workspace.raw'))).size).toBe(256 * 1024 ** 2);
    await expect(test.runtime.start(startRequest(), async () => {})).rejects.toMatchObject({ decision: { kind: 'wait', code: 'local_capacity' } });
  } finally { finish?.(); await test.close(); }
}, 10_000);

it('cancels an active disposable command during close and waits for its cleanup', async () => {
  const test = await fixture();
  const entered = gate();
  try {
    const probing = test.runtime.withDisposableWorker(await disposable(test), async ({ signal }) => {
      entered.release();
      await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Command cancelled')), { once: true }));
    });
    const observed = expect(probing).rejects.toThrow('Command cancelled');
    await entered.promise;
    await test.runtime.close(); await observed;
    expect(test.machines[0]!.alive()).toBe(false);
  } finally { await test.close(); }
});

it('does not boot a queued disposable operation after synchronous close', async () => {
  const test = await fixture();
  try {
    const input = await disposable(test);
    const running = test.runtime.withDisposableWorker(input, async () => {});
    const observed = expect(running).rejects.toThrow();
    await test.runtime.close(); await observed;
    expect(test.launches).toEqual([]);
  } finally { await test.close(); }
});

it('retains an unconfirmed host-facts operation at the probe deadline without allocating a disk', async () => {
  const test = await fixture();
  const abort = new AbortController();
  try {
    test.hostFacts.mockImplementation(async () => new Promise(() => {}));
    const input = await disposable(test, abort.signal);
    const probing = test.runtime.withDisposableWorker(input, async () => {});
    const observed = expect(probing).rejects.toBeInstanceOf(NativeProbeCleanupUnconfirmedError);
    await vi.waitFor(() => expect(test.hostFacts).toHaveBeenCalledOnce());
    abort.abort(); await observed;
    expect(test.launches).toEqual([]);
    await expect(lstat(join(input.directory, 'workspace.raw'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await test.close(); }
}, 10_000);
