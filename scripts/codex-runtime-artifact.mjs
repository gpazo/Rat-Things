import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

/** Accept only the complete Linux artifact for the current native source patch. */
export async function codexRuntimeEntries(artifactRoot = process.env.CODEX_RUNTIME_ARTIFACT ?? join(root, '.runtime/codex/linux-arm64')) {
  const manifestPath = join(artifactRoot, 'artifact.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8').catch(error => {
    if (error.code === 'ENOENT') throw new Error('Build the Linux ARM64 Codex runtime first; set CODEX_RUNTIME_ARTIFACT to its exported directory. See testing/README.md.');
    throw error;
  }));
  const definition = join(root, 'runtime/codex');
  const source = JSON.parse(await readFile(join(definition, 'source.json'), 'utf8'));
  const patches = await Promise.all(source.patches.map(async name => ({ name, sha256: digest(await readFile(join(definition, name))) })));
  if (manifest.platform !== 'linux' || manifest.arch !== 'arm64'
    || JSON.stringify(manifest.source) !== JSON.stringify({ ...source, patches })) throw new Error('Codex runtime does not match the pinned Linux ARM64 source and patches.');
  if (manifest.upstreamPackage?.name !== '@openai/codex-linux-arm64'
    || manifest.upstreamPackage.version !== `${source.upstreamVersion}-linux-arm64`
    || manifest.build?.nativeTarget !== 'aarch64-unknown-linux-gnu'
    || manifest.build.locked !== true || !/^[a-f0-9]{40}$/.test(manifest.build.patchedTree ?? '')) {
    throw new Error('Codex runtime build provenance is incomplete or incompatible.');
  }
  if (!Array.isArray(manifest.files)) throw new Error('Codex runtime file manifest is missing.');
  const paths = manifest.files.map(file => file.path);
  if (paths.some(path => typeof path !== 'string' || !path || path.startsWith('/') || path.includes('\\') || path.includes('\0') || path.split('/').some(part => part === '..' || part === '.' || part === ''))
    || new Set(paths).size !== paths.length) throw new Error('Invalid Codex runtime artifact paths.');
  if (!['bin/codex', 'bin/codex-code-mode-host', 'codex-package.json', 'codex-path/rg'].every(path => paths.includes(path))
    || !paths.some(path => path.startsWith('codex-resources/') && path.endsWith('/bwrap'))) throw new Error('Codex runtime companions are incomplete.');
  const entries = [];
  for (const file of manifest.files) {
    const path = join(artifactRoot, 'runtime', file.path);
    const bytes = await readFile(path);
    if (digest(bytes) !== file.sha256) throw new Error(`Codex runtime checksum mismatch: ${file.path}`);
    if (file.path === 'bin/codex' && file.sha256 !== manifest.sha256) throw new Error('Codex runtime entrypoint digest does not match its manifest.');
    if (file.path === 'codex-package.json') {
      const descriptor = JSON.parse(bytes.toString('utf8'));
      if (descriptor.layoutVersion !== 1 || descriptor.version !== source.upstreamVersion
        || descriptor.target !== manifest.build.nativeTarget || descriptor.variant !== 'codex'
        || descriptor.entrypoint !== 'bin/codex' || descriptor.resourcesDir !== 'codex-resources'
        || descriptor.pathDir !== 'codex-path') throw new Error('Codex runtime package descriptor does not match the compiled runtime.');
    }
    if (['bin/codex', 'bin/codex-code-mode-host', 'codex-path/rg'].includes(file.path) || file.path.endsWith('/bwrap')) {
      if (bytes.length < 20 || bytes.subarray(0, 4).toString('hex') !== '7f454c46' || bytes[4] !== 2 || bytes[5] !== 1 || bytes.readUInt16LE(18) !== 183) throw new Error(`Codex runtime executable is not Linux ARM64: ${file.path}`);
    }
    entries.push({ source: path, target: `codex-runtime/${file.path}`, mode: file.path.endsWith('.json') ? 0o444 : 0o755 });
  }
  return [...entries, { source: manifestPath, target: 'codex-runtime/artifact.json', mode: 0o444 }];
}
