import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, writeFileSync } from 'node:fs';
import { appendFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { signDesktopBundle, stageDesktopCodexRuntime } from '../../scripts/build-desktop.mjs';

const digest = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'rat-desktop-codex-test-')); directories.push(directory);
  const artifactRoot = join(directory, 'artifact'); const definitionRoot = join(directory, 'definition');
  const bundle = join(directory, 'Rat Things.app'); const destination = join(bundle, 'Contents/Resources/codex-runtime');
  await mkdir(definitionRoot); await mkdir(dirname(destination), { recursive: true });
  const source = { repository: 'https://github.com/openai/codex.git', revision: 'a'.repeat(40), upstreamVersion: '0.164.0' };
  const descriptor = { layoutVersion: 1, version: source.upstreamVersion, target: 'aarch64-apple-darwin', variant: 'codex',
    entrypoint: 'bin/codex', resourcesDir: 'codex-resources', pathDir: 'codex-path' };
  const executable = Buffer.alloc(64); executable.writeUInt32LE(0xfeedfacf, 0); executable.writeUInt32LE(0x100000c, 4); executable.writeUInt32LE(2, 12);
  const contents = { 'bin/codex': Buffer.concat([executable, Buffer.from('original-signature')]),
    'codex-package.json': Buffer.from(JSON.stringify(descriptor)), 'codex-resources/example.txt': Buffer.from('official resource') };
  const files = Object.entries(contents).map(([path, bytes]) => ({ path, sha256: digest(bytes), executable: path === 'bin/codex' }));
  for (const file of files) {
    const path = join(artifactRoot, 'runtime', file.path); await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents[file.path as keyof typeof contents], { mode: file.executable ? 0o755 : 0o444 });
  }
  const locked = { name: '@openai/codex', version: '0.164.0-darwin-arm64', resolved: 'https://registry.npmjs.org/@openai/codex/-/codex-0.164.0-darwin-arm64.tgz', integrity: `sha512-${'A'.repeat(86)}==` };
  const manifest = { source, platform: 'darwin', arch: 'arm64', upstreamPackage: { name: '@openai/codex-darwin-arm64', version: locked.version },
    distribution: { kind: 'official-npm', target: descriptor.target, integrity: locked.integrity }, sha256: files[0]!.sha256,
    files: files.map(({ path, sha256 }) => ({ path, sha256 })) };
  const packageLockPath = join(directory, 'package-lock.json'); const companionInventoryPath = join(directory, 'companions.json');
  await writeFile(join(definitionRoot, 'source.json'), JSON.stringify(source));
  await writeFile(packageLockPath, JSON.stringify({ packages: { 'node_modules/@openai/codex-darwin-arm64': locked } }));
  await writeFile(companionInventoryPath, JSON.stringify({ '@openai/codex-darwin-arm64': { ...locked, descriptor, files } }));
  await writeFile(join(artifactRoot, 'artifact.json'), JSON.stringify(manifest));
  const stage = () => stageDesktopCodexRuntime(artifactRoot, destination, { definitionRoot, packageLockPath, companionInventoryPath });
  return { artifactRoot, destination, bundle, manifest, contents, stage };
}

it('preserves official bytes and signs only the outer development app', async () => {
  const f = await fixture(); const runtime = await f.stage(); const calls: Array<{ command: string; args: string[] }> = [];
  await signDesktopBundle(f.bundle, runtime, (command, args) => {
    calls.push({ command, args }); return { status: 0 };
  });
  expect(calls).toEqual([{ command: 'codesign', args: ['--force', '--sign', '-', f.bundle] }]);
  for (const [path, bytes] of Object.entries(f.contents)) expect(await readFile(join(f.destination, path))).toEqual(bytes);
});

it('rejects altered official input even when its descriptor and manifest agree', async () => {
  const f = await fixture(); const changed = Buffer.concat([f.contents['bin/codex'], Buffer.from('changed')]);
  await writeFile(join(f.artifactRoot, 'runtime/bin/codex'), changed);
  f.manifest.sha256 = digest(changed); f.manifest.files[0]!.sha256 = digest(changed);
  await writeFile(join(f.artifactRoot, 'artifact.json'), JSON.stringify(f.manifest));
  await expect(f.stage()).rejects.toThrow('differs from the official npm package');
  await expect(lstat(f.destination)).rejects.toThrow('ENOENT');
});

it('rejects staged mutation before calling the signer', async () => {
  const f = await fixture(); const runtime = await f.stage(); let called = false;
  await appendFile(join(f.destination, 'bin/codex'), 'changed');
  await expect(signDesktopBundle(f.bundle, runtime, () => { called = true; return { status: 0 }; })).rejects.toThrow('checksum differs');
  expect(called).toBe(false);
});

it.each(['binary', 'resource', 'inventory'])('rejects outer signing that changes the official %s', async mutation => {
  const f = await fixture(); const runtime = await f.stage();
  const run = () => {
    if (mutation === 'inventory') writeFileSync(join(f.destination, 'extra'), 'unlisted');
    else {
      const path = join(f.destination, mutation === 'binary' ? 'bin/codex' : 'codex-resources/example.txt');
      if (mutation === 'resource') chmodSync(path, 0o644);
      appendFileSync(path, 'changed');
      if (mutation === 'resource') chmodSync(path, 0o444);
    }
    return { status: 0 };
  };
  await expect(signDesktopBundle(f.bundle, runtime, run)).rejects.toThrow(mutation === 'inventory' ? 'inventory changed' : 'checksum differs');
});
