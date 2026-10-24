import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { appendFile, chmod, copyFile, mkdir, readFile, rename, rm, statfs, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip, gunzipSync, gzipSync } from 'node:zlib';
import { build } from 'esbuild';
import { WORKSPACE_EXPORT_SCRIPT } from '../../../../src/domain/workspace-transfer.js';

const exec = promisify(execFile);
const endpoint = !process.env.DOCKER_CONTEXT && process.env.DOCKER_HOST
  || JSON.parse((await exec('docker', ['context', 'inspect'])).stdout)[0]?.Endpoints?.docker?.Host as unknown;
if (typeof endpoint !== 'string' || !endpoint.startsWith('unix://')) throw new Error('Native image preparation requires a local Docker Unix socket.');
const { DOCKER_CONTEXT: _context, DOCKER_HOST: _host, ...environment } = process.env;
const docker = (args: string[], options: { timeout?: number; maxBuffer?: number } = {}) => exec('docker', ['--host', endpoint, ...args], { env: environment, timeout: 30_000, ...options });
const root = resolve('.runtime/local-vm-worker');
const source = resolve('runtime/native');
const preparation = resolve('testing/local-runtime/native-vm/worker');
const base = 'https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/aarch64/netboot-3.24.2/';
const fixturePath = (name: string) => join(root, `${name}-3.24.2`);
const fixtures = {
  'vmlinuz-virt': 'e45e1f6083d1ed45db6647b422e32b6ae6dc54de7b8190b7b97744fb293412e3',
  'modloop-virt': '32a189d5e4ae4417cf65bfcc91d2cc8ffdf5957fbbc1f055b037861c595b7328',
};
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function hashFile(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
function meter(limit: number) {
  let size = 0;
  return new Transform({ transform(chunk: Buffer, _encoding, callback) {
    size += chunk.length;
    callback(size > limit ? new Error('Native image exceeds preparation budget') : null, chunk);
  } });
}
function completed(child: ReturnType<typeof spawn>) {
  return new Promise<void>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolveExit() : reject(new Error(`Image pipeline process failed (${code})`)));
  });
}
function cpio(name: string, data: Buffer, mode: number, major = 0, minor = 0) {
  const filename = Buffer.from(`${name}\0`);
  const fields = [1, mode, 0, 0, 1, 0, data.length, 0, 0, major, minor, filename.length, 0];
  const header = Buffer.from(`070701${fields.map(value => value.toString(16).padStart(8, '0')).join('')}`);
  const pad = (length: number) => Buffer.alloc((4 - length % 4) % 4);
  return Buffer.concat([header, filename, pad(header.length + filename.length), data, pad(data.length)]);
}

if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Native worker proof requires Apple silicon and Xcode.');
await mkdir(root, { recursive: true, mode: 0o700 });
const space = await statfs(root);
if (space.bavail * space.bsize < 512 * 1024 ** 2) throw new Error('Native worker preparation requires at least 512 MiB free disk.');
const inspected = JSON.parse((await docker(['image', 'inspect', process.env.RAT_NATIVE_SOURCE_IMAGE ?? 'docker.io/library/rat-things-local:1'])).stdout)[0] as { Id: string; Architecture: string };
if (inspected.Architecture !== 'arm64' || !/^sha256:[a-f0-9]{64}$/.test(inspected.Id)) throw new Error('The worker source must be a local ARM64 image.');
await build({ entryPoints: ['src/runner/local-worker-entry.ts'], outfile: join(root, 'local-worker.mjs'), bundle: true, platform: 'node', target: 'node22', format: 'esm', banner: { js: "import { createRequire as __ratRequire } from 'node:module'; const require = __ratRequire(import.meta.url);" } });
await exec(process.execPath, ['--check', join(root, 'local-worker.mjs')]);
await writeFile(join(root, 'export-workspace.cjs'), WORKSPACE_EXPORT_SCRIPT, { mode: 0o600 });
const inputFiles = [join(source, 'main.swift'), join(source, 'guest.py'), join(source, 'init.sh'), join(preparation, 'prepare.ts'), join(root, 'local-worker.mjs'), join(root, 'export-workspace.cjs')];
const fingerprint = digest(Buffer.from(JSON.stringify({ image: inspected.Id, fixtures, files: await Promise.all(inputFiles.map(hashFile)) })));
const baseFingerprint = digest(Buffer.from(JSON.stringify({ version: 2, image: inspected.Id, fixtures, archive: await hashFile(join(source, 'archive-root.py')), packages: ['e2fsprogs', 'kmod', 'squashfs-tools'] })));
let previous: { fingerprint: string; initrdSha256: string; kernelSha256: string; helperSha256: string; baseFingerprint?: string; baseSha256?: string; packages: string[] } | undefined;
try {
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as { fingerprint: string; initrdSha256: string; kernelSha256: string; helperSha256: string };
  previous = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as typeof previous;
  if (previous?.baseFingerprint === baseFingerprint && manifest.fingerprint === fingerprint && manifest.initrdSha256 === await hashFile(join(root, 'worker-initramfs.gz')) && manifest.kernelSha256 === await hashFile(join(root, 'Image')) && manifest.helperSha256 === await hashFile(join(root, 'rat-native-worker'))) {
    console.log(`Verified native worker proof image: ${root}`);
    process.exit(0);
  }
} catch (error) {
  if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
}
for (const [name, sha256] of Object.entries(fixtures)) {
  const path = fixturePath(name);
  let bytes: Buffer;
  try { bytes = await readFile(path); }
  catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      const response = await fetch(new URL(name, base), { signal: AbortSignal.timeout(60_000) });
      if (!response.ok || !response.body) throw new Error(`Cannot download native fixture ${name}`);
      const chunks: Uint8Array[] = []; let size = 0;
      const reader = response.body.getReader();
      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        size += chunk.length;
        if (size > 32 * 1024 ** 2) throw new Error('Native fixture exceeds 32 MiB');
        chunks.push(chunk);
      }
      bytes = Buffer.concat(chunks);
  }
  if (digest(bytes) !== sha256) throw new Error(`Native fixture digest mismatch: ${name}`);
  await writeFile(path, bytes, { mode: 0o600 });
}
const zboot = await readFile(fixturePath('vmlinuz-virt'));
const kernel = gunzipSync(zboot.subarray(zboot.readUInt32LE(8), zboot.readUInt32LE(8) + zboot.readUInt32LE(12)), { maxOutputLength: 64 * 1024 ** 2 });
if (kernel.toString('ascii', 56, 60) !== 'ARMd') throw new Error('Invalid ARM64 kernel');
await writeFile(join(root, 'Image'), kernel, { mode: 0o600 });
await exec('xcrun', ['swiftc', join(source, 'main.swift'), '-framework', 'Virtualization', '-o', join(root, 'rat-native-worker')], { timeout: 120_000 });
await exec('/usr/bin/codesign', ['--force', '--sign', '-', '--entitlements', resolve('runtime/native/entitlements.plist'), join(root, 'rat-native-worker')]);
await copyFile(join(source, 'init.sh'), join(root, 'init'));
await chmod(join(root, 'init'), 0o755);
const container = `rat-native-builder-${randomUUID()}`;
const temporary = join(root, `worker-${randomUUID()}.partial`);
const baseImage = join(root, 'base-initramfs.gz');
let packages = previous?.packages ?? [];
let cachedBase = false;
if (previous?.baseFingerprint === baseFingerprint) {
  try { cachedBase = previous.baseSha256 === await hashFile(baseImage); }
  catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error; }
}
if (!cachedBase && space.bavail * space.bsize < 1024 ** 3) throw new Error('A fresh native base image requires at least 1 GiB free disk.');
if (!cachedBase) {
try {
  await docker(['run', '-d', '--name', container, '--entrypoint', '/bin/sleep', inspected.Id, 'infinity']);
  console.log('Preparing guest filesystem in a disposable build container.');
  await docker(['exec', container, 'dnf', 'install', '-y', 'e2fsprogs', 'kmod', 'squashfs-tools'], { timeout: 180_000, maxBuffer: 4 * 1024 ** 2 });
  for (const [from, to] of [[fixturePath('modloop-virt'), '/tmp/modloop'], [join(root, 'init'), '/init'], [join(source, 'guest.py'), '/opt/rat-things/native-guest.py'], [join(root, 'local-worker.mjs'), '/opt/rat-things/local-worker.mjs'], [join(root, 'export-workspace.cjs'), '/opt/rat-things/export-workspace.cjs']]) {
    await docker(['cp', from!, `${container}:${to!}`]);
  }
  await docker(['cp', join(source, 'archive-root.py'), `${container}:/tmp/archive-root.py`]);
  await docker(['exec', container, 'unsquashfs', '-d', '/tmp/rat-kernel', '/tmp/modloop']);
  await docker(['exec', container, 'mkdir', '-p', '/lib/modules']);
  await docker(['exec', container, 'cp', '-a', '/tmp/rat-kernel/modules/.', '/lib/modules/']);
  await docker(['exec', container, 'depmod', '6.18.52-0-virt']);
  await docker(['exec', container, 'chmod', '755', '/init']);
  await docker(['exec', container, 'chmod', '644', '/opt/rat-things/export-workspace.cjs']);
  packages = (await docker(['exec', container, 'rpm', '-qa'])).stdout.trim().split('\n').sort();
  await docker(['exec', container, 'rm', '-rf', '/tmp/rat-kernel', '/tmp/modloop', '/var/cache/dnf']);
  const exported = spawn('docker', ['--host', endpoint, 'exec', container, 'python3', '/tmp/archive-root.py', '/'], { env: environment, stdio: ['ignore', 'pipe', 'inherit'], shell: false });
  const deadline = setTimeout(() => exported.kill('SIGKILL'), 180_000);
  try {
    await Promise.all([
      completed(exported),
      pipeline(exported.stdout!, meter(1400 * 1024 ** 2), createGzip({ level: 1 }), meter(600 * 1024 ** 2), createWriteStream(temporary, { flags: 'wx', mode: 0o600 })),
    ]);
  } finally {
    clearTimeout(deadline);
    if (exported.exitCode === null) exported.kill('SIGKILL');
  }
  await rename(temporary, baseImage);
} finally {
  await docker(['rm', '-f', container]);
  await rm(temporary, { force: true });
}
}
try {
  await exec('/bin/cp', ['-c', baseImage, temporary]);
  const overlay = await Promise.all([
    ['init', join(root, 'init'), 0o100755],
    ['opt/rat-things/native-guest.py', join(source, 'guest.py'), 0o100644],
    ['opt/rat-things/local-worker.mjs', join(root, 'local-worker.mjs'), 0o100644],
    ['opt/rat-things/export-workspace.cjs', join(root, 'export-workspace.cjs'), 0o100644],
  ].map(async ([name, path, mode]) => cpio(String(name), await readFile(String(path)), Number(mode))));
  await appendFile(temporary, gzipSync(Buffer.concat([
    ...overlay, cpio('dev/console', Buffer.alloc(0), 0o020600, 5, 1), cpio('dev/null', Buffer.alloc(0), 0o020666, 1, 3),
    cpio('TRAILER!!!', Buffer.alloc(0), 0),
  ])));
  await rename(temporary, join(root, 'worker-initramfs.gz'));
  await writeFile(join(root, 'manifest.json'), JSON.stringify({ prototype: true, fingerprint, baseFingerprint, baseSha256: await hashFile(baseImage), sourceImage: inspected.Id, fixtures, packages,
    initrdSha256: await hashFile(join(root, 'worker-initramfs.gz')), kernelSha256: digest(kernel), helperSha256: await hashFile(join(root, 'rat-native-worker')),
  }, null, 2), { mode: 0o600 });
  console.log(`Prepared native worker proof image: ${root}`);
} finally { await rm(temporary, { force: true }); }
