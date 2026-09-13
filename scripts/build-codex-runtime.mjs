import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, readdir, statfs, cp, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve, relative } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const definition = join(root, 'runtime/codex');
const source = JSON.parse(await readFile(join(definition, 'source.json'), 'utf8'));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const buildRoot = process.argv[2] && resolve(process.argv[2]);
const prepareOnly = process.argv[3] === '--prepare-only';
if (!buildRoot || process.argv.length > 4 || process.argv[3] && !prepareOnly) throw new Error('Usage: node scripts/build-codex-runtime.mjs BUILD_DIRECTORY [--prepare-only]');
await mkdir(buildRoot, { recursive: true });
const marker = join(buildRoot, 'rat-codex-source.json');
const identity = JSON.stringify({ ...source, patches: await Promise.all(source.patches.map(async (name) => ({ name, sha256: createHash('sha256').update(await readFile(join(definition, name))).digest('hex') }))) });
const previous = await readFile(marker, 'utf8').catch((error) => { if (error.code === 'ENOENT') return undefined; throw error; });
if (previous !== undefined && previous !== identity) throw new Error('Build directory belongs to a different source revision or patch. Use a new directory.');
if (previous === undefined && (await readdir(buildRoot)).length) throw new Error('Use an empty build directory. Existing files will not be replaced.');
const run = async (program, args, cwd = buildRoot, env = process.env) => {
  const child = spawn(program, args, { cwd, env, stdio: 'inherit' });
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => code === 0 ? resolve() : reject(new Error(`${program} exited with ${signal ?? code}`))); });
};
const checkout = join(buildRoot, 'source');
if (previous === undefined) {
  await writeFile(marker, identity, { flag: 'wx' });
  await run('git', ['init', checkout]);
  await run('git', ['remote', 'add', 'origin', source.repository], checkout);
  await run('git', ['fetch', '--depth=1', 'origin', source.revision], checkout);
  await run('git', ['checkout', '--detach', source.revision], checkout);
  for (const patch of source.patches) {
    await run('git', ['apply', '--check', join(definition, patch)], checkout);
    await run('git', ['apply', join(definition, patch)], checkout);
  }
}
const { stdout: revision } = await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: checkout });
if (revision.trim() !== source.revision) throw new Error('Native source revision changed');
for (const patch of source.patches) await run('git', ['apply', '--reverse', '--check', join(definition, patch)], checkout);
const patchedTree = await verifySourceTree();
const modelDefaults = JSON.parse(await readFile(join(definition, 'model-defaults.json'), 'utf8'));
const modelCatalogue = await readFile(join(checkout, modelDefaults.sourcePath));
const expectedDefaults = Object.fromEntries(JSON.parse(modelCatalogue).models.map((model) => [model.slug, model.default_reasoning_level]));
if (modelDefaults.revision !== source.revision || createHash('sha256').update(modelCatalogue).digest('hex') !== modelDefaults.sourceSha256
  || JSON.stringify(modelDefaults.defaults) !== JSON.stringify(expectedDefaults)) {
  throw new Error('Resolved API model defaults do not match the pinned harness catalogue.');
}
if (!prepareOnly) {
  const space = await statfs(buildRoot);
  if (space.bavail * space.bsize < 16 * 1024 ** 3) throw new Error('Native compilation requires at least 16 GiB of free working space. Source preparation is complete.');
  const target = join(buildRoot, 'target');
  const jobs = Number(process.env.CARGO_BUILD_JOBS ?? 1);
  if (!Number.isInteger(jobs) || jobs < 1) throw new Error('CARGO_BUILD_JOBS must be a positive integer.');
  const build = { profile: 'release', debug: 'none', incremental: false, locked: true, jobs };
  // Keep the exact upstream package's companion host and resources. Patching the
  // CLI alone silently disables code mode when its sibling executable is absent.
  const triples = { 'darwin-arm64': 'aarch64-apple-darwin', 'linux-arm64': 'aarch64-unknown-linux-musl' };
  const triple = triples[`${process.platform}-${process.arch}`];
  if (!triple) throw new Error('The worker runtime build supports ARM64 macOS and Linux.');
  const packageName = `@openai/codex-${process.platform}-arm64`;
  const packagePath = createRequire(import.meta.url).resolve(`${packageName}/package.json`);
  const upstreamPackage = JSON.parse(await readFile(packagePath, 'utf8'));
  if (upstreamPackage.version !== `${source.upstreamVersion}-${process.platform}-arm64`) throw new Error('Install the exact pinned Codex companion package before building.');
  const vendor = join(dirname(packagePath), 'vendor', triple);
  const vendorFiles = await files(vendor);
  const bwrap = vendorFiles.find((path) => path.endsWith('/bwrap'));
  if (process.platform === 'linux' && !bwrap) throw new Error('The pinned Linux runtime has no bundled bwrap.');
  const bwrapSha256 = bwrap ? digest(await readFile(bwrap)) : undefined;
  await run('cargo', ['build', '--locked', '--release', '--bin', 'codex'], join(checkout, 'codex-rs'), {
    ...process.env, CARGO_TARGET_DIR: target, CARGO_PROFILE_RELEASE_DEBUG: 'none', CARGO_INCREMENTAL: '0', CARGO_BUILD_JOBS: String(jobs),
    ...(bwrapSha256 ? { CODEX_BWRAP_SHA256: bwrapSha256 } : {}),
  });
  if (await verifySourceTree() !== patchedTree) throw new Error('Native source changed during compilation.');
  const { stdout: compilerVersion } = await promisify(execFile)('rustc', ['-vV'], { cwd: join(checkout, 'codex-rs') });
  const nativeTarget = compilerVersion.split('\n').find(line => line.startsWith('host: '))?.slice(6);
  if (!nativeTarget) throw new Error('Could not identify the native compiler target.');
  const runtime = join(buildRoot, 'runtime');
  await cp(vendor, runtime, { recursive: true });
  const descriptorPath = join(runtime, 'codex-package.json');
  const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8'));
  await writeFile(descriptorPath, JSON.stringify({ ...descriptor, target: nativeTarget }, null, 2) + '\n');
  const binary = join(runtime, 'bin/codex');
  await cp(join(target, 'release', 'codex'), binary);
  const sha256 = digest(await readFile(binary));
  const manifest = await Promise.all((await files(runtime)).map(async (path) => ({ path: relative(runtime, path), sha256: digest(await readFile(path)) })));
  await writeFile(join(buildRoot, 'artifact.json'), JSON.stringify({ source: JSON.parse(identity), build: { ...build, nativeTarget, patchedTree }, binary, sha256,
    platform: process.platform, arch: process.arch, upstreamPackage: { name: packageName, version: upstreamPackage.version }, files: manifest }, null, 2) + '\n');
  await run(binary, ['--version']);
  console.log(`Native artifact: ${binary}`);
}

async function verifySourceTree() {
  const temporary = await mkdtemp(join(buildRoot, 'source-audit-'));
  const env = { ...process.env, GIT_INDEX_FILE: join(temporary, 'index') };
  const git = async (args, environment = process.env) => (await promisify(execFile)('git', args, { cwd: checkout, env: environment, maxBuffer: 16 * 1024 * 1024 })).stdout;
  try {
    await git(['read-tree', source.revision], env);
    for (const patch of source.patches) await git(['apply', '--cached', join(definition, patch)], env);
    const expected = await git(['diff', '--no-ext-diff', '--binary', '--cached', source.revision], env);
    const actual = await git(['diff', '--no-ext-diff', '--binary', source.revision]);
    const extra = await git(['ls-files', '--others', '--exclude-standard']);
    if (actual !== expected || extra.trim()) throw new Error('Native checkout contains changes beyond the pinned patches. Use a clean dedicated build directory.');
    return (await git(['write-tree'], env)).trim();
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.sort((a, b) => a.name.localeCompare(b.name)).map((entry) => entry.isDirectory()
    ? files(join(directory, entry.name)) : [join(directory, entry.name)]))).flat();
}
