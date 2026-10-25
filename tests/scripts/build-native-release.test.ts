import { createHash } from 'node:crypto';
import { appendFile, chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { assembleNativeRelease, checkedFile, inspectMachO, nativeBundleFingerprint, nativeBundleInventory, nativeCompatibility, nativeExecutablePolicy, nativeManifest, parseNativeReleaseOptions, signingArguments } from '../../scripts/build-native-release.mjs';
import { BASE_IMAGE, RPM_RELEASE } from '../../scripts/native-guest-inputs.mjs';
import { decodeAuthenticatedNativeManifest } from '../../src/domain/native-release.js';
import { newcFixture } from './native-guest-archive-fixture.js';

const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const directories: string[] = [];
const identity = 'Developer ID Application: Fixture (PB8NAVKU57)';
const protocol = { hostTarget: 'aarch64-apple-darwin', guestTarget: 'aarch64-unknown-linux-gnu', appProtocol: 2, controllerProtocol: 3,
  workerProtocol: 4, workspaceFormat: 5, accountStateFormat: 6, profileSchema: 7 };
const signaturePaths = ['CodeDirectory', 'CodeRequirements', 'CodeResources', 'CodeSignature'].map(path => `Contents/_CodeSignature/${path}`);
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

function machO(major = 15, minor = 2, command = 0x32, policy?: { machOType: number; rpaths?: string[] }, libraries: string[] = []) {
  const linked = (name: string, command: number, minimum: number) => {
    const bytes = Buffer.alloc(Math.ceil((minimum + Buffer.byteLength(name) + 1) / 8) * 8);
    bytes.writeUInt32LE(command, 0); bytes.writeUInt32LE(bytes.length, 4); bytes.writeUInt32LE(minimum, 8); bytes.write(name, minimum);
    return bytes;
  };
  const extra = [...(policy?.rpaths ?? []).map(path => linked(path, 0x8000001c, 12)), ...libraries.map(path => linked(path, 0xc, 24))];
  const commandBytes = (command === 0x32 ? 24 : 16) + extra.reduce((total, value) => total + value.length, 0);
  const bytes = Buffer.alloc(32 + commandBytes);
  bytes.writeUInt32LE(0xfeedfacf, 0); bytes.writeUInt32LE(0x100000c, 4); bytes.writeUInt32LE(policy?.machOType ?? 2, 12);
  bytes.writeUInt32LE(1 + extra.length, 16); bytes.writeUInt32LE(commandBytes, 20);
  bytes.writeUInt32LE(command, 32); bytes.writeUInt32LE(command === 0x32 ? 24 : 16, 36);
  if (command === 0x32) bytes.writeUInt32LE(1, 40);
  bytes.writeUInt32LE((major << 16) | (minor << 8), command === 0x32 ? 44 : 40);
  Buffer.concat(extra).copy(bytes, 32 + (command === 0x32 ? 24 : 16));
  return bytes;
}

function elf() {
  const bytes = Buffer.alloc(64); bytes.write('7f454c46', 'hex'); bytes[4] = 2; bytes[5] = 1; bytes[6] = 1;
  bytes.writeUInt16LE(2, 16); bytes.writeUInt16LE(183, 18); bytes.writeUInt32LE(1, 20); bytes.writeUInt16LE(64, 52);
  return bytes;
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'rat-native-assembly-')); directories.push(directory);
  const write = async (path: string, bytes: string | Uint8Array, mode = 0o644) => {
    await mkdir(dirname(join(directory, path)), { recursive: true }); await writeFile(join(directory, path), bytes, { mode });
  };
  const source = { repository: 'https://github.com/openai/codex.git', revision: 'a'.repeat(40), upstreamVersion: '0.154.0', patches: ['fixture.patch'] };
  const sourceIdentity = { ...source, patches: [{ name: 'fixture.patch', sha256: digest('patch') }] };
  await write('definition/source.json', json(source)); await write('definition/fixture.patch', 'patch');
  await write('definition/artifact-policy.json', json({ sourceSha256: digest(JSON.stringify(sourceIdentity)), patchedTree: 'b'.repeat(40) }));
  const builds = { profile: 'release', debug: 'none', incremental: false, locked: true, jobs: 1, patchedTree: 'b'.repeat(40) };
  const paths = ['bin/codex', 'bin/codex-code-mode-host', 'codex-package.json', 'codex-path/rg'];
  const packages: Record<string, unknown> = {}; const packageLocks: Record<string, unknown> = {};
  const manifests = new Map<string, { source: typeof sourceIdentity; build: typeof builds & { nativeTarget: string }; binary: string;
    sha256: string; platform: string; arch: string; upstreamPackage: { name: string; version: string }; files: { path: string; sha256: string }[] }>();
  for (const platform of ['darwin', 'linux']) {
    const target = platform === 'darwin' ? protocol.hostTarget : protocol.guestTarget;
    const descriptor = { layoutVersion: 1, version: source.upstreamVersion, target, variant: 'codex', entrypoint: 'bin/codex', resourcesDir: 'codex-resources', pathDir: 'codex-path' };
    const policies = nativeExecutablePolicy.filter(policy => policy.role !== 'vm-helper');
    const allPaths = platform === 'darwin'
      ? ['codex-package.json', ...policies.map(policy => policy.path.slice('Contents/Resources/codex/'.length)), 'codex-resources/voice/runtime.json', 'codex-resources/voice/NOTICE.md']
      : [...paths, 'codex-resources/bwrap'];
    const content = (path: string) => {
      if (path === 'codex-package.json') return json(descriptor);
      if (path.endsWith('.json') || path.endsWith('.md')) return 'Pinned companion resource';
      const policy = policies.find(policy => policy.path === `Contents/Resources/codex/${path}`);
      return platform === 'darwin' ? machO(path.endsWith('codex-voice-host') ? 15 : 11, 0, 0x32, policy) : elf();
    };
    const files = allPaths.map(path => ({ path, sha256: digest(content(path)), executable: !path.endsWith('.json') && !path.endsWith('.md') }));
    const packageName = `@openai/codex-${platform}-arm64`;
    const locked = { name: '@openai/codex', version: `${source.upstreamVersion}-${platform}-arm64`, resolved: `https://registry.npmjs.org/${platform}.tgz`, integrity: `sha512-${'A'.repeat(86)}==` };
    packageLocks[`node_modules/${packageName}`] = locked;
    packages[packageName] = { ...locked, descriptor, files };
    for (const file of files) await write(`${platform}/runtime/${file.path}`, content(file.path), file.executable ? 0o755 : 0o444);
    const manifest = { source: sourceIdentity, build: { ...builds, nativeTarget: target }, binary: join(directory, platform, 'runtime/bin/codex'),
      sha256: files.find(file => file.path === 'bin/codex')!.sha256, platform, arch: 'arm64',
      upstreamPackage: { name: packageName, version: locked.version }, files: files.map(({ path, sha256 }) => ({ path, sha256 })) };
    manifests.set(platform, manifest); await write(`${platform}/artifact.json`, json(manifest));
  }
  await write('repository/runtime/codex/companion-packages.json', json(packages));
  await write('repository/package-lock.json', json({ packages: packageLocks }));
  await write('repository/runtime/native/protocol.json', json(protocol));
  await write('repository/runtime/native/main.swift', 'fixture helper source');
  await write('repository/runtime/native/entitlements.plist', '<plist><dict><key>com.apple.security.virtualization</key><true/></dict></plist>');
  await write('repository/runtime/codex/licenses/LICENSE', 'Codex license'); await write('repository/runtime/codex/licenses/NOTICE', 'Codex notice');
  await write('repository/LICENSE', 'Rat Things license');
  const kernel = { release: 'fixture-kernel', image: { sha256: digest('kernel') }, sourceMaterial: { status: 'required-before-distribution' } };
  await write('repository/runtime/native/kernel-inputs.json', json(kernel));
  const rpm = { name: 'fixture', epoch: '0', version: '1', release: '1', architecture: 'aarch64', sourceRpm: 'fixture.src.rpm', license: 'MIT' };
  const transaction = { schemaVersion: 1, releasever: RPM_RELEASE, enabledRepositories: ['amazonlinux'], packages: [rpm], beforePackages: [rpm],
    keyFingerprints: ['a'.repeat(40)], importedKeysSha256: 'b'.repeat(64), repositoryFiles: [{ path: 'repodata/repomd.xml', bytes: 1, sha256: 'c'.repeat(64) }], cachedRpms: [] };
  const guestArtifact = manifests.get('linux')!;
  const javascriptNotices = { schemaVersion: 1, surface: 'worker', coverage: 'esbuild-package-owners', referenceSyntax: ['SEE LICENSE IN', 'local Markdown links'], evidence: [], packages: [] };
  const inputs = { base: { reference: BASE_IMAGE, arm64ManifestDigest: `sha256:${'d'.repeat(64)}`, configDigest: `sha256:${'e'.repeat(64)}` },
    sourceDateEpoch: 1, kernelInputsSha256: digest(json(kernel)), codexArtifactSha256: digest(json(guestArtifact)),
    sources: [{ path: 'runtime/codex/licenses/LICENSE', sha256: digest('Codex license') }, { path: 'runtime/codex/licenses/NOTICE', sha256: digest('Codex notice') }],
    bundles: { workerSha256: digest('worker'), workspaceExportSha256: digest('export') }, transactions: { worker: transaction, native: transaction }, kernelModulesSha256: digest('modules'), javascriptNoticesSha256: digest(json(javascriptNotices)) };
  const lock = { schemaVersion: 1, status: 'checked', inputs };
  const contents = [
    { path: 'opt/rat-things/notices/javascript/index.json', data: Buffer.from(json(javascriptNotices)), mode: 0o100444 },
    ...await Promise.all(guestArtifact.files.map(async file => ({ path: `opt/codex-runtime/${file.path}`, data: await readFile(join(directory, 'linux/runtime', file.path)), mode: file.path === 'codex-package.json' ? 0o100444 : 0o100755 }))),
    { path: 'opt/codex-runtime/artifact.json', data: Buffer.from(json(guestArtifact)), mode: 0o100444 },
    { path: 'opt/codex-runtime/licenses/LICENSE', data: Buffer.from('Codex license'), mode: 0o100444 },
    { path: 'opt/codex-runtime/licenses/NOTICE', data: Buffer.from('Codex notice'), mode: 0o100444 },
    { path: 'usr/share/man/man1/:.1.gz', data: Buffer.from('shell manual'), mode: 0o100644 },
    { path: 'usr/share/man/man3/B::Concise.3pm.gz', data: Buffer.from('Perl manual'), mode: 0o100644 },
  ];
  const payload = newcFixture(contents); const archive = payload.inventory;
  const guestFiles: Record<string, string | Buffer> = { Image: 'kernel', 'worker-initramfs.gz': payload.bytes, 'archive-inventory.json': json(archive),
    'worker-dependencies.json': json([]), 'worker-notices.json': json(javascriptNotices), 'worker-metafile.json': json({}), 'worker-build.json': json({ bundles: inputs.bundles }), 'build.log': 'fixture build' };
  for (const [name, bytes] of Object.entries(guestFiles)) await write(`guest/${name}`, bytes);
  await write('guest/checked-lock.json', json(lock)); await write('guest/observed-inputs.json', json(inputs));
  await write('guest/evidence/worker/inventory.json', json(transaction)); await write('guest/evidence/native/inventory.json', json(transaction));
  await write('guest/evidence/kernel.json', 'modules');
  await write('guest/evidence/codex-artifact.json', json(guestArtifact));
  const guestBuild = { schemaVersion: 1, status: 'inputs-checked', distributionReady: false, sourceDateEpoch: 1, gzipMtime: 0,
    inputsSha256: digest(json(inputs)), lockSha256: digest(json(lock)), outstandingDistributionInputs: ['Corresponding sources', 'Companion notices'],
    artifacts: Object.entries(guestFiles).map(([path, bytes]) => ({ path, bytes: Buffer.byteLength(bytes), sha256: digest(bytes) })) };
  await write('guest/guest-build.json', json(guestBuild));
  const calls: { command: string; args: string[] }[] = [];
  const options = { hostArtifact: join(directory, 'darwin'), guestOutput: join(directory, 'guest'), definitionRoot: join(directory, 'definition'), output: join(directory, 'output'), identity };
  const repositoryRoot = join(directory, 'repository');
  const run = async (command: string, args: string[]) => {
    calls.push({ command, args });
    if (command === '/usr/bin/xcrun') {
      if (args.includes('-o')) await writeFile(args[args.indexOf('-o') + 1]!, machO());
      return { stdout: args.includes('--show-sdk-path') ? '/fixture/sdk' : 'fixture-toolchain', stderr: '' };
    }
    if (args.includes('--sign')) {
      const filename = args.at(-1)!;
      if ((await lstat(filename)).isDirectory()) {
        const bundleManifest = JSON.parse(await readFile(join(filename, 'Contents/Resources/runtime-manifest.json'), 'utf8'));
        for (const entry of bundleManifest.files) expect(digest(await readFile(join(filename, entry.path)))).toBe(entry.sha256);
        for (const path of signaturePaths) { await mkdir(dirname(join(filename, path)), { recursive: true }); await writeFile(join(filename, path), 'fixture-signature'); }
      } else await appendFile(filename, 'fixture-signature');
    }
    return { stdout: 'fixture', stderr: '' };
  };
  return { directory, write, options, repositoryRoot, run, calls, guestBuild, archive, inputs, contents };
}

it('assembles an exact signed candidate with untouched input provenance and hashes of signed bytes', async () => {
  const f = await fixture(); const original = await readFile(join(f.options.hostArtifact, 'artifact.json'));
  const result = await assembleNativeRelease(f.options, { repositoryRoot: f.repositoryRoot, run: f.run });
  const bundle = join(f.options.output, 'Runtime.bundle'); const manifestBytes = await readFile(join(bundle, 'Contents/Resources/runtime-manifest.json'));
  const manifest = decodeAuthenticatedNativeManifest(JSON.parse(manifestBytes.toString()));
  expect(result.releaseId).toBe(digest(manifestBytes)); expect(result.distributionReady).toBe(false);
  expect(manifest.compatibility).toEqual({ ...nativeCompatibility(protocol, nativeExecutablePolicy.map(() => ({ minimumMacOS: '15.2.0' }))), minimumMacOS: '15.2.0' });
  expect(manifest.files.filter(file => file.kind === 'host-executable')).toHaveLength(nativeExecutablePolicy.length);
  expect(await readFile(join(f.options.output, 'evidence/host-artifact.json'))).toEqual(original);
  expect(await readFile(join(f.options.hostArtifact, 'artifact.json'))).toEqual(original);
  const provenance = await readFile(join(bundle, 'Contents/Resources/provenance.json'), 'utf8');
  expect(provenance).not.toContain(f.directory); expect(provenance).toContain('Corresponding sources');
  for (const mapping of JSON.parse(provenance).executables) expect(mapping.unsigned.sha256).not.toBe(mapping.signed.sha256);
  const signedInventory = await readFile(join(f.options.output, 'evidence/signed-inventory.json'));
  expect(result.signedTreeSha256).toBe(nativeBundleFingerprint(JSON.parse(signedInventory.toString())));
  const signing = f.calls.filter(call => call.args.includes('--sign'));
  expect(signing).toHaveLength(nativeExecutablePolicy.length + 1); expect(signing.at(-1)!.args.at(-1)).toBe(bundle);
  expect(signing.every(call => call.args.includes('--timestamp') && call.args.includes('runtime') && !call.args.includes('--deep'))).toBe(true);
  expect(f.calls.find(call => call.args.includes('-target'))!.args).toContain('arm64-apple-macos15.0.0');
});

it('requires checked guest evidence before invoking compiler or signer', async () => {
  const f = await fixture(); await f.write('guest/guest-build.json', json({ ...f.guestBuild, status: 'candidate' }));
  await expect(assembleNativeRelease(f.options, { repositoryRoot: f.repositoryRoot, run: f.run })).rejects.toThrow('checked build evidence');
  expect(f.calls).toEqual([]);
});

it('rejects changed guest archive bytes before creating a signed candidate', async () => {
  const f = await fixture(); await f.write('guest/worker-initramfs.gz', 'changed archive');
  await expect(assembleNativeRelease(f.options, { repositoryRoot: f.repositoryRoot, run: f.run })).rejects.toThrow('checksum differs');
  expect(f.calls).toEqual([]);
});

it('rejects changed archive members even when the archive digest in the build report is updated', async () => {
  const f = await fixture(); f.contents[0]!.data = Buffer.from('changed notice index');
  const changed = newcFixture(f.contents).bytes; await f.write('guest/worker-initramfs.gz', changed);
  const artifact = f.guestBuild.artifacts.find(file => file.path === 'worker-initramfs.gz')!;
  artifact.sha256 = digest(changed); artifact.bytes = changed.length;
  await f.write('guest/guest-build.json', json(f.guestBuild));
  await expect(assembleNativeRelease(f.options, { repositoryRoot: f.repositoryRoot, run: f.run })).rejects.toThrow('archive bytes differ');
  expect(f.calls).toEqual([]);
});

it('rejects guest package members not admitted by the checked artifact', async () => {
  const f = await fixture(); f.archive.entries.find(entry => entry.path === 'opt/codex-runtime/bin/codex')!.sha256 = 'f'.repeat(64);
  const changed = json(f.archive); await f.write('guest/archive-inventory.json', changed);
  const entry = f.guestBuild.artifacts.find(file => file.path === 'archive-inventory.json')!; entry.sha256 = digest(changed); entry.bytes = Buffer.byteLength(changed);
  await f.write('guest/guest-build.json', json(f.guestBuild));
  await expect(assembleNativeRelease(f.options, { repositoryRoot: f.repositoryRoot, run: f.run })).rejects.toThrow('Guest Codex member');
  expect(f.calls).toEqual([]);
});

it('requires a new output and keeps an existing output untouched', async () => {
  const f = await fixture(); await mkdir(f.options.output); await f.write('output/previous', 'previous candidate');
  await expect(assembleNativeRelease(f.options, { repositoryRoot: f.repositoryRoot, run: f.run })).rejects.toThrow('EEXIST');
  expect(await readFile(join(f.options.output, 'previous'), 'utf8')).toBe('previous candidate'); expect(f.calls).toEqual([]);
});

it('rejects changed source inputs before signing the outer bundle', async () => {
  const f = await fixture();
  const run = async (command: string, args: string[]) => {
    const result = await f.run(command, args);
    if (args.includes('-o')) await f.write('repository/runtime/native/main.swift', 'changed helper source');
    return result;
  };
  await expect(assembleNativeRelease(f.options, { repositoryRoot: f.repositoryRoot, run })).rejects.toThrow('Input changed or checksum differs');
  expect(f.calls.filter(call => call.args.includes('--sign'))).toHaveLength(nativeExecutablePolicy.length);
  await expect(lstat(join(f.options.output, 'release.json'))).rejects.toThrow('ENOENT');
});

it('rejects an outer signer that mutates a payload after the manifest was written', async () => {
  const f = await fixture();
  const run = async (command: string, args: string[]) => {
    const result = await f.run(command, args);
    if (args.includes('--sign') && args.at(-1)!.endsWith('Runtime.bundle')) {
      const image = join(args.at(-1)!, 'Contents/Resources/linux/Image'); await chmod(image, 0o644); await appendFile(image, 'changed');
    }
    return result;
  };
  await expect(assembleNativeRelease(f.options, { repositoryRoot: f.repositoryRoot, run })).rejects.toThrow('Outer signing changed');
});

it('rejects staged archive changes during helper compilation before sealing the outer bundle', async () => {
  const f = await fixture();
  const run = async (command: string, args: string[]) => {
    const result = await f.run(command, args);
    if (args.includes('-o')) {
      const archive = join(f.options.output, 'Runtime.bundle/Contents/Resources/linux/worker-initramfs.gz');
      await chmod(archive, 0o644); await appendFile(archive, 'changed after verified copy'); await chmod(archive, 0o444);
    }
    return result;
  };
  await expect(assembleNativeRelease(f.options, { repositoryRoot: f.repositoryRoot, run })).rejects.toThrow('Staged runtime payload changed');
  expect(f.calls.filter(call => call.args.includes('--sign')).some(call => call.args.at(-1)!.endsWith('Runtime.bundle'))).toBe(false);
});

it('derives the deployment floor from modern and legacy Mach-O commands', () => {
  expect(inspectMachO(machO(15, 4))).toEqual({ minimumMacOS: '15.4.0', libraries: [] });
  expect(inspectMachO(machO(12, 7, 0x24))).toEqual({ minimumMacOS: '12.7.0', libraries: [] });
  expect(nativeCompatibility(protocol, nativeExecutablePolicy.map(() => inspectMachO(machO(15)))).minimumMacOS).toBe('15.2.0');
});

it('accepts only the fixed bundled libraries and search paths for each Mach-O role', () => {
  const voice = nativeExecutablePolicy.find(policy => policy.identifier === 'dev.rat-things.runtime.voice-host')!;
  const library = nativeExecutablePolicy.find(policy => policy.path.endsWith('/lib/libgio-2.0.0.dylib'))!;
  const plugin = nativeExecutablePolicy.find(policy => policy.path.endsWith('/plugins/libgstapp.dylib'))!;
  for (const [policy, dependency] of [
    [voice, '@rpath/libgio-2.0.0.dylib'],
    [library, '@loader_path/libglib-2.0.0.dylib'],
    [plugin, '@loader_path/../lib/libgstapp-1.0.0.dylib'],
  ] as const) {
    expect(inspectMachO(machO(14, 0, 0x32, policy, [dependency]), policy).libraries).toEqual([dependency]);
  }
  for (const dependency of ['/tmp/injected.dylib', '/usr/lib/../../tmp/injected.dylib', '@rpath/unknown.dylib', '@loader_path/../bin/codex-voice-host']) {
    expect(() => inspectMachO(machO(14, 0, 0x32, voice, [dependency]), voice)).toThrow('unbundled library');
  }
  expect(() => inspectMachO(machO(14, 0, 0x32, { ...voice, rpaths: ['/tmp'] }), voice)).toThrow('search paths');
  expect(() => inspectMachO(machO(14, 0, 0x32, library))).toThrow('fixed host code policy');
  expect(() => inspectMachO(machO(14), library)).toThrow('fixed host code policy');
});

it('keeps compiled signature identifiers aligned with the reviewed upstream native inventory', async () => {
  const companions = JSON.parse(await readFile(new URL('../../runtime/codex/companion-packages.json', import.meta.url), 'utf8'));
  const paths = companions['@openai/codex-darwin-arm64'].files.filter((file: { executable: boolean }) => file.executable)
    .map((file: { path: string }) => `Contents/Resources/codex/${file.path}`);
  expect(nativeExecutablePolicy.filter(policy => policy.role !== 'vm-helper').map(policy => policy.path).sort()).toEqual(paths.sort());
  const verifier = await readFile(new URL('../../runtime/local/verify-runtime.swift', import.meta.url), 'utf8');
  const compiledPolicy = [...verifier.matchAll(/ExecutablePolicy\(path: "([^"]+)", identifier: "([^"]+)"\)/g)]
    .map(([, path, identifier]) => ({ path, identifier }));
  expect(compiledPolicy).toEqual(nativeExecutablePolicy.map(({ path, identifier }) => ({ path, identifier })));
  expect(new Set(nativeExecutablePolicy.map(policy => policy.identifier)).size).toBe(nativeExecutablePolicy.length);
  expect(nativeExecutablePolicy.some(policy => policy.path.endsWith('.json') || policy.path.includes('/zsh/'))).toBe(false);
});

it('rejects missing, truncated, and non-macOS deployment commands', () => {
  const missing = machO(); missing.writeUInt32LE(0x2, 32); expect(() => inspectMachO(missing)).toThrow('deployment');
  const truncated = machO(); truncated.writeUInt32LE(1024, 20); expect(() => inspectMachO(truncated)).toThrow('bounds');
  const platform = machO(); platform.writeUInt32LE(2, 40); expect(() => inspectMachO(platform)).toThrow('not macOS');
});

it('limits JIT entitlements to the two Codex executables and virtualization to the helper', () => {
  const commands = nativeExecutablePolicy.map(policy => signingArguments(identity, policy, policy.path, { jit: 'jit.plist', virtualization: 'vm.plist' }));
  expect(commands.filter(args => args.includes('jit.plist')).map(args => args.at(-1))).toEqual(nativeExecutablePolicy.slice(0, 2).map(policy => policy.path));
  expect(commands.filter(args => args.includes('vm.plist')).map(args => args.at(-1))).toEqual(['Contents/Helpers/rat-native-worker']);
  expect(commands.filter(args => !args.includes('--entitlements'))).toHaveLength(nativeExecutablePolicy.length - 3);
});

it('rejects unlisted executable files and links in the outer payload', async () => {
  const f = await fixture(); const bundle = join(f.directory, 'small.bundle');
  await mkdir(join(bundle, 'Contents'), { recursive: true }); await writeFile(join(bundle, 'Contents/extra'), 'script', { mode: 0o755 });
  await expect(nativeBundleInventory(bundle)).rejects.toThrow('Unexpected executable');
  await chmod(join(bundle, 'Contents/extra'), 0o644); await symlink('extra', join(bundle, 'Contents/link'));
  await expect(nativeBundleInventory(bundle)).rejects.toThrow('symlink');
});

it('does not copy an input whose bytes differ from its admitted hash', async () => {
  const f = await fixture(); await f.write('input', 'actual');
  await expect(checkedFile(join(f.directory, 'input'), { expected: { sha256: digest('expected') }, destination: join(f.directory, 'copied') })).rejects.toThrow('checksum differs');
});

it('requires explicit trusted inputs and the fixed signing team', () => {
  const args = ['--host-artifact', '/host', '--guest-output', '/guest', '--definition-root', '/definition', '--output', '/out', '--identity', identity];
  expect(parseNativeReleaseOptions(args)).toMatchObject({ hostArtifact: '/host', guestOutput: '/guest', identity });
  expect(() => parseNativeReleaseOptions(args.slice(0, -2))).toThrow('Required');
  expect(() => parseNativeReleaseOptions([...args, '--output', '/other'])).toThrow('unique');
  expect(() => parseNativeReleaseOptions([...args.slice(0, -1), '-'])).toThrow('Developer ID');
  expect(() => parseNativeReleaseOptions([...args.slice(0, -1), identity.replace('PB8NAVKU57', 'WRONGTEAM1')])).toThrow('PB8NAVKU57');
});

it('refuses a manifest whose file inventory differs from the staged payload', () => {
  expect(() => nativeManifest('1', {}, [], ['Contents/missing'])).toThrow('exact assembly inventory');
});

it('fingerprints all files in installer traversal order including signature metadata', () => {
  const files = [
    { path: 'Contents/a-file', bytes: 1, sha256: digest('a'), kind: 'resource' },
    { path: 'Contents/a/file', bytes: 2, sha256: digest('bc'), kind: 'host-executable' },
    { path: 'Contents/_CodeSignature/CodeSignature', bytes: 3, sha256: digest('sig'), kind: 'resource' },
  ];
  const canonical = [files[2]!, files[1]!, files[0]!].map(file => `${file.path}\0${file.bytes}\0${file.kind === 'host-executable'}\0${file.sha256}\n`).join('');
  expect(nativeBundleFingerprint(files)).toBe(digest(canonical));
});
