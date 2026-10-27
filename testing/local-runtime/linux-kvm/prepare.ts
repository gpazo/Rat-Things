import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, statfs, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { validateCodexRuntimeArtifact } from '../../../scripts/codex-runtime-artifact.mjs';
import { WORKSPACE_EXPORT_SCRIPT } from '../../../src/domain/workspace-transfer.js';

const execute = promisify(execFile);
const target = 'x86_64-unknown-linux-gnu';
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const cleanEnvironment = { PATH: '/usr/bin:/bin', LC_ALL: 'C' };
const missing = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT';
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8')) as unknown;
const writeJson = (path: string, value: unknown) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const inside = (root: string, path: string) => path === root || path.startsWith(root + '/');

export async function hashFile(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await file.stat()).isFile()) throw new Error(`Expected a regular file: ${path}`);
    const hash = createHash('sha256');
    for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
    return hash.digest('hex');
  } finally { await file.close(); }
}

export function libraryDependencies(output: string): string[] {
  const paths = new Set<string>();
  for (const line of output.trim().split('\n').map(line => line.trim()).filter(Boolean)) {
    if (/=> not found|error while loading|cannot open shared object/.test(line)) throw new Error(`Unresolved QEMU dependency: ${line}`);
    if (/^(linux-vdso\.so\.\d+ \(0x[\da-f]+\)|statically linked|not a dynamic executable)$/.test(line)) continue;
    const match = /^(?:\S+ => )?(\/[^\0]+?) \(0x[\da-f]+\)$/.exec(line);
    if (!match?.[1]) throw new Error(`Unrecognized loader dependency: ${line}`);
    paths.add(match[1]);
  }
  return [...paths].sort();
}

/** Materialize only ordinary files, with symlinks confined to the selected tool root. */
export async function materializeTree(root: string, source: string, destination: string, ancestors: readonly string[] = []): Promise<void> {
  const canonical = await realpath(source);
  if (!inside(root, canonical) || ancestors.includes(canonical)) throw new Error('QEMU input symlink escapes its root or forms a cycle');
  const info = await lstat(canonical);
  if (info.isDirectory()) {
    await mkdir(destination, { recursive: true, mode: 0o700 });
    for (const name of (await readdir(canonical)).sort()) await materializeTree(root, join(canonical, name), join(destination, name), [...ancestors, canonical]);
  } else if (info.isFile()) {
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await copyFile(canonical, destination, constants.COPYFILE_EXCL);
    await chmod(destination, info.mode & 0o111 ? 0o700 : 0o600);
  } else throw new Error('QEMU inputs must be regular files or directories');
}

export async function regularInventory(root: string, directory = root): Promise<{ path: string; sha256: string }[]> {
  const result: { path: string; sha256: string }[] = [];
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name), info = await lstat(path);
    if (info.isDirectory()) result.push(...await regularInventory(root, path));
    else if (info.isFile()) result.push({ path: relative(root, path), sha256: await hashFile(path) });
    else throw new Error('Sealed QEMU inventory contains a symlink or special file');
    if (result.length > 20000) throw new Error('QEMU inventory exceeds 20000 files');
  }
  return result;
}

async function elf(path: string): Promise<boolean> {
  const file = await open(path, 'r');
  try { const bytes = Buffer.alloc(20); await file.read(bytes, 0, bytes.length, 0);
    if (bytes.toString('hex', 0, 4) !== '7f454c46') return false;
    if (bytes[4] !== 2 || bytes[5] !== 1 || bytes.readUInt16LE(18) !== 62) throw new Error('QEMU closure contains a non-x86-64 ELF file');
    return true;
  } finally { await file.close(); }
}

export async function sealQemu(sourceRoot: string, output: string) {
  const source = await realpath(sourceRoot), qemu = join(output, 'qemu'), libraries = join(qemu, 'usr/lib');
  await mkdir(libraries, { recursive: true, mode: 0o700 });
  for (const path of ['usr/bin/qemu-system-x86_64', 'usr/lib/qemu', 'usr/share/qemu']) await materializeTree(source, join(source, path), join(qemu, path));
  const origins: { path: string; source: string; sha256: string }[] = [];
  // Firmware can be a guest ELF for another architecture; only host code needs ldd.
  const queue = (await regularInventory(qemu)).filter(file => file.path.startsWith('usr/bin/') || file.path.startsWith('usr/lib/')).map(file => join(qemu, file.path));
  const checked = new Set<string>();
  while (queue.length) {
    const path = queue.shift()!;
    if (checked.has(path) || !await elf(path)) continue;
    checked.add(path);
    const { stdout } = await execute('/usr/bin/ldd', [path], { env: { ...cleanEnvironment, LD_LIBRARY_PATH: join(source, 'usr/lib') }, timeout: 10_000 });
    for (const dependency of libraryDependencies(stdout)) {
      const original = await realpath(dependency), name = basename(dependency), destination = join(libraries, name), sha256 = await hashFile(original);
      if (!/^[A-Za-z0-9_.+-]+$/.test(name)) throw new Error('Invalid library filename');
      try {
        if (await hashFile(destination) !== sha256) throw new Error(`Conflicting QEMU dependency: ${name}`);
      } catch (error) {
        if (!missing(error)) throw error;
        await copyFile(original, destination, constants.COPYFILE_EXCL); await chmod(destination, 0o700);
        origins.push({ path: relative(output, destination), source: inside(source, original) ? `package:${relative(source, original)}` : original, sha256 });
        queue.push(destination);
      }
    }
  }
  const loader = join(libraries, 'ld-linux-x86-64.so.2');
  if (!await elf(loader)) throw new Error('QEMU requires a sealed x86-64 ELF loader');
  for (const path of checked) {
    const { stdout } = await execute(loader, ['--inhibit-cache', '--library-path', libraries, '--list', path], { env: cleanEnvironment, timeout: 10_000 });
    if (libraryDependencies(stdout).some(path => !inside(qemu, path))) throw new Error(`QEMU dependency escaped the sealed library path: ${path}`);
  }
  const version = (await execute(loader, ['--inhibit-cache', '--library-path', libraries, join(qemu, 'usr/bin/qemu-system-x86_64'), '--version'],
    { env: { ...cleanEnvironment, QEMU_MODULE_DIR: join(libraries, 'qemu') }, timeout: 10_000 })).stdout.trim();
  const files = (await regularInventory(qemu)).map(file => ({ ...file, path: `qemu/${file.path}` }));
  return { files, origins, version };
}

export async function materializeVerifiedQemuPackages(evidencePath: string, destination: string, snapshots: string) {
  const packages = await json(evidencePath);
  if (!Array.isArray(packages) || !packages.length || packages.length > 100) throw new Error('Missing QEMU package evidence');
  await mkdir(destination, { mode: 0o700 }); await mkdir(snapshots, { mode: 0o700 });
  const keyring = join(snapshots, 'archlinux.gpg');
  const publicKeys = await readFile('/usr/share/pacman/keyrings/archlinux.gpg');
  if (publicKeys.toString('ascii', 0, 64).startsWith('-----BEGIN PGP PUBLIC KEY BLOCK-----')) {
    await execute('gpg', ['--batch', '--dearmor', '--output', keyring, '/usr/share/pacman/keyrings/archlinux.gpg'], { env: cleanEnvironment, timeout: 30_000 });
  } else await writeFile(keyring, publicKeys, { flag: 'wx', mode: 0o600 });
  await chmod(keyring, 0o600);
  const verified = [];
  for (const [index, value] of packages.entries()) {
    if (!value || typeof value !== 'object' || typeof value.path !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) throw new Error('Invalid QEMU package evidence');
    const item = value as { path: string; sha256: string };
    const info = await lstat(item.path);
    if (!info.isFile() || info.size > 256 * 1024 ** 2) throw new Error('QEMU package is not a bounded regular file');
    const archive = join(snapshots, `${index}-${basename(item.path)}`);
    await copyFile(item.path, archive, constants.COPYFILE_EXCL); await chmod(archive, 0o600);
    await copyFile(`${item.path}.sig`, `${archive}.sig`, constants.COPYFILE_EXCL); await chmod(`${archive}.sig`, 0o600);
    if (await hashFile(archive) !== item.sha256) throw new Error('QEMU package checksum differs from its evidence');
    const signature = await execute('gpgv', ['--keyring', keyring, `${archive}.sig`, archive], { env: cleanEnvironment, timeout: 30_000 });
    const listing = (await execute('tar', ['-tf', archive], { env: cleanEnvironment, timeout: 30_000, maxBuffer: 8 * 1024 ** 2 })).stdout;
    if (listing.split('\n').filter(Boolean).some(path => path.startsWith('/') || path.split('/').includes('..'))) throw new Error('Unsafe package archive path');
    await execute('tar', ['-xf', archive, '--directory', destination, '--no-same-owner', '--no-same-permissions'], { env: cleanEnvironment, timeout: 30_000 });
    verified.push({ ...item, snapshot: basename(archive), keyringSha256: await hashFile(keyring), signatureSha256: await hashFile(`${archive}.sig`), verification: signature.stderr });
  }
  return verified;
}

export function workerImage(value: unknown): { id: string } {
  const image = Array.isArray(value) && value.length === 1 ? value[0] as Record<string, unknown> : undefined;
  if (!image || image.Os !== 'linux' || image.Architecture !== 'amd64' || typeof image.Id !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(image.Id)) {
    throw new Error('Linux KVM preparation requires an immutable local linux/amd64 worker image');
  }
  return { id: image.Id };
}

export function validateKernel(bytes: Buffer): void {
  if (bytes.length < 0x238 || bytes.toString('ascii', 0x202, 0x206) !== 'HdrS' || bytes.readUInt16LE(0x1fe) !== 0xaa55 || !(bytes.readUInt16LE(0x236) & 1)) {
    throw new Error('Expected an x86-64 bzImage kernel');
  }
}

interface Options { output: string; image: string; artifact: string; kernelInputs: string; qemuEvidence: string }
interface KernelLock { release: string; vmlinuz: Input; modloop: Input; configuration: Input }
interface Input { sha256: string; maximumBytes: number }
function meter(limit: number) {
  let size = 0;
  return new Transform({ transform(chunk: Buffer, _encoding, callback) {
    size += chunk.length; callback(size > limit ? new Error('Linux guest archive exceeds its byte limit') : null, chunk);
  } });
}

export async function prepareLinuxKvm(options: Options): Promise<string> {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Linux KVM preparation requires x86-64 Linux');
  const artifact = await validateCodexRuntimeArtifact(resolve(options.artifact), { expectedTarget: 'x86_64-unknown-linux-musl' });
  const endpoint = !process.env.DOCKER_CONTEXT && process.env.DOCKER_HOST
    || (JSON.parse((await execute('docker', ['context', 'inspect'])).stdout)[0]?.Endpoints?.docker?.Host as unknown);
  if (typeof endpoint !== 'string' || !endpoint.startsWith('unix:///')) throw new Error('Preparation requires a local Docker Unix socket');
  const { DOCKER_CONTEXT: _context, DOCKER_HOST: _host, ...environment } = process.env;
  const docker = (args: string[], timeout = 30_000) => execute('docker', ['--host', endpoint, ...args], { env: environment, timeout, maxBuffer: 8 * 1024 ** 2 });
  const image = workerImage(JSON.parse((await docker(['image', 'inspect', options.image])).stdout));
  const output = resolve(options.output);
  await mkdir(output, { recursive: true, mode: 0o700 });
  if ((await lstat(output)).isSymbolicLink()) throw new Error('Linux KVM output cannot be a symlink');
  await chmod(output, 0o700);
  const space = await statfs(output);
  if (space.bavail * space.bsize < 3 * 1024 ** 3) throw new Error('Linux KVM preparation requires 3 GiB free disk');
  const staging = await mkdtemp(join(output, '.prepare-')), evidence = join(staging, 'evidence');
  await mkdir(evidence, { mode: 0o700 });
  const container = `rat-linux-kvm-builder-${randomUUID()}`;
  let created = false;
  try {
    const sourceFiles = ['testing/local-runtime/linux-kvm/prepare.ts', 'testing/local-runtime/linux-kvm/init.sh', 'testing/local-runtime/linux-kvm/kernel-inputs.json',
      'runtime/linux-kvm/rat-linux-worker', 'runtime/native/guest.py', 'runtime/native/archive-root.py', 'runtime/native/install-kernel-modules.py', 'runtime/native/package-inventory.py'];
    const sourceRecords = [];
    for (const path of sourceFiles) {
      const destination = join(evidence, 'source', path); await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await copyFile(path, destination, constants.COPYFILE_EXCL); sourceRecords.push({ path, sha256: await hashFile(destination) });
    }
    const source = (path: string) => join(evidence, 'source', path);
    const lock = await json(source('testing/local-runtime/linux-kvm/kernel-inputs.json')) as KernelLock;
    for (const [name, pin] of [['vmlinuz-virt', lock.vmlinuz], ['modloop-virt', lock.modloop], [`config-${lock.release}`, lock.configuration]] as const) {
      const input = join(options.kernelInputs, name), info = await lstat(input);
      if (!info.isFile() || info.size > pin.maximumBytes || await hashFile(input) !== pin.sha256) throw new Error(`Kernel input differs from its lock: ${name}`);
      await copyFile(input, join(evidence, name), constants.COPYFILE_EXCL);
    }
    const kernel = await readFile(join(evidence, 'vmlinuz-virt')); validateKernel(kernel);
    await copyFile(join(evidence, 'vmlinuz-virt'), join(staging, 'Image'));
    await copyFile(source('runtime/linux-kvm/rat-linux-worker'), join(staging, 'rat-linux-worker')); await chmod(join(staging, 'rat-linux-worker'), 0o700);
    const packageRoot = join(staging, 'qemu-package-inputs');
    const packages = await materializeVerifiedQemuPackages(options.qemuEvidence, packageRoot, join(evidence, 'qemu-package-archives'));
    await writeJson(join(evidence, 'qemu-packages.json'), packages);
    const qemu = await sealQemu(packageRoot, staging);
    await rm(packageRoot, { recursive: true });
    await writeJson(join(evidence, 'qemu-closure.json'), qemu);
    await docker(['create', '--name', container, '--user', '0:0', '--workdir', '/', '--entrypoint', '/bin/sleep', image.id, 'infinity']); created = true;
    const runtime = join(evidence, 'image-codex'); await mkdir(runtime, { mode: 0o700 });
    await docker(['cp', `${container}:/opt/codex-runtime/.`, runtime]);
    const allowedRuntimePaths = new Set([...artifact.files.map(file => file.path), 'artifact.json']);
    for (const file of await regularInventory(runtime)) if (!allowedRuntimePaths.has(file.path) && !file.path.startsWith('licenses/')) throw new Error(`Unlisted worker Codex file: ${file.path}`);
    for (const file of artifact.files) if (await hashFile(join(runtime, file.path)) !== file.sha256) throw new Error(`Worker image differs from the admitted Codex artifact: ${file.path}`);
    if (await hashFile(join(runtime, 'artifact.json')) !== await hashFile(artifact.manifestPath)) throw new Error('Worker image Codex provenance differs from the admitted artifact');
    await copyFile(artifact.manifestPath, join(evidence, 'codex-artifact.json'));
    await rm(runtime, { recursive: true });
    await docker(['start', container]);
    await docker(['exec', container, 'mkdir', '-p', '/opt/rat-build-tools', '/opt/rat-build-evidence']);
    for (const [from, to] of [[source('runtime/native/package-inventory.py'), '/opt/rat-build-tools/package-inventory.py'],
      [source('runtime/native/install-kernel-modules.py'), '/opt/rat-build-tools/install-kernel-modules.py'],
      [source('testing/local-runtime/linux-kvm/kernel-inputs.json'), '/opt/rat-build-tools/kernel-inputs.json'],
      [source('runtime/native/archive-root.py'), '/opt/rat-build-tools/archive-root.py'], [source('testing/local-runtime/linux-kvm/init.sh'), '/init'],
      [source('runtime/native/guest.py'), '/opt/rat-things/native-guest.py'], [join(evidence, 'modloop-virt'), '/tmp/modloop-virt']] as const) await docker(['cp', from, `${container}:${to}`]);
    await writeFile(join(evidence, 'export-workspace.cjs'), WORKSPACE_EXPORT_SCRIPT, { mode: 0o600 });
    await docker(['cp', join(evidence, 'export-workspace.cjs'), `${container}:/opt/rat-things/export-workspace.cjs`]);
    await docker(['exec', container, 'python3', '/opt/rat-build-tools/package-inventory.py', 'snapshot', '/opt/rat-build-evidence/base-packages.json']);
    await docker(['exec', container, 'dnf', '--releasever=2023.12.20261016', "--disablerepo=*", '--enablerepo=amazonlinux', '--setopt=keepcache=True', '--setopt=gpgcheck=True', 'install', '-y', 'e2fsprogs', 'kmod', 'squashfs-tools'], 180_000);
    await docker(['exec', container, 'python3', '/opt/rat-build-tools/package-inventory.py', '/opt/rat-build-evidence/native', '--before', '/opt/rat-build-evidence/base-packages.json']);
    await docker(['exec', container, 'python3', '/opt/rat-build-tools/install-kernel-modules.py', '/tmp/modloop-virt'], 180_000);
    await docker(['exec', container, 'chmod', '755', '/', '/init']);
    await docker(['exec', container, 'chmod', '644', '/opt/rat-things/native-guest.py', '/opt/rat-things/export-workspace.cjs']);
    await docker(['exec', container, 'rm', '-rf', '/tmp/modloop-virt', '/var/cache/dnf']);
    await docker(['cp', `${container}:/opt/rat-build-evidence/.`, join(evidence, 'guest-packages')]);
    const workerBundle = join(evidence, 'local-worker.mjs'); await docker(['cp', `${container}:/opt/rat-things/local-worker.mjs`, workerBundle]);
    const exported = spawn('docker', ['--host', endpoint, 'exec', container, 'python3', '/opt/rat-build-tools/archive-root.py', '/', '--normalize', '--source-date-epoch', '0', '--inventory', '/tmp/guest-inventory.json'], { env: environment, stdio: ['ignore', 'pipe', 'inherit'], shell: false });
    const completed = new Promise<void>((done, reject) => { exported.once('error', reject); exported.once('close', code => code === 0 ? done() : reject(new Error(`Guest export failed (${code})`))); });
    const deadline = setTimeout(() => exported.kill('SIGKILL'), 180_000);
    try { await Promise.all([completed, pipeline(exported.stdout!, meter(1400 * 1024 ** 2), createGzip({ level: 1 }), meter(600 * 1024 ** 2), createWriteStream(join(staging, 'worker-initramfs.gz'), { flags: 'wx', mode: 0o600 }))]); }
    finally { clearTimeout(deadline); if (exported.exitCode === null) exported.kill('SIGKILL'); }
    await docker(['cp', `${container}:/tmp/guest-inventory.json`, join(evidence, 'guest-inventory.json')]);
    const manifest = { version: 1, target, kernelSha256: digest(kernel), initrdSha256: await hashFile(join(staging, 'worker-initramfs.gz')),
      helperSha256: await hashFile(join(staging, 'rat-linux-worker')), files: qemu.files };
    await writeJson(join(evidence, 'preparation.json'), { kind: 'linux-kvm-development', sourceImage: image.id, target, sourceRecords, kernel: lock,
      codexArtifactSha256: await hashFile(artifact.manifestPath), localWorkerSha256: await hashFile(workerBundle), sourceDateEpoch: 0 });
    await writeJson(join(staging, 'manifest.json'), manifest);
    await docker(['rm', '-f', container]); created = false;
    const destination = join(output, `image-${digest(JSON.stringify(manifest)).slice(0, 24)}`);
    try { await lstat(destination); throw new Error(`Linux KVM assets already exist; refusing to overwrite ${destination}`); } catch (error) { if (!missing(error)) throw error; }
    await rename(staging, destination);
    return destination;
  } finally {
    if (created) await docker(['rm', '-f', container]);
    await rm(staging, { recursive: true, force: true });
  }
}

function options(arguments_: string[]): Options {
  const result: Options = { output: '.runtime/linux-kvm', image: process.env.RAT_NATIVE_SOURCE_IMAGE ?? 'docker.io/library/rat-things-local:1',
    artifact: process.env.CODEX_RUNTIME_ARTIFACT ?? '.runtime/codex/linux-x64', kernelInputs: '.runtime/linux-tools/kvm-proof',
    qemuEvidence: 'test-results/local-pi-parity/qemu-packages.json' };
  const names: Record<string, keyof Options> = { '--output': 'output', '--image': 'image', '--artifact': 'artifact', '--kernel-inputs': 'kernelInputs', '--qemu-evidence': 'qemuEvidence' };
  for (let i = 0; i < arguments_.length; i += 2) {
    const name = names[arguments_[i]!], value = arguments_[i + 1];
    if (!name || !value || value.startsWith('--')) throw new Error('Invalid preparation arguments; use --help');
    result[name] = value;
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes('--help')) console.log('Development only: prepare a Linux x64 KVM worker from a verified official-Codex local image.\nOptions: --output DIR --image IMAGE --artifact DIR --kernel-inputs DIR --qemu-evidence FILE\nNo VM is started. Existing image generations are never overwritten.');
  else prepareLinuxKvm(options(process.argv.slice(2))).then(directory => console.log(JSON.stringify({ directory, kind: 'linux-kvm-development' })))
    .catch(error => { console.error(error instanceof Error ? error.message : 'Linux KVM preparation failed'); process.exitCode = 1; });
}
