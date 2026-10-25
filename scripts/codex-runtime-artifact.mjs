import { lstat, open, readdir, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { codexRuntimeTargets } from './codex-runtime-targets.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const definition = join(root, 'runtime/codex');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const validPath = path => typeof path === 'string' && path.length > 0 && !path.startsWith('/')
  && !path.includes('\\') && !path.includes('\0') && !path.split('/').some(part => part === '..' || part === '.' || part === '');
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));

/**
 * @typedef {object} CodexArtifactOptions
 * @property {string} [expectedTarget]
 * @property {string} [definitionRoot]
 * @property {string} [expectedPatchedTree] Trusted expected tree, never taken from the artifact.
 * @property {string} [packageLockPath]
 * @property {string} [companionInventoryPath]
 */

/**
 * Validate an unsigned runtime against a trusted source definition and npm companion inventory.
 * @param {string} artifactRoot
 * @param {CodexArtifactOptions} options
 */
export async function validateCodexRuntimeArtifact(artifactRoot, {
  expectedTarget,
  definitionRoot = definition,
  expectedPatchedTree,
  packageLockPath = join(root, 'package-lock.json'),
  companionInventoryPath = join(definition, 'companion-packages.json'),
} = {}) {
  const target = Object.values(codexRuntimeTargets).find(target => target.nativeTarget === expectedTarget);
  if (!target) throw new Error('An explicit supported Codex runtime target is required.');
  const manifestPath = join(artifactRoot, 'artifact.json');
  const manifest = JSON.parse((await readRegularFile(manifestPath)).toString('utf8'));
  const source = await readJson(join(definitionRoot, 'source.json'));
  const patches = await Promise.all(source.patches.map(async name => {
    if (!validPath(name)) throw new Error('Invalid Codex source patch path.');
    return { name, sha256: digest(await readFile(join(definitionRoot, name))) };
  }));
  const sourceIdentity = { ...source, patches };
  if (!isDeepStrictEqual(manifest.source, sourceIdentity)) throw new Error('Codex runtime does not match the pinned source and ordered patches.');
  if (expectedPatchedTree === undefined) {
    const policy = await readJson(join(definitionRoot, 'artifact-policy.json'));
    if (policy.sourceSha256 !== digest(JSON.stringify(sourceIdentity))) throw new Error('Codex artifact policy does not match the source and ordered patches.');
    expectedPatchedTree = policy.patchedTree;
  }
  if (!/^[a-f0-9]{40}$/.test(expectedPatchedTree ?? '')
    || manifest.platform !== target.platform || manifest.arch !== target.arch
    || manifest.build?.nativeTarget !== expectedTarget || manifest.build.patchedTree !== expectedPatchedTree
    || manifest.build.profile !== 'release' || manifest.build.debug !== 'none'
    || manifest.build.incremental !== false || manifest.build.locked !== true
    || !Number.isSafeInteger(manifest.build.jobs) || manifest.build.jobs < 1) {
    throw new Error('Codex runtime build provenance is incomplete or incompatible.');
  }
  const lock = await readJson(packageLockPath);
  const packageLock = lock.packages?.[`node_modules/${target.packageName}`];
  const companions = (await readJson(companionInventoryPath))[target.packageName];
  if (!packageLock || !companions || companions.name !== packageLock.name
    || companions.version !== packageLock.version || companions.resolved !== packageLock.resolved
    || companions.integrity !== packageLock.integrity || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(companions.integrity)
    || packageLock.version !== `${source.upstreamVersion}-${target.platform}-${target.arch}`
    || !isDeepStrictEqual(manifest.upstreamPackage, { name: target.packageName, version: packageLock.version })) {
    throw new Error('Codex runtime companions do not match the pinned npm package.');
  }
  const expectedDescriptor = { ...companions.descriptor, target: expectedTarget };
  if (expectedDescriptor.layoutVersion !== 1 || expectedDescriptor.version !== source.upstreamVersion
    || expectedDescriptor.variant !== 'codex' || expectedDescriptor.entrypoint !== 'bin/codex'
    || expectedDescriptor.resourcesDir !== 'codex-resources' || expectedDescriptor.pathDir !== 'codex-path') {
    throw new Error('Pinned Codex package descriptor is incompatible.');
  }
  const declared = inventory(manifest.files);
  const pinned = inventory(companions.files);
  if (!samePaths(declared.keys(), pinned.keys())) throw new Error('Codex runtime companions are incomplete or unexpected.');
  const runtimeRoot = join(artifactRoot, 'runtime');
  await requireDirectory(artifactRoot);
  const actualPaths = await runtimeFiles(runtimeRoot);
  if (!samePaths(actualPaths, declared.keys())) throw new Error('Codex runtime inventory has missing or unlisted files.');
  const files = [];
  for (const [path, file] of declared) {
    const filename = join(runtimeRoot, path);
    const bytes = await readRegularFile(filename);
    if (digest(bytes) !== file.sha256) throw new Error(`Codex runtime checksum mismatch: ${path}`);
    if (path === 'bin/codex' && file.sha256 !== manifest.sha256) throw new Error('Codex runtime entrypoint digest does not match its manifest.');
    const companion = pinned.get(path);
    if (path === 'codex-package.json') {
      if (!isDeepStrictEqual(JSON.parse(bytes.toString('utf8')), expectedDescriptor)) throw new Error('Codex runtime package descriptor does not match the compiled runtime.');
      const expectedHash = target.platform === 'linux' ? digest(JSON.stringify(expectedDescriptor, null, 2) + '\n') : companion.sha256;
      if (file.sha256 !== expectedHash) throw new Error('Codex runtime package descriptor differs from the pinned package.');
    } else if (path !== 'bin/codex' && file.sha256 !== companion.sha256) {
      throw new Error(`Codex runtime companion differs from the pinned npm package: ${path}`);
    }
    if (path === 'bin/codex' || companion.executable) {
      // Only the rebuilt entrypoint can differ from the trusted package bytes.
      // Companions include shared libraries and data with executable file modes.
      if (path === 'bin/codex' && !isExecutable(bytes, target)) throw new Error(`Codex runtime executable is not ${target.platform} ${target.arch.toUpperCase()}: ${path}`);
      if (!((await lstat(filename)).mode & 0o111)) throw new Error(`Codex runtime executable permission is missing: ${path}`);
    }
    files.push({ path, source: filename, sha256: file.sha256, mode: companion.executable ? 0o755 : 0o444 });
  }
  return { manifest, manifestPath, runtimeRoot, files };
}

/**
 * Accept only the complete Linux artifact for Lambda and container packaging.
 * @param {string} artifactRoot
 * @param {CodexArtifactOptions} options
 */
export async function codexRuntimeEntries(artifactRoot = process.env.CODEX_RUNTIME_ARTIFACT ?? join(root, '.runtime/codex/linux-arm64'), options = {}) {
  const artifact = await validateCodexRuntimeArtifact(artifactRoot, { ...options, expectedTarget: 'aarch64-unknown-linux-gnu' }).catch(error => {
    if (error.code === 'ENOENT' && error.path === join(artifactRoot, 'artifact.json')) throw new Error('Build the Linux ARM64 Codex runtime first; set CODEX_RUNTIME_ARTIFACT to its exported directory. See testing/README.md.');
    throw error;
  });
  return [...artifact.files.map(file => ({ source: file.source, target: `codex-runtime/${file.path}`, mode: file.mode })),
    { source: artifact.manifestPath, target: 'codex-runtime/artifact.json', mode: 0o444 }];
}

function inventory(files) {
  if (!Array.isArray(files)) throw new Error('Codex runtime file manifest is missing.');
  const entries = new Map();
  for (const file of files) {
    if (!file || !validPath(file.path) || entries.has(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256 ?? '')) throw new Error('Invalid Codex runtime artifact paths or hashes.');
    entries.set(file.path, file);
  }
  return entries;
}

function samePaths(left, right) {
  return isDeepStrictEqual([...left].sort(), [...right].sort());
}

async function requireDirectory(path) {
  if (!(await lstat(path)).isDirectory()) throw new Error(`Codex runtime directory is not a regular directory: ${path}`);
}

async function runtimeFiles(directory, prefix = '') {
  await requireDirectory(directory);
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length === 0) throw new Error(`Codex runtime contains an unlisted empty directory: ${prefix}`);
  const paths = [];
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (!validPath(path)) throw new Error('Invalid Codex runtime artifact paths.');
    if (entry.isDirectory()) paths.push(...await runtimeFiles(join(directory, entry.name), path));
    else if (entry.isFile()) paths.push(path);
    else throw new Error(`Codex runtime contains a symlink or special file: ${path}`);
  }
  return paths;
}

async function readRegularFile(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) throw new Error(`Codex runtime entry is not a regular file: ${path}`);
    return await handle.readFile();
  } finally { await handle.close(); }
}

function isExecutable(bytes, target) {
  if (target.platform === 'darwin') return bytes.length >= 32 && bytes.readUInt32LE(0) === 0xfeedfacf
    && bytes.readUInt32LE(4) === 0x100000c && bytes.readUInt32LE(12) === 2;
  return bytes.length >= 64 && bytes.subarray(0, 4).toString('hex') === '7f454c46'
    && bytes[4] === 2 && bytes[5] === 1 && bytes[6] === 1
    && [2, 3].includes(bytes.readUInt16LE(16)) && bytes.readUInt16LE(18) === target.elfMachine
    && bytes.readUInt32LE(20) === 1 && bytes.readUInt16LE(52) === 64;
}
