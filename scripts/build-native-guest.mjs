import { execFile, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { createHash } from 'node:crypto';
import { build, version as esbuildVersion } from 'esbuild';
import { validateCodexRuntimeArtifact } from './codex-runtime-artifact.mjs';
import { copyRegularFile, readRegularFile, regularFileChunks } from './native-build-files.mjs';
import { BASE_IMAGE, compareGuestInputs, digest, extractKernel, parseArguments, requireCheckedLock, validateGuestInputs } from './native-guest-inputs.mjs';
import { collectJavaScriptNotices, verifyJavaScriptNoticeArchive } from './javascript-notices.mjs';
import { verifyGuestArchive } from './native-guest-archive.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const execute = promisify(execFile);
const json = async path => JSON.parse((await readRegularFile(path)).toString('utf8'));
const writeJson = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });

async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of regularFileChunks(path)) hash.update(chunk);
  return hash.digest('hex');
}

function meter(limit) {
  let size = 0;
  return new Transform({ transform(chunk, _encoding, callback) {
    size += chunk.length;
    callback(size > limit ? new Error('Native build stream exceeds its byte limit.') : null, chunk);
  } });
}

function completed(child) {
  return new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => code === 0 ? resolveExit() : reject(new Error(`Native build process exited with ${signal ?? code}.`)));
  });
}

async function download(input, destination, localDirectory, filename) {
  if (localDirectory) {
    await copyRegularFile(join(localDirectory, filename), destination, input.maximumBytes);
  } else {
    const response = await fetch(input.url, { redirect: 'error', signal: AbortSignal.timeout(120_000) });
    if (!response.ok || !response.body) throw new Error(`Kernel input download failed: ${filename}.`);
    await pipeline(response.body, meter(input.maximumBytes), createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
  }
  if (await hashFile(destination) !== input.sha256) throw new Error(`Kernel input checksum differs from its lock: ${filename}.`);
}

async function nativeGuest(options) {
  const output = resolve(options.output);
  if (output === join(root, 'dist') || output.startsWith(join(root, 'dist') + '/')) throw new Error('Native guest outputs must survive ordinary dist cleanup.');
  const tracked = new Map();
  const sourceRecords = new Map();
  const readInput = async (filename, label, settings = {}) => {
    const bytes = await readRegularFile(filename, settings.maximumBytes);
    const sha256 = digest(bytes);
    if (tracked.has(filename) && tracked.get(filename) !== sha256) throw new Error(`Native source input changed: ${label}.`);
    tracked.set(filename, sha256);
    if (label) sourceRecords.set(label, { path: label, sha256 });
    return bytes;
  };
  const lockBytes = options.lock ? await readInput(resolve(options.lock)) : undefined;
  const lock = lockBytes ? requireCheckedLock(JSON.parse(lockBytes.toString('utf8'))) : undefined;
  const definitionRoot = resolve(options.definitionRoot ?? join(root, 'runtime/codex'));
  const artifactRoot = resolve(options.guestArtifact);
  const artifactBytes = await readInput(join(artifactRoot, 'artifact.json'));
  const artifact = await validateCodexRuntimeArtifact(artifactRoot, { expectedTarget: 'aarch64-unknown-linux-musl', definitionRoot });
  await readInput(join(definitionRoot, 'source.json'), 'codex-definition/source.json');
  await readInput(join(root, 'runtime/codex/companion-packages.json'), 'runtime/codex/companion-packages.json');
  const kernelBytes = await readInput(join(root, 'runtime/native/kernel-inputs.json'), 'runtime/native/kernel-inputs.json');
  const kernelInputs = JSON.parse(kernelBytes.toString('utf8'));
  const npmLockBytes = await readInput(join(root, 'package-lock.json'), 'package-lock.json');
  const npmLock = JSON.parse(npmLockBytes.toString('utf8'));
  if (npmLock.packages?.['node_modules/esbuild']?.version !== esbuildVersion) throw new Error('Native worker bundling requires the locked esbuild version.');
  await readInput(join(root, 'package.json'), 'package.json');
  for (const name of ['build-native-guest.mjs', 'native-guest-inputs.mjs', 'native-build-files.mjs', 'codex-runtime-artifact.mjs', 'codex-runtime-targets.mjs', 'javascript-notices.mjs', 'native-guest-archive.mjs']) await readInput(join(root, 'scripts', name), `scripts/${name}`);
  await mkdir(dirname(output), { recursive: true });
  const realParent = await realpath(dirname(output));
  if (realParent === join(root, 'dist') || realParent.startsWith(join(root, 'dist') + '/')) throw new Error('Native guest output resolves inside dist.');
  await mkdir(output, { mode: 0o700 });
  const context = await mkdtemp(join(tmpdir(), 'rat-native-context-'));
  let container;
  let docker;
  const failures = [];
  try {
    for (const [source, target] of [
      ['runtime/local/Dockerfile', 'Dockerfile'], ['runtime/native/guest.py', 'guest.py'], ['runtime/native/init.sh', 'init.sh'],
      ['runtime/native/archive-root.py', 'archive-root.py'], ['runtime/native/package-inventory.py', 'package-inventory.py'],
      ['runtime/native/install-kernel-modules.py', 'install-kernel-modules.py'], ['runtime/native/kernel-inputs.json', 'kernel-inputs.json'],
    ]) await writeFile(join(context, target), await readInput(join(root, source), source));
    const dockerfile = await readFile(join(context, 'Dockerfile'), 'utf8');
    if (!dockerfile.startsWith(`FROM ${BASE_IMAGE} AS worker-root\n`)) throw new Error('Native guest base does not match the maintained pinned base.');
    for (const file of artifact.files) {
      const bytes = await readInput(file.source);
      if (digest(bytes) !== file.sha256) throw new Error(`Codex artifact changed during staging: ${file.path}.`);
      const destination = join(context, 'codex-runtime', file.path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, bytes, { mode: file.mode });
      await chmod(destination, file.mode);
    }
    await writeFile(join(context, 'codex-runtime/artifact.json'), artifactBytes, { mode: 0o444 });
    await chmod(join(context, 'codex-runtime/artifact.json'), 0o444);
    const copyLicenses = async (directory, prefix) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await copyLicenses(join(directory, entry.name), path);
        else if (entry.isFile()) {
          const target = join(context, 'codex-runtime/licenses', path);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, await readInput(join(directory, entry.name), `runtime/codex/licenses/${path}`), { mode: 0o444 });
          await chmod(target, 0o444);
        } else throw new Error('Codex notices must be regular files.');
      }
    };
    await copyLicenses(join(root, 'runtime/codex/licenses'), '');
    const dependencies = new Map();
    const captureSources = { name: 'native-input-inventory', setup(builder) {
      builder.onLoad({ filter: /\.(?:[cm]?js|jsx|tsx?|json)$/ }, async ({ path }) => {
        const normalized = path.replaceAll('\\', '/');
        const modules = normalized.indexOf('/node_modules/');
        const label = modules === -1 ? relative(root, path) : normalized.slice(modules + 1);
        const bytes = await readInput(path, label);
        if (modules !== -1) {
          const segments = label.split('/');
          const packageIndex = segments.lastIndexOf('node_modules') + 1;
          const packageParts = segments.slice(0, packageIndex + (segments[packageIndex].startsWith('@') ? 2 : 1));
          const packagePath = packageParts.join('/');
          const installed = JSON.parse(await readInput(join(root, packagePath, 'package.json'), `${packagePath}/package.json`));
          const pinned = npmLock.packages[packagePath];
          if (!pinned || pinned.version !== installed.version || (pinned.name && pinned.name !== installed.name)) throw new Error(`Worker dependency differs from package-lock.json: ${packagePath}.`);
          dependencies.set(packagePath, { path: packagePath, name: installed.name, version: installed.version,
            resolved: pinned.resolved, integrity: pinned.integrity, license: installed.license ?? null });
        }
        const extension = extname(path).slice(1);
        return { contents: bytes, loader: ['ts', 'tsx', 'jsx', 'json'].includes(extension) ? extension : 'js' };
      });
    } };
    const bundleOptions = { absWorkingDir: root, bundle: true, platform: 'node', target: 'node22', format: 'esm', metafile: true,
      legalComments: 'eof', plugins: [captureSources], banner: { js: "import { createRequire as __ratRequire } from 'node:module'; const require = __ratRequire(import.meta.url);" } };
    const worker = await build({ ...bundleOptions, entryPoints: ['src/runner/local-worker-entry.ts'], outfile: join(context, 'local-worker.mjs') });
    await build({ ...bundleOptions, stdin: { contents: "export { WORKSPACE_EXPORT_SCRIPT } from './src/domain/workspace-transfer.ts';", resolveDir: root }, outfile: join(context, 'workspace-export.mjs') });
    const { WORKSPACE_EXPORT_SCRIPT } = await import(pathToFileURL(join(context, 'workspace-export.mjs')).href);
    if (typeof WORKSPACE_EXPORT_SCRIPT !== 'string') throw new Error('Workspace export script is missing.');
    await writeFile(join(context, 'export-workspace.cjs'), WORKSPACE_EXPORT_SCRIPT);
    const bundles = { workerSha256: await hashFile(join(context, 'local-worker.mjs')), workspaceExportSha256: digest(WORKSPACE_EXPORT_SCRIPT) };
    await execute(process.execPath, ['--check', join(context, 'local-worker.mjs')], { timeout: 30_000 });
    await execute(process.execPath, ['--check', join(context, 'export-workspace.cjs')], { timeout: 30_000 });
    const javascriptNotices = await collectJavaScriptNotices({ root, dependencies: [...dependencies.values()], lock: npmLock, surface: 'worker', readInput });
    for (const file of javascriptNotices.files) {
      const destination = join(context, 'worker-notices', file.path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, file.bytes, { flag: 'wx', mode: 0o444 }); await chmod(destination, 0o444);
    }
    await writeFile(join(output, 'worker-notices.json'), javascriptNotices.files[0].bytes, { flag: 'wx', mode: 0o600 });
    await writeJson(join(output, 'worker-dependencies.json'), [...dependencies.values()].sort((a, b) => a.path.localeCompare(b.path)));
    await writeJson(join(output, 'worker-metafile.json'), worker.metafile);
    await writeJson(join(output, 'worker-build.json'), { esbuild: esbuildVersion, bundles,
      options: { bundle: bundleOptions.bundle, platform: bundleOptions.platform, target: bundleOptions.target, format: bundleOptions.format,
        legalComments: bundleOptions.legalComments, banner: bundleOptions.banner, entryPoint: 'src/runner/local-worker-entry.ts' } });
    await mkdir(join(output, 'kernel-inputs'));
    await download(kernelInputs.vmlinuz, join(output, 'kernel-inputs/vmlinuz-virt'), options.kernelInputDirectory, 'vmlinuz-virt');
    await download(kernelInputs.modloop, join(context, 'modloop-virt'), options.kernelInputDirectory, 'modloop-virt');
    await copyFile(join(context, 'modloop-virt'), join(output, 'kernel-inputs/modloop-virt'));
    await writeFile(join(output, 'Image'), extractKernel(await readFile(join(output, 'kernel-inputs/vmlinuz-virt')), kernelInputs), { flag: 'wx', mode: 0o600 });
    const endpoint = !process.env.DOCKER_CONTEXT && process.env.DOCKER_HOST
      || JSON.parse((await execute('docker', ['context', 'inspect'], { timeout: 10_000 })).stdout)[0]?.Endpoints?.docker?.Host;
    if (typeof endpoint !== 'string' || !/^unix:\/\/\//.test(endpoint) || new URL(endpoint).hostname) throw new Error('Native guest builds require a local Docker Unix socket.');
    const { DOCKER_CONTEXT: _context, DOCKER_HOST: _host, BUILDX_BUILDER: _builder, ...environment } = process.env;
    docker = async (args, timeout = 30_000) => (await execute('docker', ['--host', endpoint, ...args], { env: environment, timeout, maxBuffer: 32 * 1024 ** 2 })).stdout;
    const index = JSON.parse(await docker(['buildx', 'imagetools', 'inspect', BASE_IMAGE, '--raw']));
    const platform = index.manifests?.find(item => item.platform?.os === 'linux' && item.platform?.architecture === 'arm64');
    const arm64ManifestDigest = platform?.digest ?? BASE_IMAGE.slice(BASE_IMAGE.indexOf('@') + 1);
    const manifest = platform ? JSON.parse(await docker(['buildx', 'imagetools', 'inspect', `${BASE_IMAGE.split('@')[0]}@${arm64ManifestDigest}`, '--raw'])) : index;
    const base = { reference: BASE_IMAGE, arm64ManifestDigest, configDigest: manifest.config?.digest };
    if (index.manifests && !platform) throw new Error('Pinned base has no Linux ARM64 image.');
    await writeJson(join(output, 'base-image.json'), { base, index, manifest });
    await writeJson(join(output, 'docker-version.json'), JSON.parse(await docker(['version', '--format', '{{json .}}'])));
    const imageIdFile = join(context, 'image-id');
    const buildArguments = ['build', '--builder', 'default', '--pull', '--no-cache', '--platform', 'linux/arm64', '--target', 'native-root', '--iidfile', imageIdFile, context];
    console.log('Building a fresh native guest from the checked Codex package and pinned base.');
    try {
      const result = await execute('docker', ['--host', endpoint, ...buildArguments], { env: environment, timeout: 900_000, maxBuffer: 32 * 1024 ** 2 });
      await writeFile(join(output, 'build.log'), result.stdout + result.stderr, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      try { await writeFile(join(output, 'build.log'), `${error.stdout ?? ''}${error.stderr ?? ''}`, { flag: 'wx', mode: 0o600 }); }
      catch (writeError) { throw new AggregateError([error, writeError], error.message, { cause: error }); }
      throw error;
    }
    const imageId = (await readFile(imageIdFile, 'utf8')).trim();
    if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error('Native build did not produce an exact image ID.');
    const inspected = JSON.parse(await docker(['image', 'inspect', imageId]))[0];
    if (inspected.Id !== imageId || inspected.Architecture !== 'arm64' || inspected.Os !== 'linux') throw new Error('Built native root is not the exact Linux ARM64 image.');
    container = (await docker(['create', '--network', 'none', '--log-driver', 'none', '--entrypoint', '/usr/bin/python3', imageId,
      '/opt/rat-build-tools/archive-root.py', '/', '--normalize', '--source-date-epoch', String(options.sourceDateEpoch),
      '--inventory', '/opt/rat-build-evidence/archive-inventory.json'])).trim();
    if (!/^[a-f0-9]{64}$/.test(container)) throw new Error('Native export container ID is invalid.');
    await mkdir(join(output, 'evidence'));
    await docker(['cp', `${container}:/opt/rat-build-evidence/.`, join(output, 'evidence')], 120_000);
    await writeFile(join(output, 'evidence/codex-artifact.json'), artifactBytes, { flag: 'wx', mode: 0o600 });
    const inputs = validateGuestInputs({ base, bundles, sourceDateEpoch: options.sourceDateEpoch, javascriptNoticesSha256: digest(javascriptNotices.files[0].bytes),
      kernelInputsSha256: digest(kernelBytes), codexArtifactSha256: digest(artifactBytes),
      sources: [...sourceRecords.values()].sort((a, b) => a.path.localeCompare(b.path)),
      transactions: { worker: await json(join(output, 'evidence/worker/inventory.json')), native: await json(join(output, 'evidence/native/inventory.json')) },
      kernelModulesSha256: await hashFile(join(output, 'evidence/kernel.json')) });
    await writeJson(join(output, 'observed-inputs.json'), inputs);
    if (lock) compareGuestInputs(lock, inputs);
    console.log('Exporting the newly built image with normalized guest state.');
    const exported = spawn('docker', ['--host', endpoint, 'start', '--attach', container], { env: environment, shell: false, stdio: ['ignore', 'pipe', 'inherit'] });
    const deadline = setTimeout(() => exported.kill('SIGKILL'), 180_000);
    try {
      await Promise.all([completed(exported), pipeline(exported.stdout, meter(1400 * 1024 ** 2), createGzip({ level: 6 }),
        meter(600 * 1024 ** 2), createWriteStream(join(output, 'worker-initramfs.gz'), { flags: 'wx', mode: 0o600 }))]);
    } finally {
      clearTimeout(deadline);
      if (exported.exitCode === null) exported.kill('SIGKILL');
    }
    await docker(['cp', `${container}:/opt/rat-build-evidence/archive-inventory.json`, join(output, 'archive-inventory.json')], 120_000);
    for (const [filename, expected] of tracked) if (await hashFile(filename) !== expected) throw new Error(`Native input changed during the build: ${filename}.`);
    await javascriptNotices.verifyDirectories();
    const archive = await json(join(output, 'archive-inventory.json'));
    await verifyGuestArchive(join(output, 'worker-initramfs.gz'), archive);
    verifyJavaScriptNoticeArchive(javascriptNotices.index, archive.entries, inputs.javascriptNoticesSha256);
    for (const path of ['workspace', 'home/agent/.codex']) {
      const entry = archive.entries.find(entry => entry.path === path);
      if (entry?.uid !== 10001 || entry.gid !== 10001 || (entry.mode & 0o777) !== 0o700) throw new Error(`Native agent directory lost its private UID/GID 10001 boundary: ${path}.`);
    }
    for (const [path, source] of [['init', 'init.sh'], ['opt/rat-things/native-guest.py', 'guest.py'], ['opt/rat-things/local-worker.mjs', 'local-worker.mjs'], ['opt/rat-things/export-workspace.cjs', 'export-workspace.cjs']]) {
      if (archive.entries.find(entry => entry.path === path)?.sha256 !== await hashFile(join(context, source))) throw new Error(`Native archive has an incorrect maintained payload: ${path}.`);
    }
    for (const file of artifact.files) {
      const entry = archive.entries.find(entry => entry.path === `opt/codex-runtime/${file.path}`);
      if (entry?.sha256 !== file.sha256 || (entry.mode & 0o777) !== file.mode) throw new Error(`Native archive has an incorrect Codex package member: ${file.path}.`);
    }
    if (!lock) await writeJson(join(output, 'candidate-lock.json'), { schemaVersion: 1, status: 'candidate', inputs });
    else await writeFile(join(output, 'checked-lock.json'), lockBytes, { flag: 'wx', mode: 0o600 });
    await writeJson(join(output, 'guest-build.json'), { schemaVersion: 1, status: lock ? 'inputs-checked' : 'candidate', distributionReady: false,
      reproducibility: 'not-established', imageId, inputsSha256: await hashFile(join(output, 'observed-inputs.json')),
      lockSha256: lockBytes ? digest(lockBytes) : null, sourceDateEpoch: options.sourceDateEpoch, gzipMtime: 0,
      toolchain: { node: process.version, zlib: process.versions.zlib, esbuild: esbuildVersion },
      buildArguments: buildArguments.slice(0, -3).concat(['--iidfile', '<temporary-image-id>', '<fresh-context>']),
      artifacts: await Promise.all(['Image', 'worker-initramfs.gz', 'archive-inventory.json', 'worker-dependencies.json', 'worker-notices.json', 'worker-metafile.json', 'worker-build.json', 'build.log'].map(async path => ({ path, bytes: (await lstat(join(output, path))).size, sha256: await hashFile(join(output, path)) }))),
      outstandingDistributionInputs: ['AL2023 corresponding source RPMs and notices', 'Alpine immutable source recipe, configuration, patches, source archives and license',
        'Codex companion and linked native dependency sources and notices', 'two independent unsigned builds and inventory comparison', 'signed runtime assembly and installed acceptance'] });
  } catch (error) {
    failures.push(error);
    try { await writeJson(join(output, 'failed-build.json'), { status: 'failed', message: error.message }); }
    catch (writeError) { failures.push(writeError); }
  } finally {
    try { if (container && docker) await docker(['rm', '--force', container]); }
    catch (cleanupError) { failures.push(cleanupError); }
    try { await rm(context, { recursive: true, force: true }); }
    catch (cleanupError) { failures.push(cleanupError); }
  }
  if (failures.length > 1) throw new AggregateError(failures, failures[0].message, { cause: failures[0] });
  if (failures.length === 1) throw failures[0];
  console.log(`Prepared native guest ${lock ? 'with checked inputs' : 'candidate'}: ${output}`);
}

await nativeGuest(parseArguments(process.argv.slice(2)));
