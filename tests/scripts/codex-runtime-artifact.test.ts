import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { codexRuntimeEntries, validateCodexRuntimeArtifact } from '../../scripts/codex-runtime-artifact.mjs';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const targets = { linux: 'aarch64-unknown-linux-gnu', darwin: 'aarch64-apple-darwin' };

it('rejects missing native inputs before replacing any existing Lambda archive', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rat-package-preflight-')); directories.push(directory);
  await mkdir(join(directory, 'dist/lambdas/example'), { recursive: true });
  await writeFile(join(directory, 'dist/lambdas/example/index.mjs'), 'export const handler = () => null;');
  const archive = join(directory, 'dist/example.zip');
  await writeFile(archive, 'previous archive');
  await expect(promisify(execFile)(process.execPath, [resolve('scripts/package-lambdas.mjs')], {
    cwd: directory, env: { ...process.env, CODEX_RUNTIME_ARTIFACT: join(directory, 'missing') }, timeout: 5000,
  })).rejects.toThrow('Build the Linux ARM64 Codex runtime first');
  expect(await readFile(archive, 'utf8')).toBe('previous archive');
});

async function fixture(platform: keyof typeof targets = 'linux') {
  const directory = await mkdtemp(join(tmpdir(), 'rat-runtime-artifact-')); directories.push(directory);
  const source = JSON.parse(await readFile('runtime/codex/source.json', 'utf8')) as { repository: string; revision: string; upstreamVersion: string; patches: string[] };
  const policy = JSON.parse(await readFile('runtime/codex/artifact-policy.json', 'utf8')) as { patchedTree: string };
  const patches = await Promise.all(source.patches.map(async name => ({ name, sha256: digest(await readFile(join('runtime/codex', name))) })));
  const executable = Buffer.alloc(64);
  if (platform === 'linux') {
    executable.write('7f454c46', 'hex'); executable[4] = 2; executable[5] = 1; executable[6] = 1;
    executable.writeUInt16LE(2, 16); executable.writeUInt16LE(183, 18); executable.writeUInt32LE(1, 20); executable.writeUInt16LE(64, 52);
  } else {
    executable.writeUInt32LE(0xfeedfacf, 0); executable.writeUInt32LE(0x100000c, 4); executable.writeUInt32LE(2, 12);
  }
  const packageName = `@openai/codex-${platform}-arm64`;
  const packages = JSON.parse(await readFile('runtime/codex/companion-packages.json', 'utf8'));
  const pinned = packages[packageName];
  const files: { path: string; sha256: string }[] = [];
  for (const file of pinned.files) {
    const bytes = file.path === 'codex-package.json' ? Buffer.from(JSON.stringify(pinned.descriptor, null, 2) + '\n') : executable;
    file.sha256 = digest(bytes);
    const runtimeBytes = file.path === 'codex-package.json'
      ? Buffer.from(JSON.stringify({ ...pinned.descriptor, target: targets[platform] }, null, 2) + '\n') : bytes;
    const path = join(directory, 'runtime', file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, runtimeBytes, { mode: file.executable ? 0o755 : 0o644 });
    files.push({ path: file.path, sha256: digest(runtimeBytes) });
  }
  const companionInventoryPath = join(directory, 'companions.json');
  await writeFile(companionInventoryPath, JSON.stringify(packages));
  const manifest = { source: { ...source, patches }, platform, arch: 'arm64', sha256: digest(executable), files,
    upstreamPackage: { name: packageName, version: `${source.upstreamVersion}-${platform}-arm64` },
    build: { nativeTarget: targets[platform], patchedTree: policy.patchedTree, profile: 'release', debug: 'none', incremental: false, locked: true, jobs: 1 } };
  const save = () => writeFile(join(directory, 'artifact.json'), JSON.stringify(manifest));
  const replaceFile = async (path: string, bytes: Uint8Array) => {
    await writeFile(join(directory, 'runtime', path), bytes);
    manifest.files.find(file => file.path === path)!.sha256 = digest(bytes);
    if (path === 'bin/codex') manifest.sha256 = digest(bytes);
    await save();
  };
  const options = { expectedTarget: targets[platform], companionInventoryPath };
  const validate = () => validateCodexRuntimeArtifact(directory, options);
  await save();
  return { directory, executable, manifest, save, replaceFile, options, validate };
}

it.each(['linux', 'darwin'] as const)('admits a complete %s release and returns only verified runtime files', async platform => {
  const f = await fixture(platform);
  const admitted = await f.validate();
  expect(admitted.files.map(file => file.path)).toEqual([
    'bin/codex', 'bin/codex-code-mode-host', 'codex-package.json', 'codex-path/rg',
    ...(platform === 'linux' ? ['codex-resources/bwrap'] : []), 'codex-resources/zsh/bin/zsh',
  ]);
  expect(admitted.files.find(file => file.path === 'bin/codex')!.mode).toBe(0o755);
  expect(admitted.files.find(file => file.path === 'codex-package.json')!.mode).toBe(0o444);
});

it('keeps the packaging wrapper Linux-only and includes original provenance', async () => {
  const f = await fixture();
  const entries = await codexRuntimeEntries(f.directory, f.options);
  expect(entries.map(entry => entry.target)).toEqual([
    'codex-runtime/bin/codex', 'codex-runtime/bin/codex-code-mode-host', 'codex-runtime/codex-package.json',
    'codex-runtime/codex-path/rg', 'codex-runtime/codex-resources/bwrap', 'codex-runtime/codex-resources/zsh/bin/zsh',
    'codex-runtime/artifact.json',
  ]);
  const host = await fixture('darwin');
  await expect(codexRuntimeEntries(host.directory, host.options)).rejects.toThrow('build provenance');
});

it('requires an explicit supported target', async () => {
  const f = await fixture();
  await expect(validateCodexRuntimeArtifact(f.directory)).rejects.toThrow('explicit supported');
  await expect(validateCodexRuntimeArtifact(f.directory, { ...f.options, expectedTarget: 'aarch64-unknown-linux-musl' })).rejects.toThrow('explicit supported');
});

it.each([
  ['profile', 'debug'], ['debug', 'full'], ['incremental', true], ['locked', false],
  ['jobs', 0], ['jobs', -1], ['jobs', 1.5], ['jobs', '1'], ['jobs', null],
  ['patchedTree', 'a'.repeat(40)], ['patchedTree', ''], ['nativeTarget', 'aarch64-unknown-linux-musl'],
] as const)('rejects incompatible release provenance %s=%s', async (key, value) => {
  const f = await fixture();
  Object.assign(f.manifest.build, { [key]: value }); await f.save();
  await expect(f.validate()).rejects.toThrow('build provenance');
});

it.each(['profile', 'debug', 'incremental', 'locked', 'jobs', 'patchedTree', 'nativeTarget'])('rejects missing build evidence %s', async key => {
  const f = await fixture();
  Reflect.deleteProperty(f.manifest.build, key); await f.save();
  await expect(f.validate()).rejects.toThrow('build provenance');
});

it('rejects incorrect platform and architecture', async () => {
  const f = await fixture();
  f.manifest.arch = 'x64'; await f.save();
  await expect(f.validate()).rejects.toThrow('build provenance');
  f.manifest.arch = 'arm64'; f.manifest.platform = 'darwin'; await f.save();
  await expect(f.validate()).rejects.toThrow('build provenance');
});

it('requires exact source identity and ordered patch hashes', async () => {
  const f = await fixture();
  const original = structuredClone(f.manifest.source);
  f.manifest.source.revision = 'unrelated'; await f.save();
  await expect(f.validate()).rejects.toThrow('pinned source');
  f.manifest.source = structuredClone(original); f.manifest.source.patches.reverse(); await f.save();
  await expect(f.validate()).rejects.toThrow('ordered patches');
  f.manifest.source = structuredClone(original); f.manifest.source.patches[0]!.sha256 = '0'.repeat(64); await f.save();
  await expect(f.validate()).rejects.toThrow('ordered patches');
});

it('admits a staged definition only with its independently supplied expected tree', async () => {
  const f = await fixture();
  const definitionRoot = join(f.directory, 'definition');
  await cp('runtime/codex', definitionRoot, { recursive: true });
  const source = JSON.parse(await readFile(join(definitionRoot, 'source.json'), 'utf8'));
  source.patches.push('staged.patch');
  await writeFile(join(definitionRoot, 'source.json'), JSON.stringify(source));
  await writeFile(join(definitionRoot, 'staged.patch'), 'staged patch bytes');
  f.manifest.source.patches.push({ name: 'staged.patch', sha256: digest('staged patch bytes') });
  f.manifest.build.patchedTree = 'f'.repeat(40); await f.save();
  await expect(validateCodexRuntimeArtifact(f.directory, { ...f.options, definitionRoot })).rejects.toThrow('artifact policy');
  await expect(validateCodexRuntimeArtifact(f.directory, { ...f.options, definitionRoot, expectedPatchedTree: 'f'.repeat(40) })).resolves.toMatchObject({ manifest: f.manifest });
  await expect(validateCodexRuntimeArtifact(f.directory, { ...f.options, definitionRoot, expectedPatchedTree: 'e'.repeat(40) })).rejects.toThrow('build provenance');
});

it.each(['name', 'version'] as const)('rejects mismatched upstream package %s', async field => {
  const f = await fixture();
  f.manifest.upstreamPackage[field] = 'unrelated'; await f.save();
  await expect(f.validate()).rejects.toThrow('pinned npm package');
});

it('binds the checked companion inventory to the npm tarball integrity', async () => {
  const f = await fixture();
  const packageLockPath = join(f.directory, 'package-lock.json');
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
  lock.packages['node_modules/@openai/codex-linux-arm64'].integrity = 'sha512-changed';
  await writeFile(packageLockPath, JSON.stringify(lock));
  await expect(validateCodexRuntimeArtifact(f.directory, { ...f.options, packageLockPath })).rejects.toThrow('pinned npm package');
});

it('rejects a changed companion even if its declared checksum is changed too', async () => {
  const f = await fixture();
  const executable = Buffer.from(f.executable); executable[63] = 1;
  await f.replaceFile('codex-resources/zsh/bin/zsh', executable);
  await expect(f.validate()).rejects.toThrow('companion differs');
});

it.each(['linux', 'darwin'] as const)('rejects missing %s companions', async platform => {
  const f = await fixture(platform);
  f.manifest.files = f.manifest.files.filter(file => file.path !== 'codex-resources/zsh/bin/zsh'); await f.save();
  await rm(join(f.directory, 'runtime/codex-resources/zsh'), { recursive: true });
  await expect(f.validate()).rejects.toThrow('companions are incomplete');
});

it('rejects descriptor fields outside the permitted Linux target adjustment', async () => {
  const f = await fixture();
  const path = 'codex-package.json';
  const descriptor = JSON.parse(await readFile(join(f.directory, 'runtime', path), 'utf8'));
  await f.replaceFile(path, Buffer.from(JSON.stringify({ ...descriptor, extra: 'untrusted' }, null, 2) + '\n'));
  await expect(f.validate()).rejects.toThrow('package descriptor');
  await f.replaceFile(path, Buffer.from(JSON.stringify({ ...descriptor, target: 'aarch64-unknown-linux-musl' }, null, 2) + '\n'));
  await expect(f.validate()).rejects.toThrow('package descriptor');
});

it.each(['linux', 'darwin'] as const)('rejects altered %s descriptor bytes', async platform => {
  const f = await fixture(platform);
  const descriptor = await readFile(join(f.directory, 'runtime/codex-package.json'));
  await f.replaceFile('codex-package.json', Buffer.concat([descriptor, Buffer.from('\n')]));
  await expect(f.validate()).rejects.toThrow('descriptor differs');
});

it('rejects changed binary bytes and a mismatched entrypoint digest', async () => {
  const f = await fixture();
  await writeFile(join(f.directory, 'runtime/bin/codex'), 'changed');
  await expect(f.validate()).rejects.toThrow('checksum mismatch');
  await writeFile(join(f.directory, 'runtime/bin/codex'), f.executable);
  f.manifest.sha256 = '0'.repeat(64); await f.save();
  await expect(f.validate()).rejects.toThrow('entrypoint digest');
});

it.each(['linux', 'darwin'] as const)('rejects a %s binary for another architecture or format', async platform => {
  const f = await fixture(platform);
  const otherArch = Buffer.from(f.executable);
  if (platform === 'linux') otherArch.writeUInt16LE(62, 18);
  else otherArch.writeUInt32LE(0x1000007, 4);
  await f.replaceFile('bin/codex', otherArch);
  await expect(f.validate()).rejects.toThrow(`not ${platform} ARM64`);
  await f.replaceFile('bin/codex', Buffer.from('#!/bin/sh\nexit 0\n'));
  await expect(f.validate()).rejects.toThrow(`not ${platform} ARM64`);
});

it.each(['linux', 'darwin'] as const)('rejects non-executable %s object formats', async platform => {
  const f = await fixture(platform);
  const object = Buffer.from(f.executable);
  if (platform === 'linux') object.writeUInt16LE(1, 16);
  else object.writeUInt32LE(1, 12);
  await f.replaceFile('bin/codex', object);
  await expect(f.validate()).rejects.toThrow(`not ${platform} ARM64`);
});

it('rejects a binary without execute permission', async () => {
  const f = await fixture();
  await chmod(join(f.directory, 'runtime/bin/codex'), 0o644);
  await expect(f.validate()).rejects.toThrow('executable permission');
});

it.each(['../outside', '/absolute', 'bin/../codex', 'bin/./codex', 'bin//codex', 'bin\\codex', 'bin/codex\0'])('rejects unsafe inventory path %j', async path => {
  const f = await fixture();
  f.manifest.files[0]!.path = path; await f.save();
  await expect(f.validate()).rejects.toThrow('artifact paths');
});

it('rejects duplicate inventory entries', async () => {
  const f = await fixture();
  f.manifest.files.push({ ...f.manifest.files[0]! }); await f.save();
  await expect(f.validate()).rejects.toThrow('artifact paths');
});

it('rejects undeclared files even when all declared hashes still match', async () => {
  const f = await fixture();
  await writeFile(join(f.directory, 'runtime/bin/unlisted'), 'unlisted');
  await expect(f.validate()).rejects.toThrow('missing or unlisted');
});

it('rejects files absent from the actual tree', async () => {
  const f = await fixture();
  await rm(join(f.directory, 'runtime/codex-path/rg'));
  await expect(f.validate()).rejects.toThrow(/missing or unlisted|unlisted empty directory/);
});

it('rejects extra empty directories', async () => {
  const f = await fixture();
  await mkdir(join(f.directory, 'runtime/unlisted'));
  await expect(f.validate()).rejects.toThrow('unlisted empty directory');
});

it.each(['file', 'directory', 'runtime', 'manifest', 'root'] as const)('rejects a %s symlink even when its target bytes match', async kind => {
  const f = await fixture();
  if (kind === 'root') {
    const linkedRoot = join(f.directory, 'linked-root');
    await symlink(f.directory, linkedRoot);
    await expect(validateCodexRuntimeArtifact(linkedRoot, f.options)).rejects.toThrow();
    return;
  }
  const path = { file: 'runtime/bin/codex', directory: 'runtime/bin', runtime: 'runtime', manifest: 'artifact.json' }[kind];
  const original = join(f.directory, path);
  const outside = join(f.directory, 'outside');
  await cp(original, outside, { recursive: true });
  await rm(original, { recursive: true });
  await symlink(outside, original);
  await expect(f.validate()).rejects.toThrow();
});

it('rejects a FIFO manifest without blocking on its contents', async () => {
  const f = await fixture();
  const manifestPath = join(f.directory, 'artifact.json');
  await rm(manifestPath);
  await promisify(execFile)('mkfifo', [manifestPath]);
  await expect(f.validate()).rejects.toThrow('not a regular file');
});
