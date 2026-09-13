import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { codexRuntimeEntries } from '../../scripts/codex-runtime-artifact.mjs';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'rat-runtime-artifact-')); directories.push(directory);
  const source = JSON.parse(await readFile('runtime/codex/source.json', 'utf8')) as { repository: string; revision: string; upstreamVersion: string; patches: string[] };
  const patches = await Promise.all(source.patches.map(async name => ({ name, sha256: digest(await readFile(join('runtime/codex', name))) })));
  const executable = Buffer.alloc(64); executable.write('7f454c46', 'hex'); executable[4] = 2; executable[5] = 1; executable.writeUInt16LE(183, 18);
  const files = ['bin/codex', 'bin/codex-code-mode-host', 'codex-resources/bwrap', 'codex-path/rg'].map(path => ({ path, sha256: digest(executable) }));
  for (const file of files) { const path = join(directory, 'runtime', file.path); await mkdir(dirname(path), { recursive: true }); await writeFile(path, executable); }
  const descriptor = Buffer.from(JSON.stringify({ layoutVersion: 1, version: source.upstreamVersion,
    target: 'aarch64-unknown-linux-gnu', variant: 'codex', entrypoint: 'bin/codex', resourcesDir: 'codex-resources', pathDir: 'codex-path' }));
  await writeFile(join(directory, 'runtime/codex-package.json'), descriptor);
  files.push({ path: 'codex-package.json', sha256: digest(descriptor) });
  const manifest = { source: { ...source, patches }, platform: 'linux', arch: 'arm64', sha256: digest(executable), files,
    upstreamPackage: { name: '@openai/codex-linux-arm64', version: `${source.upstreamVersion}-linux-arm64` },
    build: { nativeTarget: 'aarch64-unknown-linux-gnu', locked: true, patchedTree: 'a'.repeat(40) } };
  const save = () => writeFile(join(directory, 'artifact.json'), JSON.stringify(manifest));
  await save();
  return { directory, executable, manifest, save };
}

it('packages the complete source-matched ARM64 artifact and its provenance', async () => {
  const f = await fixture();
  const entries = await codexRuntimeEntries(f.directory);
  expect(entries.map(entry => entry.target)).toEqual(['codex-runtime/bin/codex', 'codex-runtime/bin/codex-code-mode-host', 'codex-runtime/codex-resources/bwrap', 'codex-runtime/codex-path/rg', 'codex-runtime/codex-package.json', 'codex-runtime/artifact.json']);
});

it('rejects missing source audit evidence and mismatched runtime package metadata', async () => {
  const f = await fixture();
  f.manifest.build.patchedTree = ''; await f.save();
  await expect(codexRuntimeEntries(f.directory)).rejects.toThrow('build provenance');
  f.manifest.build.patchedTree = 'a'.repeat(40);
  const descriptor = Buffer.from(JSON.stringify({ layoutVersion: 1, target: 'aarch64-unknown-linux-musl' }));
  await writeFile(join(f.directory, 'runtime/codex-package.json'), descriptor);
  f.manifest.files.find(file => file.path === 'codex-package.json')!.sha256 = digest(descriptor); await f.save();
  await expect(codexRuntimeEntries(f.directory)).rejects.toThrow('package descriptor');
});

it('rejects changed binary bytes, even when the source label is unchanged', async () => {
  const f = await fixture();
  await writeFile(join(f.directory, 'runtime/bin/codex'), 'different executable');
  await expect(codexRuntimeEntries(f.directory)).rejects.toThrow('checksum mismatch');
});

it('rejects a source mismatch and missing companion binaries', async () => {
  const f = await fixture();
  const revision = f.manifest.source.revision;
  f.manifest.source.revision = 'unrelated'; await f.save();
  await expect(codexRuntimeEntries(f.directory)).rejects.toThrow('pinned Linux ARM64 source');
  f.manifest.source.revision = revision;
  f.manifest.files = f.manifest.files.filter(file => file.path !== 'bin/codex-code-mode-host'); await f.save();
  await expect(codexRuntimeEntries(f.directory)).rejects.toThrow('companions are incomplete');
});

it('checks executable architecture and rejects paths outside the runtime', async () => {
  const f = await fixture();
  f.executable.writeUInt16LE(62, 18);
  await writeFile(join(f.directory, 'runtime/bin/codex'), f.executable);
  f.manifest.files[0]!.sha256 = f.manifest.sha256 = digest(f.executable); await f.save();
  await expect(codexRuntimeEntries(f.directory)).rejects.toThrow('not Linux ARM64');
  f.manifest.files[0]!.path = '../outside'; await f.save();
  await expect(codexRuntimeEntries(f.directory)).rejects.toThrow('artifact paths');
});
