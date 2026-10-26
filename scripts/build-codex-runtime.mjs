import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { codexRuntimeTargets } from './codex-runtime-targets.mjs';
import { validateCodexRuntimeArtifact } from './codex-runtime-artifact.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = process.argv[2] && resolve(process.argv[2]);
if (!output || process.argv.length !== 3) throw new Error('Usage: node scripts/build-codex-runtime.mjs NEW_OUTPUT_DIRECTORY');
const target = codexRuntimeTargets[`${process.platform}-${process.arch}`];
if (!target) throw new Error('Official runtime packaging supports ARM64 macOS and ARM64 or x64 Linux.');
const source = JSON.parse(await readFile(join(root, 'runtime/codex/source.json'), 'utf8'));
if ('patches' in source) throw new Error('Only unmodified official Codex releases can be packaged.');
const inventory = JSON.parse(await readFile(join(root, 'runtime/codex/companion-packages.json'), 'utf8'))[target.packageName];
const packagePath = createRequire(import.meta.url).resolve(`${target.packageName}/package.json`);
const installed = JSON.parse(await readFile(packagePath, 'utf8'));
if (installed.version !== `${source.upstreamVersion}-${target.platform}-${target.arch}`) throw new Error('Install the exact pinned official Codex package first.');
const vendor = join(dirname(packagePath), 'vendor', target.vendorTarget);
await mkdir(dirname(output), { recursive: true });
await mkdir(output);
await cp(vendor, join(output, 'runtime'), { recursive: true, errorOnExist: true, force: false });
const manifest = {
  source, platform: target.platform, arch: target.arch,
  distribution: { kind: 'official-npm', target: target.vendorTarget, integrity: inventory.integrity },
  upstreamPackage: { name: target.packageName, version: installed.version },
  sha256: inventory.files.find(file => file.path === 'bin/codex').sha256,
  files: inventory.files.map(({ path, sha256 }) => ({ path, sha256 })),
};
await writeFile(join(output, 'artifact.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
await validateCodexRuntimeArtifact(output, { expectedTarget: target.nativeTarget });
console.log(JSON.stringify({ directory: output, distribution: manifest.distribution.kind, version: source.upstreamVersion, binarySha256: manifest.sha256 }));
