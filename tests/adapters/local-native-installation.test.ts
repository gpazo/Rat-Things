import { execFile } from 'node:child_process';
import { chmod, link, lstat, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalNativeInstallation, nativeAppSourceAncestorAllowed } from '../../src/adapters/local-native-installation.js';
import type { NativeBundleVerifier, NativeInstallCheckpoint, NativeProbeResult } from '../../src/core/native-installation-ports.js';
import { NATIVE_MANIFEST_PATH, type NativeInstallationFailure } from '../../src/domain/native-release.js';
import { fixtureBundle, fixtureHome, fixtureInstallation, fixtureLease, fixtureLimits, fixtureProbeWithoutVM,
  fixtureVerifierWithoutSignatures, makeFixtureWritable, removeInstallationFixture } from '../fixtures/native-installation.js';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await removeInstallationFixture(directory);
  }
});

async function home() { const value = await fixtureHome(); directories.push(value.directory); return value; }
async function startAndInstall(installation: LocalNativeInstallation) {
  expect((await installation.startup()).change.kind).not.toBe('failed');
  const result = await installation.setup();
  expect(result.change).toEqual({ kind: 'none' });
  expect(result.selected).not.toBeNull();
  return result;
}
function failure(result: Awaited<ReturnType<LocalNativeInstallation['setup']>>): NativeInstallationFailure {
  expect(result.change.kind).toBe('failed');
  if (result.change.kind !== 'failed') throw new Error('Expected failure');
  return result.change.failure;
}
async function runCrash(profile: string, bundle: string, checkpoint: NativeInstallCheckpoint, action = 'setup') {
  await expect(promisify(execFile)(process.execPath, ['--import', 'tsx', resolve('tests/fixtures/native-installation-crash.ts'), profile, bundle, checkpoint, action],
    { cwd: process.cwd() })).rejects.toMatchObject({ code: 73 });
}

describe('lease-owned native installation with unsigned fixtures', () => {
  it('removes orphan Codex home links without following their external targets', async () => {
    const { directory, profile } = await home(); const bundle = await fixtureBundle(directory, 'orphan-home');
    await fixtureInstallation(profile, bundle.bundle).startup();
    const probe = join(profile, 'runtime/probes/probe-00000000-0000-0000-0000-000000000000');
    const aliases = join(probe, 'rat-environment-files-Ab1234/tmp/arg0/codex-arg0ABCDEF');
    await mkdir(aliases, { recursive: true, mode: 0o700 });
    const sentinel = join(directory, 'outside-sentinel');
    await writeFile(sentinel, 'preserve', { mode: 0o600 });
    await symlink(sentinel, join(aliases, 'apply_patch'));
    await symlink(directory, join(aliases, 'applypatch'));
    await symlink('/absent/fixture', join(aliases, 'codex-execve-wrapper'));
    const result = await fixtureInstallation(profile, bundle.bundle).startup();
    expect(result.change.kind).not.toBe('failed');
    expect(await readdir(join(profile, 'runtime/probes'))).toEqual([]);
    expect(await readFile(sentinel, 'utf8')).toBe('preserve');
    expect(await stat(directory)).toBeDefined();
  });

  it('admits only the standard root-owned admin-writable Applications source ancestor', async () => {
    const applications = { uid: 0, gid: 80, mode: 0o40775 };
    expect(nativeAppSourceAncestorAllowed('/Applications', applications)).toBe(true);
    expect(nativeAppSourceAncestorAllowed('/Applications/Other', applications)).toBe(false);
    expect(nativeAppSourceAncestorAllowed('/Applications', { ...applications, uid: 501 })).toBe(false);
    expect(nativeAppSourceAncestorAllowed('/Applications', { ...applications, gid: 20 })).toBe(false);
    expect(nativeAppSourceAncestorAllowed('/Applications', { ...applications, mode: 0o40777 })).toBe(false);
    if (process.platform === 'darwin') {
      const real = await lstat('/Applications');
      if ((real.mode & 0o7777) === 0o775 && real.uid === 0 && real.gid === 80) {
        expect(nativeAppSourceAncestorAllowed('/Applications', real)).toBe(true);
        const { directory } = await home(); const a = await fixtureBundle(directory, 'a');
        const profileAttempt = await fixtureInstallation('/Applications', a.bundle).startup();
        expect(failure(profileAttempt)).toMatchObject({ kind: 'filesystem', reason: 'Unsafe directory ancestry' });
      }
    }
  });

  it('publishes one immutable version, reuses it, and leaves profile data outside versions', async () => {
    const { directory, profile } = await home(); const a = await fixtureBundle(directory, 'a');
    await mkdir(join(profile, 'sessions')); await mkdir(join(profile, 'codex'));
    await writeFile(join(profile, 'sessions/workspace.raw'), 'unchanged Session disk');
    await writeFile(join(profile, 'codex/account.json'), 'host-only fixture');
    await writeFile(join(profile, 'agents.sqlite'), 'unopened fixture');
    const before = await stat(join(profile, 'sessions/workspace.raw'));
    const verifier = { verify: vi.fn(fixtureVerifierWithoutSignatures.verify) };
    const installation = fixtureInstallation(profile, a.bundle, { verifier });
    const first = await startAndInstall(installation);
    expect(first.selection).toEqual({ schemaVersion: 1, generation: 2, active: a.id, previous: null, pending: null });
    expect(first.selected?.bundlePath).toBe(join(profile, 'runtime/versions', a.id, 'Runtime.bundle'));
    expect(await readdir(join(profile, 'runtime/versions'))).toEqual([a.id]);
    expect((await stat(first.selected!.hostCodexPath)).mode & 0o777).toBe(0o555);
    expect((await stat(join(first.selected!.bundlePath, NATIVE_MANIFEST_PATH))).mode & 0o777).toBe(0o444);
    const again = await installation.setup();
    expect(again.selection).toEqual(first.selection); expect(again.selected).toBe(first.selected);
    await rm(a.bundle, { recursive: true });
    const restarted = await fixtureInstallation(profile, a.bundle, { verifier }).startup();
    expect(restarted.selected?.id).toBe(a.id);
    expect(restarted.selection).toEqual(first.selection);
    expect(verifier.verify.mock.calls.some(([input]) => input.bundlePath.includes('/versions/'))).toBe(true);
    const after = await stat(join(profile, 'sessions/workspace.raw'));
    expect([after.dev, after.ino, await readFile(join(profile, 'sessions/workspace.raw'), 'utf8')]).toEqual([before.dev, before.ino, 'unchanged Session disk']);
    expect(await readFile(join(profile, 'codex/account.json'), 'utf8')).toBe('host-only fixture');
    expect(await readFile(join(profile, 'agents.sqlite'), 'utf8')).toBe('unopened fixture');
  });

  it('stages an update without switching the pin, then activates and rolls back only at startup', async () => {
    const { directory, profile } = await home(); const a = await fixtureBundle(directory, 'a'); const b = await fixtureBundle(directory, 'b');
    const workspace = join(profile, 'native-workspaces/sess_fixture');
    await mkdir(workspace, { recursive: true }); await writeFile(join(workspace, 'workspace.raw'), 'persistent fixture bytes');
    await writeFile(join(workspace, 'binding.json'), 'persistent fixture binding');
    const disk = await stat(join(workspace, 'workspace.raw'));
    await startAndInstall(fixtureInstallation(profile, a.bundle));
    const probes = vi.fn(fixtureProbeWithoutVM.run);
    const updating = fixtureInstallation(profile, b.bundle, { probe: { ...fixtureProbeWithoutVM, run: probes } });
    const prior = await updating.startup(); expect(prior.selected?.id).toBe(a.id);
    const staged = await updating.setup();
    expect(staged.change).toEqual({ kind: 'awaiting_restart', release: b.id });
    expect(staged.selected).toBe(prior.selected); expect(probes).not.toHaveBeenCalled();
    expect((await updating.setup()).selection).toEqual(staged.selection);
    expect((await updating.startup()).selected).toBe(prior.selected);
    const next = fixtureInstallation(profile, b.bundle, { probe: { ...fixtureProbeWithoutVM, run: probes } });
    const active = await next.startup();
    expect(active.selection).toEqual({ schemaVersion: 1, generation: 4, active: b.id, previous: a.id, pending: null });
    expect(active.selected?.id).toBe(b.id); expect(probes).toHaveBeenCalledOnce();
    const rollback = await next.rollback();
    expect(rollback.change).toEqual({ kind: 'awaiting_restart', release: a.id });
    expect(rollback.selected).toBe(active.selected);
    expect((await next.rollback()).selection).toEqual(rollback.selection);
    const rolledBack = await fixtureInstallation(profile, b.bundle).startup();
    expect(rolledBack.selection).toEqual({ schemaVersion: 1, generation: 6, active: a.id, previous: b.id, pending: null });
    expect(rolledBack.selected?.id).toBe(a.id);
    expect((await fixtureInstallation(profile, b.bundle).startup()).selection).toEqual(rolledBack.selection);
    const retained = await stat(join(workspace, 'workspace.raw'));
    expect([retained.dev, retained.ino, await readFile(join(workspace, 'workspace.raw'), 'utf8')]).toEqual([disk.dev, disk.ino, 'persistent fixture bytes']);
    expect(await readFile(join(workspace, 'binding.json'), 'utf8')).toBe('persistent fixture binding');
  });

  it('retains the verified active release when candidate readiness fails and retries on restart', async () => {
    const { directory, profile } = await home(); const a = await fixtureBundle(directory, 'a'); const b = await fixtureBundle(directory, 'b');
    await startAndInstall(fixtureInstallation(profile, a.bundle));
    const updating = fixtureInstallation(profile, b.bundle); await updating.startup(); const staged = await updating.setup();
    const rejected = await fixtureInstallation(profile, b.bundle, { probe: { ...fixtureProbeWithoutVM,
      run: async () => ({ kind: 'failed', failure: { kind: 'probe', reason: 'failed', detail: 'fixture rejected' } }) } }).startup();
    expect(failure(rejected)).toEqual({ kind: 'probe', reason: 'failed', detail: 'fixture rejected' });
    expect(rejected.selected?.id).toBe(a.id); expect(rejected.selection).toEqual(staged.selection);
    const retried = await fixtureInstallation(profile, b.bundle).startup();
    expect(retried.selected?.id).toBe(b.id); expect(retried.selection.previous).toBe(a.id);
  });

  it('keeps an unverified or incompatible fallback disabled', async () => {
    const { directory, profile } = await home(); const a = await fixtureBundle(directory, 'a');
    await startAndInstall(fixtureInstallation(profile, a.bundle));
    const result = await fixtureInstallation(profile, a.bundle, { verifier: { verify: async () => ({ kind: 'rejected', failure: { kind: 'signature', scope: 'bundle', reason: 'wrong_team' } }) } }).startup();
    expect(failure(result)).toMatchObject({ kind: 'signature', reason: 'wrong_team' }); expect(result.selected).toBeNull();
    expect(result.selection.active).toBe(a.id);
  });

  it('rejects rollback when the previous release cannot read and write the profile format', async () => {
    const { directory, profile } = await home(); const a = await fixtureBundle(directory, 'a'); const b = await fixtureBundle(directory, 'b');
    await startAndInstall(fixtureInstallation(profile, a.bundle));
    const update = fixtureInstallation(profile, b.bundle); await update.startup(); await update.setup();
    const next = fixtureInstallation(profile, b.bundle); const before = await next.startup();
    const oldManifest = join(profile, 'runtime/versions', a.id, 'Runtime.bundle', NATIVE_MANIFEST_PATH);
    await makeFixtureWritable(oldManifest);
    const value = JSON.parse(await readFile(oldManifest, 'utf8')); value.compatibility.workspaceFormat = { read: [2], write: 2 };
    await writeFile(oldManifest, JSON.stringify(value)); await chmod(oldManifest, 0o444);
    const result = await next.rollback();
    expect(failure(result)).toEqual({ kind: 'compatibility', fields: ['workspaceFormat'] });
    expect(result.selection).toEqual(before.selection); expect(result.selected).toBe(before.selected);
  });

  it.each(['unsigned', 'ad_hoc', 'wrong_team', 'wrong_identifier', 'invalid'] as const)('preserves %s signature rejection before manifest parsing', async reason => {
    const { directory, profile } = await home(); const a = await fixtureBundle(directory, 'a');
    await writeFile(join(a.bundle, NATIVE_MANIFEST_PATH), 'not JSON');
    const installation = fixtureInstallation(profile, a.bundle, { verifier: { verify: async () => ({ kind: 'rejected', failure: { kind: 'signature', scope: 'bundle', reason, osStatus: -67050 } }) } });
    await installation.startup(); const result = await installation.setup();
    expect(failure(result)).toEqual({ kind: 'signature', scope: 'bundle', reason, osStatus: -67050 });
    expect(await readdir(join(profile, 'runtime/versions'))).toEqual([]);
    expect(result.selected).toBeNull();
  });

  it('preserves nested executable rejection and refuses incomplete independent verification', async () => {
    const { directory, profile } = await home(); const a = await fixtureBundle(directory, 'a');
    const denied: NativeBundleVerifier = { verify: async () => ({ kind: 'rejected', failure: { kind: 'signature', scope: 'executable', reason: 'ad_hoc', path: 'Contents/Helpers/codex' } }) };
    const first = fixtureInstallation(profile, a.bundle, { verifier: denied }); await first.startup();
    expect(failure(await first.setup())).toEqual({ kind: 'signature', scope: 'executable', reason: 'ad_hoc', path: 'Contents/Helpers/codex' });
    const second = fixtureInstallation(profile, a.bundle, { verifier: { verify: async input => ({ ...await fixtureVerifierWithoutSignatures.verify(input), executablePaths: ['Contents/Helpers/vm-helper'] }) } });
    await second.startup(); expect(failure(await second.setup()).kind).toBe('inventory');
  });

  it('keeps verifier process failure distinct from filesystem and signature rejection', async () => {
    const { directory, profile } = await home(); const a = await fixtureBundle(directory, 'a');
    const installation = fixtureInstallation(profile, a.bundle, { verifier: { verify: async () => { throw new Error('fixture verifier unavailable'); } } });
    await installation.startup();
    expect(failure(await installation.setup())).toEqual({ kind: 'verifier_unavailable', reason: 'fixture verifier unavailable' });
  });

  it('checks copied bytes through the independent verifier before publishing them', async () => {
    const { directory, profile } = await home(); const a = await fixtureBundle(directory, 'a');
    const installation = fixtureInstallation(profile, a.bundle, { verifier: { verify: async input => input.bundlePath.includes('/staging/')
      ? { kind: 'rejected', failure: { kind: 'signature', scope: 'bundle', reason: 'invalid' } } : fixtureVerifierWithoutSignatures.verify(input) } });
    await installation.startup(); expect(failure(await installation.setup()).kind).toBe('signature');
    expect(await readdir(join(profile, 'runtime/versions'))).toEqual([]);
    expect(installation.status().selection.active).toBeNull();
  });

  it.each(['payload', 'extra', 'signature-extra', 'executable-mode', 'manifest-bytes'] as const)('rejects an invalid %s inventory after fixture authentication', async mutation => {
    const { directory, profile } = await home(); const a = await fixtureBundle(directory, 'a');
    let verifier = fixtureVerifierWithoutSignatures;
    if (mutation === 'payload') await writeFile(join(a.bundle, 'Contents/Resources/kernel'), 'corrupted bytes');
    if (mutation === 'extra') await writeFile(join(a.bundle, 'Contents/Resources/unlisted'), 'unlisted');
    if (mutation === 'signature-extra') await writeFile(join(a.bundle, 'Contents/_CodeSignature/Unknown'), 'unlisted');
    if (mutation === 'executable-mode') await chmod(join(a.bundle, 'Contents/Resources/kernel'), 0o755);
    if (mutation === 'manifest-bytes') verifier = { verify: async input => {
      const value = await fixtureVerifierWithoutSignatures.verify(input);
      if (value.kind === 'rejected') return value;
      return { ...value, manifestBytes: Buffer.from(`${Buffer.from(value.manifestBytes).toString()} `) };
    } };
    const installation = fixtureInstallation(profile, a.bundle, { verifier }); await installation.startup();
    expect(failure(await installation.setup()).kind).toBe('inventory');
  });

  it.each(['CodeDirectory', 'CodeRequirements', 'CodeSignature', 'CodeResources'])('requires the resource-only bundle metadata file %s', async name => {
    const { directory, profile } = await home(); const a = await fixtureBundle(directory, 'a');
    await rm(join(a.bundle, 'Contents/_CodeSignature', name));
    const installation = fixtureInstallation(profile, a.bundle); await installation.startup();
    expect(failure(await installation.setup()).kind).toBe('inventory');
    expect(installation.status().selected).toBeNull();
  });

  it.each(['symlink', 'hardlink', 'writable', 'case-alias', 'source-ancestor'] as const)('rejects unsafe source %s before calling the verifier', async mutation => {
    const { directory, profile } = await home(); const a = await fixtureBundle(directory, 'a');
    const payload = join(a.bundle, 'Contents/Resources/kernel');
    let bundle = a.bundle;
    if (mutation === 'symlink') { await rename(payload, join(directory, 'outside')); await symlink(join(directory, 'outside'), payload); }
    if (mutation === 'hardlink') await link(payload, join(directory, 'outside'));
    if (mutation === 'writable') await chmod(payload, 0o666);
    if (mutation === 'case-alias') { await rename(payload, join(a.bundle, 'Contents/Resources/KERNEL')); await writeFile(payload, 'alias'); }
    if (mutation === 'source-ancestor') { await symlink(join(directory, 'source-a'), join(directory, 'alias')); bundle = join(directory, 'alias/Runtime.bundle'); }
    const verifier = { verify: vi.fn(fixtureVerifierWithoutSignatures.verify) };
    const installation = fixtureInstallation(profile, bundle, { verifier }); await installation.startup();
    const result = await installation.setup();
    if (mutation === 'case-alias' && process.platform === 'darwin') {
      expect(['inventory', 'filesystem']).toContain(failure(result).kind);
    } else { expect(failure(result).kind).toBe('filesystem'); expect(verifier.verify).not.toHaveBeenCalled(); }
  });

  it('rejects source/profile overlap and symlinked destination ancestry', async () => {
    const { directory, profile } = await home(); const a = await fixtureBundle(directory, 'a');
    expect(() => fixtureInstallation(profile, join(profile, 'Runtime.bundle'))).toThrow();
    await mkdir(join(directory, 'outside'), { mode: 0o700 });
    await symlink(join(directory, 'outside'), join(profile, 'runtime'));
    const result = await fixtureInstallation(profile, a.bundle).startup();
    expect(failure(result).kind).toBe('filesystem'); expect(await readdir(join(directory, 'outside'))).toEqual([]);
  });

  it('rejects a source FIFO without opening it or calling the verifier', async () => {
    const { directory, profile } = await home(); const a = await fixtureBundle(directory, 'a');
    await promisify(execFile)('/usr/bin/mkfifo', [join(a.bundle, 'Contents/Resources/pipe')]);
    const verifier = { verify: vi.fn(fixtureVerifierWithoutSignatures.verify) };
    const installation = fixtureInstallation(profile, a.bundle, { verifier }); await installation.startup();
    expect(failure(await installation.setup()).kind).toBe('filesystem'); expect(verifier.verify).not.toHaveBeenCalled();
  });

  it('rejects a stale staging link without following it into Session data', async () => {
    const { directory, profile } = await home(); const a = await fixtureBundle(directory, 'a');
    await startAndInstall(fixtureInstallation(profile, a.bundle));
    const disk = join(profile, 'workspace.raw'); await writeFile(disk, 'retained Session fixture');
    const before = await stat(disk);
    const stage = join(profile, 'runtime/staging/stage-00000000-0000-0000-0000-000000000000');
    await mkdir(stage); await symlink(disk, join(stage, 'workspace.raw'));
    const result = await fixtureInstallation(profile, a.bundle).startup();
    expect(failure(result).kind).toBe('filesystem');
    const after = await stat(disk);
    expect([after.dev, after.ino, await readFile(disk, 'utf8')]).toEqual([before.dev, before.ino, 'retained Session fixture']);
    expect((await lstat(join(stage, 'workspace.raw'))).isSymbolicLink()).toBe(true);
  });

  it.each(['entries', 'fileBytes', 'totalBytes', 'manifestBytes', 'depth', 'pathBytes'] as const)('enforces the %s copy bound', async limit => {
    const { directory, profile } = await home(); const a = await fixtureBundle(directory, 'a');
    const limits = { ...fixtureLimits, [limit]: limit === 'fileBytes' ? 10 : 1 };
    if (limit === 'fileBytes') limits.manifestBytes = 10;
    if (limit === 'totalBytes') { limits.fileBytes = 1; limits.manifestBytes = 1; }
    const installation = fixtureInstallation(profile, a.bundle, { limits }); await installation.startup();
    const result = await installation.setup();
    expect(failure(result).kind).toBe('bounds');
    expect(result.selected).toBeNull();
  });

  it('fails closed on corrupt selection and does not change the record', async () => {
    const { directory, profile } = await home(); const a = await fixtureBundle(directory, 'a');
    await startAndInstall(fixtureInstallation(profile, a.bundle));
    await writeFile(join(profile, 'runtime/selection.json'), '{broken');
    const installation = fixtureInstallation(profile, a.bundle);
    expect(failure(await installation.startup()).kind).toBe('selection');
    expect(failure(await installation.setup()).kind).toBe('selection');
    expect(await readFile(join(profile, 'runtime/selection.json'), 'utf8')).toBe('{broken');
  });

  it('rejects existing version content collisions without overwriting it', async () => {
    const { directory, profile } = await home(); const a = await fixtureBundle(directory, 'a');
    const installation = fixtureInstallation(profile, a.bundle); const initial = await startAndInstall(installation);
    const metadata = join(initial.selected!.bundlePath, 'Contents/_CodeSignature/CodeResources');
    await makeFixtureWritable(metadata); await writeFile(metadata, 'different fixture metadata'); await chmod(metadata, 0o444);
    expect(failure(await installation.setup())).toEqual({ kind: 'version_collision', release: a.id });
    expect(await readFile(metadata, 'utf8')).toBe('different fixture metadata');
    expect(installation.status().selection).toEqual(initial.selection);
  });

  it('rejects work without the existing lease and retains it while asynchronous work runs', async () => {
    const { directory, profile } = await home(); const a = await fixtureBundle(directory, 'a');
    const denied = fixtureInstallation(profile, a.bundle, { lease: { ...fixtureLease(profile), assertHeld: () => { throw new Error('lease released'); } } });
    expect(failure(await denied.startup())).toEqual({ kind: 'lease_lost' }); expect(await readdir(profile)).toEqual([]);
    let held = false;
    const lease = { profileDirectory: profile, assertHeld: () => {}, runWhileHeld: async <T>(work: () => Promise<T>) => { held = true; try { return await work(); } finally { held = false; } } };
    const installation = fixtureInstallation(profile, a.bundle, { lease, verifier: { verify: async input => { expect(held).toBe(true); return fixtureVerifierWithoutSignatures.verify(input); } } });
    await startAndInstall(installation); expect(held).toBe(false);
  });

  it('coalesces duplicate setup calls and rejects a different in-flight mutation', async () => {
    const { directory, profile } = await home(); const a = await fixtureBundle(directory, 'a');
    let release!: (value: NativeProbeResult) => void;
    const waiting = new Promise<NativeProbeResult>(resolve => { release = resolve; });
    const installation = fixtureInstallation(profile, a.bundle, { probe: { ...fixtureProbeWithoutVM, run: async () => waiting } });
    await installation.startup();
    const first = installation.setup(); const duplicate = installation.setup(); expect(first).toBe(duplicate);
    expect(failure(await installation.rollback())).toEqual({ kind: 'busy', operation: 'setup' });
    release({ kind: 'ready' }); expect((await first).selected?.id).toBe(a.id);
  });

  it('leaves stale probe data alone when recovery cannot reap its owner', async () => {
    const { directory, profile } = await home(); const a = await fixtureBundle(directory, 'a');
    await startAndInstall(fixtureInstallation(profile, a.bundle));
    const probe = join(profile, 'runtime/probes/probe-00000000-0000-0000-0000-000000000000');
    await mkdir(probe); await writeFile(join(probe, 'disk.raw'), 'disposable but retained');
    const installation = fixtureInstallation(profile, a.bundle, { probe: { ...fixtureProbeWithoutVM,
      recover: async () => ({ kind: 'failed', failure: { kind: 'probe', reason: 'recovery', detail: 'fixture owner still alive' } }) } });
    const result = await installation.startup();
    expect(failure(result)).toMatchObject({ kind: 'probe', reason: 'recovery' }); expect(result.selected).toBeNull();
    expect(failure(await installation.setup())).toMatchObject({ kind: 'probe', reason: 'recovery' });
    expect(installation.status().selected).toBeNull();
    expect(await readFile(join(probe, 'disk.raw'), 'utf8')).toBe('disposable but retained');
  });

  it('requires probe recovery before falling back after an unexpected probe exit', async () => {
    const { directory, profile } = await home(); const a = await fixtureBundle(directory, 'a'); const b = await fixtureBundle(directory, 'b');
    await startAndInstall(fixtureInstallation(profile, a.bundle));
    const update = fixtureInstallation(profile, b.bundle); await update.startup(); await update.setup();
    let recoveries = 0;
    const installation = fixtureInstallation(profile, b.bundle, { probe: {
      close: async () => {},
      recover: async () => ++recoveries === 1 ? { kind: 'ready' }
        : { kind: 'failed', failure: { kind: 'probe', reason: 'recovery', detail: 'fixture child still alive' } },
      run: async () => { throw new Error('fixture probe disappeared'); },
    } });
    expect(failure(await installation.startup())).toMatchObject({ kind: 'probe', reason: 'recovery' });
    expect(installation.status().selected).toBeNull();
    expect(failure(await installation.setup())).toMatchObject({ kind: 'probe', reason: 'recovery' });
  });

  it('removes bounded probe metadata after reported failure so retries do not accumulate homes', async () => {
    const { directory, profile } = await home(); const a = await fixtureBundle(directory, 'a');
    const installation = fixtureInstallation(profile, a.bundle, { probe: { ...fixtureProbeWithoutVM, run: async ({ directory: probe }) => {
      await writeFile(join(probe, 'binding.json'), '{}', { mode: 0o600 });
      return { kind: 'failed', failure: { kind: 'probe', reason: 'failed', detail: 'fixture failure' } };
    } } });
    await installation.startup();
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(failure(await installation.setup())).toMatchObject({ kind: 'probe', reason: 'failed' });
      expect(await readdir(join(profile, 'runtime/probes'))).toEqual([]);
    }
  });

  it('requires recovery when cleanup after a reported probe failure cannot finish', async () => {
    const { profile, directory } = await home(); const a = await fixtureBundle(directory, 'a');
    let recoveries = 0;
    const run = vi.fn(async ({ directory: probe }: { directory: string }) => {
      const disk = join(probe, 'binding.json');
      await writeFile(disk, 'disposable fixture disk');
      await chmod(disk, 0o666);
      return { kind: 'failed' as const, failure: { kind: 'probe' as const, reason: 'failed' as const, detail: 'fixture failure' } };
    });
    const installation = fixtureInstallation(profile, a.bundle, { probe: {
      close: async () => {},
      run,
      recover: async () => ++recoveries === 1 ? { kind: 'ready' }
        : { kind: 'failed', failure: { kind: 'probe', reason: 'recovery', detail: 'fixture scratch remains' } },
    } });
    await installation.startup();
    expect(failure(await installation.setup())).toMatchObject({ kind: 'filesystem' });
    expect(failure(await installation.setup())).toMatchObject({ kind: 'probe', reason: 'recovery' });
    expect(recoveries).toBe(2);
    expect(run).toHaveBeenCalledOnce();
    expect(installation.status().selected).toBeNull();
    expect(await readdir(join(profile, 'runtime/probes'))).toHaveLength(1);
  });

  it('uses independent bounded budgets for probe metadata and immutable staging payloads', async () => {
    const { profile, directory } = await home(); const a = await fixtureBundle(directory, 'a');
    await fixtureInstallation(profile, a.bundle).startup();
    const stage = join(profile, 'runtime/staging/stage-00000000-0000-0000-0000-000000000000');
    const probe = join(profile, 'runtime/probes/probe-00000000-0000-0000-0000-000000000000');
    await mkdir(stage, { mode: 0o700 }); await mkdir(probe, { mode: 0o700 });
    for (let index = 0; index < 3; index++) await writeFile(join(stage, `file-${index}`), Buffer.alloc(60 * 1024), { mode: 0o600 });
    await writeFile(join(probe, 'binding.json'), Buffer.alloc(180 * 1024), { mode: 0o600 });
    const result = await fixtureInstallation(profile, a.bundle).startup();
    expect(result.change.kind).not.toBe('failed');
    expect(await readdir(join(profile, 'runtime/staging'))).toEqual([]);
    expect(await readdir(join(profile, 'runtime/probes'))).toEqual([]);
  });

  it('never unlinks a probe disk through generic metadata cleanup even after reported readiness', async () => {
    const { profile, directory } = await home(); const a = await fixtureBundle(directory, 'a');
    let disk = '';
    const installation = fixtureInstallation(profile, a.bundle, { probe: { ...fixtureProbeWithoutVM, run: async ({ directory: probe }) => {
      disk = join(probe, 'workspace.raw');
      await writeFile(disk, 'still attached', { mode: 0o600 });
      return { kind: 'ready' };
    } } });
    await installation.startup();
    expect(failure(await installation.setup())).toMatchObject({ kind: 'probe', reason: 'recovery' });
    expect(await readFile(disk, 'utf8')).toBe('still attached');
    expect(installation.status().selected).toBeNull();
  });
});

describe('fresh process recovery at durable boundaries using unsigned fixtures', () => {
  const checkpoints: NativeInstallCheckpoint[] = ['copied-file', 'staging-synced', 'copy-verified', 'version-renamed', 'version-parent-synced',
    'selection-file-synced', 'selection-renamed', 'selection-parent-synced', 'probe-ready'];
  it.each(checkpoints)('recovers first install after process exit at %s', async checkpoint => {
    const { directory, profile } = await home(); const a = await fixtureBundle(directory, 'a');
    await runCrash(profile, a.bundle, checkpoint);
    const recovered = fixtureInstallation(profile, a.bundle); await recovered.startup();
    const result = await recovered.setup();
    expect(result.change).toEqual({ kind: 'none' }); expect(result.selected?.id).toBe(a.id);
    expect(result.selection).toEqual({ schemaVersion: 1, generation: 2, active: a.id, previous: null, pending: null });
    expect(await readdir(join(profile, 'runtime/staging'))).toEqual([]);
    expect(await readdir(join(profile, 'runtime/probes'))).toEqual([]);
    expect((await fixtureInstallation(profile, a.bundle).startup()).selection).toEqual(result.selection);
  }, 15_000);

  it.each(['probe-ready', 'selection-file-synced', 'selection-renamed', 'selection-parent-synced'] as const)('does not exchange active and previous twice after activation exit at %s', async checkpoint => {
    const { directory, profile } = await home(); const a = await fixtureBundle(directory, 'a'); const b = await fixtureBundle(directory, 'b');
    await startAndInstall(fixtureInstallation(profile, a.bundle));
    const next = fixtureInstallation(profile, b.bundle); await next.startup(); await next.setup();
    await runCrash(profile, b.bundle, checkpoint, 'startup');
    const recovered = await fixtureInstallation(profile, b.bundle).startup();
    expect(recovered.change).toEqual({ kind: 'none' }); expect(recovered.selected?.id).toBe(b.id);
    expect(recovered.selection).toEqual({ schemaVersion: 1, generation: 4, active: b.id, previous: a.id, pending: null });
    expect((await fixtureInstallation(profile, b.bundle).startup()).selection).toEqual(recovered.selection);
  }, 15_000);

  it.each(checkpoints.filter(point => point !== 'probe-ready'))('retains or completes a staged update after process exit at %s', async checkpoint => {
    const { directory, profile } = await home(); const a = await fixtureBundle(directory, 'a'); const b = await fixtureBundle(directory, 'b');
    await startAndInstall(fixtureInstallation(profile, a.bundle));
    await runCrash(profile, b.bundle, checkpoint);
    const recovered = fixtureInstallation(profile, b.bundle); const started = await recovered.startup();
    const pendingWasPublished = checkpoint === 'selection-renamed' || checkpoint === 'selection-parent-synced';
    expect(started.selected?.id).toBe(pendingWasPublished ? b.id : a.id);
    if (!pendingWasPublished) {
      const staged = await recovered.setup();
      expect(staged.change).toEqual({ kind: 'awaiting_restart', release: b.id });
      expect(staged.selected?.id).toBe(a.id);
    }
    const selected = await fixtureInstallation(profile, b.bundle).startup();
    expect(selected.selection).toEqual({ schemaVersion: 1, generation: 4, active: b.id, previous: a.id, pending: null });
  }, 15_000);
});
