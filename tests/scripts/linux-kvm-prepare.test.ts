import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { libraryDependencies, materializeTree, regularInventory, validateKernel, workerImage } from '../../testing/local-runtime/linux-kvm/prepare.js';

const directories: string[] = [];
async function temporary() { const root = await mkdtemp(join(tmpdir(), 'rat-kvm-prep-test-')); directories.push(root); return root; }
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('Linux KVM development preparation', () => {
  it('pins only a Linux amd64 image ID, never an architecture tag', () => {
    const id = `sha256:${'a'.repeat(64)}`;
    expect(workerImage([{ Id: id, Os: 'linux', Architecture: 'amd64' }])).toEqual({ id });
    for (const image of [{ Id: id, Os: 'linux', Architecture: 'arm64' }, { Id: 'rat:latest', Os: 'linux', Architecture: 'amd64' }, { Id: id, Os: 'darwin', Architecture: 'amd64' }]) {
      expect(() => workerImage([image])).toThrow('immutable');
    }
    expect(() => workerImage([])).toThrow();
  });

  it('resolves host library paths and the loader without treating command text as code', () => {
    expect(libraryDependencies('\tlinux-vdso.so.1 (0x00007fa123)\n\tlibc.so.6 => /usr/lib/libc.so.6 (0x00007fa456)\n\t/lib64/ld-linux-x86-64.so.2 (0x00007fa789)\n'))
      .toEqual(['/lib64/ld-linux-x86-64.so.2', '/usr/lib/libc.so.6']);
    expect(libraryDependencies('statically linked')).toEqual([]);
    expect(libraryDependencies('libc.so.6 => /private/a b/libc.so.6 (0x123)')).toEqual(['/private/a b/libc.so.6']);
    expect(() => libraryDependencies('libmissing.so => not found')).toThrow('Unresolved');
    expect(() => libraryDependencies('unexpected output')).toThrow('Unrecognized');
  });

  it('materializes in-root symlinks, strips special permission bits, and records every resulting file', async () => {
    const root = await temporary(), source = join(root, 'source'), output = join(root, 'output');
    await mkdir(join(source, 'lib'), { recursive: true });
    await writeFile(join(source, 'lib', 'actual'), 'library', { mode: 0o4755 });
    await symlink('actual', join(source, 'lib', 'alias'));
    await materializeTree(source, join(source, 'lib'), output);
    expect((await stat(join(output, 'alias'))).isFile()).toBe(true);
    expect((await stat(join(output, 'actual'))).mode & 0o7777).toBe(0o700);
    expect(await readFile(join(output, 'alias'), 'utf8')).toBe('library');
    const files = await regularInventory(output);
    expect(files.map(file => file.path)).toEqual(['actual', 'alias']);
    expect(files[0]?.sha256).toBe(files[1]?.sha256);
    await writeFile(join(output, 'unlisted'), 'extra');
    expect((await regularInventory(output)).map(file => file.path)).toContain('unlisted');
  });

  it('rejects escaping symlinks, cycles, and symlinks in the final manifest tree', async () => {
    const root = await temporary(), source = join(root, 'source'); await mkdir(source);
    await writeFile(join(root, 'outside'), 'private'); await symlink('../outside', join(source, 'escape'));
    await expect(materializeTree(source, join(source, 'escape'), join(root, 'output'))).rejects.toThrow('escapes');
    await symlink('.', join(source, 'cycle'));
    await expect(materializeTree(source, join(source, 'cycle'), join(root, 'output'))).rejects.toThrow();
    await expect(regularInventory(source)).rejects.toThrow('symlink');
  });

  it('does not overwrite an existing materialized file', async () => {
    const root = await temporary(); await writeFile(join(root, 'input'), 'new'); await writeFile(join(root, 'output'), 'active');
    await expect(materializeTree(root, join(root, 'input'), join(root, 'output'))).rejects.toThrow();
    expect(await readFile(join(root, 'output'), 'utf8')).toBe('active');
  });

  it('requires the x86 boot protocol and 64-bit kernel flag', () => {
    const bytes = Buffer.alloc(0x238); bytes.write('HdrS', 0x202); bytes.writeUInt16LE(0xaa55, 0x1fe); bytes.writeUInt16LE(1, 0x236);
    expect(() => validateKernel(bytes)).not.toThrow();
    bytes.writeUInt16LE(0, 0x236); expect(() => validateKernel(bytes)).toThrow('x86-64');
    expect(() => validateKernel(Buffer.from('ARMd'))).toThrow('x86-64');
  });

  it('repairs guest root traversal before the first chroot or agent launch', async () => {
    const init = await readFile('testing/local-runtime/linux-kvm/init.sh', 'utf8');
    expect(init.indexOf('chmod 755 /')).toBeLessThan(init.indexOf('exec chroot'));
    expect(init).toContain('chmod 1777 /tmp');
    expect(init).toContain('modprobe vmw_vsock_virtio_transport');
  });
});
