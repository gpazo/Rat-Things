import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, open, readFile, statfs, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { gzipSync, gunzipSync } from 'node:zlib';

const exec = promisify(execFile);
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('This opt-in prototype requires an Apple silicon Mac with Xcode.');
const root = resolve('.runtime/local-vm-prototype');
await mkdir(root, { recursive: true, mode: 0o700 });
const space = await statfs(root);
if (space.bavail * space.bsize < 512 * 1024 ** 2) throw new Error('Native VM proof requires at least 512 MiB free disk space.');
const base = 'https://dl-cdn.alpinelinux.org/alpine/v3.22/releases/aarch64/netboot-3.22.0/';
const fixtures = {
  'vmlinuz-virt': '00ad04e557735cc39cd3ba0464b454e7a73a6cc398fe745171b2dafb6a109798',
  'initramfs-virt': '19dc251f937eb3843ecbb5ea9839a543f7dcdbe7e1ee13058c06d17cb9adfc6d',
};
for (const [name, digest] of Object.entries(fixtures)) {
  const path = join(root, name);
  let bytes;
  try { bytes = await readFile(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const response = await fetch(new URL(name, base), { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`Fixture download failed: ${name}`);
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 32 * 1024 ** 2) throw new Error('Fixture exceeds the prototype download budget.');
      chunks.push(chunk);
    }
    bytes = Buffer.concat(chunks);
  }
  if (createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error(`Fixture digest mismatch: ${name}`);
  await writeFile(path, bytes, { mode: 0o600 });
}
const binary = join(root, 'rat-vm-prototype');
const zboot = await readFile(join(root, 'vmlinuz-virt'));
const payloadOffset = zboot.readUInt32LE(8);
const payloadLength = zboot.readUInt32LE(12);
const kernel = gunzipSync(zboot.subarray(payloadOffset, payloadOffset + payloadLength), { maxOutputLength: 64 * 1024 ** 2 });
if (kernel.toString('ascii', 56, 60) !== 'ARMd') throw new Error('Fixture does not contain an ARM64 Linux image.');
const kernelPath = join(root, 'Image');
await writeFile(kernelPath, kernel, { mode: 0o600 });
await exec('xcrun', ['swiftc', 'testing/local-runtime/native-vm/main.swift', '-framework', 'Virtualization', '-o', binary], { timeout: 120_000 });
await exec('/usr/bin/codesign', ['--force', '--sign', '-', '--entitlements', 'runtime/native/entitlements.plist', binary]);
const run = await mkdtemp(join(root, 'proof-'));
const nonce = randomUUID();
const disk = join(run, 'workspace.raw');
const handle = await open(disk, 'wx', 0o600);
await handle.truncate(16 * 1024 ** 2); await handle.close();
const init = `#!/bin/sh
export PATH=/bin:/sbin:/usr/bin:/usr/sbin
/bin/busybox --install -s
mount -t proc proc /proc
mount -t sysfs sysfs /sys
mount -t devtmpfs devtmpfs /dev
modprobe virtio_pci
modprobe virtio_blk
for i in 1 2 3 4 5 6 7 8 9 10; do
  [ -b /dev/vda ] && break
  sleep 1
done
[ -b /dev/vda ] || { echo RAT_VM_PROBE_FAILED; poweroff -f; }
marker="$(dd if=/dev/vda bs=64 count=1 2>/dev/null | tr -d '\\000')"
if [ "$marker" = "rat-vm:${nonce}" ]; then
  echo "RAT_VM_RECOVERED ${nonce}"
  poweroff -f
else
  [ -z "$marker" ] || { echo RAT_VM_PROBE_FAILED; poweroff -f; }
  printf 'rat-vm:${nonce}' | dd of=/dev/vda bs=64 conv=fsync 2>/dev/null
  sync
  echo "RAT_VM_WRITTEN ${nonce}"
  while true; do sleep 1; done
fi
`;
function cpio(name, content, mode) {
  const data = Buffer.from(content);
  const filename = Buffer.from(`${name}\0`);
  const fields = [1, mode, 0, 0, 1, 0, data.length, 0, 0, 0, 0, filename.length, 0];
  const header = Buffer.from(`070701${fields.map(n => n.toString(16).padStart(8, '0')).join('')}`);
  const pad = length => Buffer.alloc((4 - length % 4) % 4);
  return Buffer.concat([header, filename, pad(header.length + filename.length), data, pad(data.length)]);
}
const initrd = join(run, 'probe-initramfs');
await writeFile(initrd, Buffer.concat([await readFile(join(root, 'initramfs-virt')),
  gzipSync(Buffer.concat([cpio('init', init, 0o100755), cpio('TRAILER!!!', '', 0)]))]), { mode: 0o600 });
const results = [];
for (const iteration of [1, 2]) {
  const serialLog = join(run, `boot-${iteration}.log`);
  const config = join(run, `boot-${iteration}.json`);
  await writeFile(serialLog, '', { mode: 0o600 });
  await writeFile(config, JSON.stringify({ kernel: kernelPath, initrd, disk, serialLog, cpuCount: 2, memoryMiB: 256 }), { mode: 0o600 });
  const start = performance.now();
  const child = spawn(binary, [config], { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const exited = once(child, 'exit');
  const marker = `${iteration === 1 ? 'RAT_VM_WRITTEN' : 'RAT_VM_RECOVERED'} ${nonce}`;
  try {
    let observed = false;
    for (let attempt = 0; attempt < 300; attempt++) {
      const serial = await readFile(serialLog, 'utf8');
      if (serial.includes(marker)) { observed = true; break; }
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Guest exited before proof: ${output}\n${serial.slice(-4000)}`);
      await delay(100);
    }
    if (!observed) throw new Error(`Guest proof timed out. Inspect ${serialLog}`);
    const readyMs = Math.round(performance.now() - start);
    if (iteration === 1 && !child.kill('SIGKILL')) throw new Error('Could not terminate the first VM process for the recovery proof.');
    const deadline = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
      const [exitCode, exitSignal] = await exited;
      if (iteration === 1 && exitSignal !== 'SIGKILL') throw new Error('First VM did not exit from the requested process kill.');
      if (iteration === 2 && (exitCode !== 0 || exitSignal !== null || !output.includes('"status":"stopped"'))) {
        throw new Error(`Recovered VM did not shut down successfully: ${output}`);
      }
      results.push({ boot: iteration, proof: iteration === 1 ? 'persisted marker' : 'recovered after host process kill', readyMs, exitCode, exitSignal });
    } finally { clearTimeout(deadline); }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  }
}
const report = { prototype: true, network: false, sharedHostPaths: false, cpus: 2, memoryMiB: 256, diskMiB: 16, results,
  limitations: ['No Rat Things executor or model call', 'No vsock relay', 'No distributable helper or production guest image', 'Raw marker recovery is not filesystem or Session recovery'] };
await writeFile(join(run, 'result.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, artifacts: run }, null, 2));
