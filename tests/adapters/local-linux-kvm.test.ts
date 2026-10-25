import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { LocalNativeRuntime } from '../../src/adapters/local-native-runtime.js';
import { FixtureMachine, startRequest, supportedHost } from '../simulation/native-runtime-fixtures.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const linux = it.skipIf(process.platform !== 'linux' || process.arch !== 'x64');

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'rat-linux-kvm-')); directories.push(directory);
  const assets = join(directory, 'assets');
  await mkdir(join(assets, 'qemu/usr/bin'), { recursive: true });
  const kernel = Buffer.alloc(0x238); kernel.writeUInt16LE(0xaa55, 0x1fe); kernel.write('HdrS', 0x202); kernel.writeUInt16LE(1, 0x236);
  await writeFile(join(assets, 'Image'), kernel);
  for (const name of ['worker-initramfs.gz', 'rat-linux-worker', 'qemu/usr/bin/qemu-system-x86_64']) await writeFile(join(assets, name), 'fixture', { mode: 0o755 });
  const manifest = { version: 1, target: 'x86_64-unknown-linux-gnu', kernelSha256: digest(kernel), initrdSha256: digest('fixture'),
    helperSha256: digest('fixture'), files: [{ path: 'qemu/usr/bin/qemu-system-x86_64', sha256: digest('fixture') }] };
  const save = () => writeFile(join(assets, 'manifest.json'), JSON.stringify(manifest));
  await save();
  const launches: { binary: string; disk: string }[] = [];
  const runtime = new LocalNativeRuntime(directory, () => ({ kind: 'linux-kvm-development', directory: assets }), {
    developmentStorage: 'linux-kvm-workspaces', dependencies: {
      hostFacts: async () => ({ ...supportedHost, architecture: 'x64' }), availableDiskBytes: async () => 4 * 1024 ** 3,
      machine(binary, path) {
        const configuration = JSON.parse(readFileSync(path, 'utf8'));
        launches.push({ binary, disk: configuration.disk });
        return new FixtureMachine(configuration);
      },
    },
  });
  return { directory, assets, manifest, save, runtime, launches, kernel };
}

async function idleHelper(f: Awaited<ReturnType<typeof fixture>>, responses: unknown[]) {
  const evidence = join(f.directory, 'idle-calls.json');
  const program = `#!${process.execPath}\nconst fs=require('node:fs');
const path=${JSON.stringify(evidence)};const calls=fs.existsSync(path)?JSON.parse(fs.readFileSync(path,'utf8')):[];
if(process.argv[2]!=='--workspace-idle')throw Error('unexpected mode');
calls.push(JSON.parse(process.argv[3]));fs.writeFileSync(path,JSON.stringify(calls));
console.log(JSON.stringify(${JSON.stringify(responses)}[Math.min(calls.length-1,${responses.length - 1})]));`;
  await writeFile(join(f.assets, 'rat-linux-worker'), program, { mode: 0o755 });
  f.manifest.helperSha256 = digest(program); await f.save();
  return evidence;
}

linux('uses the Linux helper and separate persistent workspace namespace', async () => {
  const f = await fixture();
  try {
    await expect(f.runtime.status()).resolves.toMatchObject({ ready: true, platform: 'linux/amd64', image: `linux-kvm-development:${f.manifest.initrdSha256}` });
    const request = startRequest();
    await f.runtime.start(request, async () => {});
    expect(f.launches).toEqual([{ binary: join(f.assets, 'rat-linux-worker'), disk: join(f.directory, 'linux-kvm-workspaces', request.worker.sessionId, 'workspace.raw') }]);
  } finally { await f.runtime.close(); }
});

linux('rejects changed, unlisted and symlinked QEMU dependencies before boot', async () => {
  const f = await fixture();
  const binary = join(f.assets, 'qemu/usr/bin/qemu-system-x86_64');
  await writeFile(binary, 'changed');
  await expect(f.runtime.status()).rejects.toThrow('integrity');
  await writeFile(binary, 'fixture');
  await writeFile(join(f.assets, 'qemu/unlisted'), 'extra');
  await expect(f.runtime.status()).rejects.toThrow('unlisted');
  await rm(join(f.assets, 'qemu/unlisted'));
  await rm(binary); await symlink(join(f.assets, 'rat-linux-worker'), binary);
  await expect(f.runtime.status()).rejects.toThrow('symlinks');
  expect(f.launches).toEqual([]);
});

linux('rejects a mislabeled kernel even when its declared digest matches', async () => {
  const f = await fixture();
  f.kernel.writeUInt16LE(0, 0x236);
  await writeFile(join(f.assets, 'Image'), f.kernel);
  f.manifest.kernelSha256 = digest(await readFile(join(f.assets, 'Image'))); await f.save();
  await expect(f.runtime.status()).rejects.toThrow('x86-64 Linux boot image');
  expect(f.launches).toEqual([]);
});

linux('confirms the previous worker disk is unlocked before cold cancellation without starting a VM', async () => {
  const f = await fixture(); const request = startRequest();
  const evidence = await idleHelper(f, [{ stopped: false }, { stopped: true }]);
  const recovered = new LocalNativeRuntime(f.directory, () => ({ kind: 'linux-kvm-development', directory: f.assets }), { developmentStorage: 'linux-kvm-workspaces' });
  try {
    await f.runtime.start(request, async () => {}); await f.runtime.stop(request.worker.sessionId);
    await recovered.stop(request.worker.sessionId);
    const calls = JSON.parse(await readFile(evidence, 'utf8'));
    expect(calls).toHaveLength(2); expect(calls[0]).toEqual(calls[1]);
    expect(calls[0]).toMatchObject({ disk: join(f.directory, 'linux-kvm-workspaces', request.worker.sessionId, 'workspace.raw'),
      device: expect.stringMatching(/^\d+$/), inode: expect.stringMatching(/^\d+$/), filesystemUUID: expect.stringMatching(/^[a-f0-9-]{36}$/) });
    expect(f.launches).toHaveLength(1);
  } finally { await recovered.close(); await f.runtime.close(); }
});

linux('rejects cold cancellation when the disk lock remains held', async () => {
  const f = await fixture(); const request = startRequest();
  await idleHelper(f, [{ stopped: false }]);
  const recovered = new LocalNativeRuntime(f.directory, () => ({ kind: 'linux-kvm-development', directory: f.assets }), { developmentStorage: 'linux-kvm-workspaces' });
  try {
    await f.runtime.start(request, async () => {}); await f.runtime.stop(request.worker.sessionId);
    await expect(recovered.stop(request.worker.sessionId)).rejects.toThrow('predecessor cleanup could not be confirmed');
    expect(f.launches).toHaveLength(1);
  } finally { await recovered.close(); await f.runtime.close(); }
});

linux('confirms an unallocated fresh start without requiring a nonexistent disk or working image', async () => {
  const f = await fixture(); const request = startRequest(); const claim = vi.fn(async () => {});
  try {
    await writeFile(join(f.assets, 'Image'), 'invalid');
    await expect(f.runtime.start(request, claim)).rejects.toThrow();
    expect(claim).not.toHaveBeenCalled(); expect(f.launches).toEqual([]);
    await expect(lstat(join(f.directory, 'linux-kvm-workspaces', request.worker.sessionId))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(f.runtime.stop(request.worker.sessionId)).resolves.toBeUndefined();
    await expect(f.runtime.stop(request.worker.sessionId)).resolves.toBeUndefined();
  } finally { await f.runtime.close(); }
});

linux('does not treat unknown cold storage absence as proof of a stopped worker', async () => {
  const f = await fixture();
  try { await expect(f.runtime.stop(startRequest().worker.sessionId)).rejects.toMatchObject({ code: 'ENOENT' }); }
  finally { await f.runtime.close(); }
});

linux('does not infer an unallocated workspace from a rejected resume intent', async () => {
  const f = await fixture(); const request = startRequest();
  try {
    await writeFile(join(f.assets, 'Image'), 'invalid');
    await expect(f.runtime.start({ ...request, workspace: { ...request.workspace, kind: 'resume' } }, async () => {})).rejects.toThrow();
    await writeFile(join(f.assets, 'Image'), f.kernel);
    await expect(f.runtime.stop(request.worker.sessionId)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await f.runtime.close(); }
});

linux('does not follow a workspace-root symlink while proving a fresh start allocated nothing', async () => {
  const f = await fixture(); const request = startRequest(); const claim = vi.fn(async () => {});
  try {
    await symlink(f.assets, join(f.directory, 'linux-kvm-workspaces'));
    await writeFile(join(f.assets, 'Image'), 'invalid');
    await expect(f.runtime.start(request, claim)).rejects.toThrow('Invalid native workspace root');
    expect(claim).not.toHaveBeenCalled();
    await writeFile(join(f.assets, 'Image'), f.kernel);
    await expect(f.runtime.stop(request.worker.sessionId)).rejects.toThrow();
  } finally { await f.runtime.close(); }
});

linux.each(['directory', 'symlink'] as const)('rejects missing disk receipts when a %s already occupies a rejected fresh workspace', async kind => {
  const f = await fixture(); const request = startRequest();
  const workspace = join(f.directory, 'linux-kvm-workspaces', request.worker.sessionId);
  await mkdir(join(f.directory, 'linux-kvm-workspaces'));
  if (kind === 'directory') { await mkdir(workspace); await writeFile(join(workspace, 'workspace.raw'), 'existing disk'); }
  else await symlink(f.assets, workspace);
  try {
    await writeFile(join(f.assets, 'Image'), 'invalid');
    const claim = vi.fn(async () => {});
    await expect(f.runtime.start(request, claim)).rejects.toThrow();
    expect(claim).not.toHaveBeenCalled();
    await writeFile(join(f.assets, 'Image'), f.kernel);
    await expect(f.runtime.stop(request.worker.sessionId)).rejects.toThrow();
    expect(f.launches).toEqual([]);
  } finally { await f.runtime.close(); }
});

linux('revokes the unallocated proof before attempting a later durable claim', async () => {
  const f = await fixture(); const request = startRequest();
  try {
    await writeFile(join(f.assets, 'Image'), 'invalid');
    await expect(f.runtime.start(request, async () => {})).rejects.toThrow();
    await writeFile(join(f.assets, 'Image'), f.kernel);
    const claim = vi.fn(async () => { throw new Error('Claim outcome is uncertain'); });
    await expect(f.runtime.start(request, claim)).rejects.toThrow('Claim outcome is uncertain');
    expect(claim).toHaveBeenCalledOnce();
    await expect(f.runtime.stop(request.worker.sessionId)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.launches).toEqual([]);
  } finally { await f.runtime.close(); }
});
