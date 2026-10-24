import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { LocalNativeInstallation } from '../../src/adapters/local-native-installation.js';
import type { NativeBundleVerifier, NativeCopyLimits, NativeInstallationLease, NativeReleaseProbe } from '../../src/core/native-installation-ports.js';
import { NATIVE_MANIFEST_PATH, type NativeCompatibilityRequirements } from '../../src/domain/native-release.js';

export const fixtureRequirements: NativeCompatibilityRequirements = {
  hostTarget: 'aarch64-apple-darwin', guestTarget: 'aarch64-unknown-linux-gnu', macOS: '26.3',
  appProtocol: 1, controllerProtocol: 1, workerProtocol: 1, workspaceFormat: 1, accountStateFormat: 1, profileSchema: 1,
};
export const fixtureLimits: NativeCopyLimits = {
  entries: 100, fileBytes: 64 * 1024, totalBytes: 256 * 1024, manifestBytes: 32 * 1024, depth: 16, pathBytes: 1024,
};
export const fixtureExecutablePaths = ['Contents/Helpers/vm-helper', 'Contents/Helpers/codex'];

export const fixtureVerifierWithoutSignatures: NativeBundleVerifier = {
  verify: async ({ bundlePath }) => ({ kind: 'authenticated', manifestBytes: await readFile(join(bundlePath, NATIVE_MANIFEST_PATH)), executablePaths: fixtureExecutablePaths }),
};
export const fixtureProbeWithoutVM: NativeReleaseProbe = {
  recover: async () => ({ kind: 'ready' }), run: async () => ({ kind: 'ready' }), close: async () => {},
};

export function fixtureLease(profileDirectory: string): NativeInstallationLease {
  return { profileDirectory, assertHeld: () => {}, runWhileHeld: work => work() };
}

export async function fixtureHome() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'rat-installation-fixture-')));
  const profile = join(directory, 'profile');
  await mkdir(profile, { mode: 0o700 });
  return { directory, profile };
}

export async function fixtureBundle(directory: string, version: string, compatibility: Record<string, unknown> = {}) {
  const bundle = join(directory, `source-${version}`, 'Runtime.bundle');
  const payloads = [
    { path: 'Contents/Info.plist', bytes: Buffer.from('unsigned fixture bundle'), kind: 'resource' },
    { path: 'Contents/Helpers/vm-helper', bytes: Buffer.from(`unsigned helper fixture ${version}`), kind: 'host-executable', role: 'vm-helper' },
    { path: 'Contents/Helpers/codex', bytes: Buffer.from(`unsigned Codex fixture ${version}`), kind: 'host-executable', role: 'host-codex' },
    { path: 'Contents/Resources/kernel', bytes: Buffer.from(`nonbootable kernel fixture ${version}`), kind: 'resource' },
  ];
  for (const file of payloads) {
    const path = join(bundle, file.path);
    await mkdir(dirname(path), { recursive: true, mode: 0o755 });
    await writeFile(path, file.bytes, { mode: file.kind === 'host-executable' ? 0o755 : 0o644 });
  }
  await mkdir(join(bundle, 'Contents/_CodeSignature'), { mode: 0o755 });
  for (const name of ['CodeDirectory', 'CodeRequirements', 'CodeSignature', 'CodeResources']) {
    await writeFile(join(bundle, 'Contents/_CodeSignature', name), 'This is unsigned fixture metadata, not a signature.');
  }
  const manifest = {
    schemaVersion: 1, version,
    compatibility: {
      hostTarget: fixtureRequirements.hostTarget, guestTarget: fixtureRequirements.guestTarget, minimumMacOS: '14.0',
      appProtocol: { minimum: 1, maximum: 1 }, controllerProtocol: { minimum: 1, maximum: 1 }, workerProtocol: 1,
      workspaceFormat: { read: [1], write: 1 }, accountStateFormat: 1, profileSchema: 1, ...compatibility,
    },
    files: payloads.map(({ bytes, ...file }) => ({ ...file, bytes: bytes.byteLength, sha256: digest(bytes) })),
  };
  const bytes = Buffer.from(JSON.stringify(manifest));
  await writeFile(join(bundle, NATIVE_MANIFEST_PATH), bytes);
  return { bundle, manifest, id: digest(bytes) };
}

export function fixtureInstallation(profile: string, bundle: string, override: Partial<ConstructorParameters<typeof LocalNativeInstallation>[0]> = {}) {
  return new LocalNativeInstallation({ lease: fixtureLease(profile), bundledRuntimePath: bundle,
    verifier: fixtureVerifierWithoutSignatures, probe: fixtureProbeWithoutVM, requirements: fixtureRequirements, limits: fixtureLimits, ...override });
}

export async function makeFixtureWritable(path: string) { await chmod(path, 0o644); }
export function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }

export async function removeInstallationFixture(directory: string): Promise<void> {
  const makeWritable = async (path: string): Promise<void> => {
    const value = await lstat(path);
    if (!value.isDirectory() || value.isSymbolicLink()) return;
    await chmod(path, 0o700);
    for (const child of await readdir(path)) await makeWritable(join(path, child));
  };
  await makeWritable(directory);
  await rm(directory, { recursive: true, force: true });
}
