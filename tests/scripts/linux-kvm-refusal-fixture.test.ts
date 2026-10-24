import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { hashFile, regularInventory } from '../../testing/local-runtime/linux-kvm/prepare.js';
import { sandboxRefusalVariant } from '../../testing/local-runtime/linux-kvm/sandbox-refusal.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'rat-kvm-refusal-test-')); directories.push(directory);
  const source = join(directory, 'source'); await mkdir(join(source, 'qemu', 'usr', 'bin'), { recursive: true });
  await writeFile(join(source, 'qemu', 'usr', 'bin', 'qemu-system-x86_64'), 'fixture-only-qemu', { mode: 0o700 });
  await writeFile(join(source, 'Image'), 'fixture-only-kernel');
  await writeFile(join(source, 'worker-initramfs.gz'), gzipSync('fixture-only-initramfs'));
  await writeFile(join(source, 'rat-linux-worker'), 'fixture-only-helper', { mode: 0o700 });
  const manifest = { version: 1, target: 'x86_64-unknown-linux-gnu', kernelSha256: await hashFile(join(source, 'Image')),
    initrdSha256: await hashFile(join(source, 'worker-initramfs.gz')), helperSha256: await hashFile(join(source, 'rat-linux-worker')),
    files: (await regularInventory(join(source, 'qemu'))).map(file => ({ ...file, path: `qemu/${file.path}` })) };
  await writeFile(join(source, 'manifest.json'), JSON.stringify(manifest));
  return { directory, source, manifest };
}

describe('disposable KVM sandbox refusal fixture', () => {
  it('preserves source assets and changes only the copied initramfs identity', async () => {
    const { directory, source, manifest } = await fixture();
    const before = await regularInventory(source);
    const output = await sandboxRefusalVariant(source, join(directory, 'evidence'));
    expect(await regularInventory(source)).toEqual(before);
    const changed = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
    expect(changed).toEqual({ ...manifest, initrdSha256: await hashFile(join(output, 'worker-initramfs.gz')) });
    expect(changed.initrdSha256).not.toBe(manifest.initrdSha256);
    expect(await regularInventory(join(output, 'qemu'))).toEqual(await regularInventory(join(source, 'qemu')));
    expect((await stat(output)).mode & 0o777).toBe(0o700);
    expect((await stat(join(output, 'rat-linux-worker'))).mode & 0o777).toBe(0o700);
    const bytes = gunzipSync(await readFile(join(output, 'worker-initramfs.gz')));
    expect(bytes.toString()).toContain('opt/codex-runtime/codex-resources/bwrap\0');
    expect(bytes.toString()).toContain('RAT_SANDBOX_REFUSAL_FIXTURE');
    expect(bytes.toString()).toContain('exit 97\n');
    const evidence = JSON.parse(await readFile(join(output, 'negative-fixture.json'), 'utf8'));
    expect(evidence.sourceInitrdSha256).toBe(manifest.initrdSha256);
    expect(evidence.changedInitrdSha256).toBe(changed.initrdSha256);
  });

  it('refuses an unlisted QEMU file or changed source initramfs', async () => {
    const first = await fixture();
    await writeFile(join(first.source, 'qemu', 'unlisted'), 'unlisted');
    await expect(sandboxRefusalVariant(first.source, join(first.directory, 'evidence'))).rejects.toThrow('intact source QEMU inventory');
    const second = await fixture();
    await writeFile(join(second.source, 'worker-initramfs.gz'), gzipSync('changed'));
    await expect(sandboxRefusalVariant(second.source, join(second.directory, 'evidence'))).rejects.toThrow();
    expect(await readFile(join(second.source, 'worker-initramfs.gz'))).toEqual(gzipSync('changed'));
  });
});
