import { execFile } from 'node:child_process';
import { appendFile, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { copyRegularFile, readRegularFile, regularFileChunks } from '../../scripts/native-build-files.mjs';

const roots: string[] = [];
const temporary = async () => {
  const root = await mkdtemp(join(tmpdir(), 'rat-native-input-'));
  roots.push(root);
  return root;
};
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('copies an admitted regular input without overwriting another destination', async () => {
  const root = await temporary();
  await writeFile(join(root, 'source'), 'kernel');
  await copyRegularFile(join(root, 'source'), join(root, 'output'), 6);
  expect(await readRegularFile(join(root, 'output'), 6)).toEqual(Buffer.from('kernel'));
  await expect(copyRegularFile(join(root, 'source'), join(root, 'output'), 6)).rejects.toThrow();
  expect(await readFile(join(root, 'output'), 'utf8')).toBe('kernel');
});

it('rejects symlinks and oversized local inputs before copying their bytes', async () => {
  const root = await temporary();
  await writeFile(join(root, 'large'), Buffer.alloc(8192));
  await symlink('large', join(root, 'link'));
  for (const source of ['large', 'link']) {
    const output = join(root, `${source}-output`);
    await expect(copyRegularFile(join(root, source), output, 1024)).rejects.toThrow();
    expect((await lstat(output).catch(() => ({ size: 0 }))).size).toBe(0);
  }
});

it('bounds bytes if an open regular input grows during reading', async () => {
  const root = await temporary();
  const source = join(root, 'growing');
  await writeFile(source, 'abc');
  const chunks = regularFileChunks(source, 4);
  expect((await chunks.next()).value?.toString()).toBe('abc');
  await appendFile(source, 'defgh');
  await expect(chunks.next()).rejects.toThrow('byte limit');
});

it.skipIf(process.platform === 'win32')('rejects a FIFO manifest in the guest wrapper before reaching Docker', async () => {
  const root = await temporary();
  await promisify(execFile)('mkfifo', [join(root, 'artifact.json')]);
  await expect(promisify(execFile)(process.execPath, [resolve('scripts/build-native-guest.mjs'), 'record-candidate',
    '--guest-artifact', root, '--output', join(root, 'output'), '--source-date-epoch', '1'], {
    env: { ...process.env, PATH: '/nonexistent' }, timeout: 5000,
  })).rejects.toMatchObject({ killed: false, stderr: expect.stringContaining('must be a regular file') });
  await expect(lstat(join(root, 'output'))).rejects.toMatchObject({ code: 'ENOENT' });
});
