import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, expect, it } from 'vitest';
import { verifyGuestArchive } from '../../scripts/native-guest-archive.mjs';
import { newcEntry, newcFixture } from './native-guest-archive-fixture.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const identity = (bytes: Buffer) => ({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
const fixture = () => newcFixture([
  { path: 'etc', mode: 0o040755, data: Buffer.alloc(0) },
  { path: 'etc/config', mode: 0o100444, data: Buffer.alloc(130_000, 65), links: 2 },
  { path: 'etc/config-link', mode: 0o100444, data: Buffer.alloc(0), inode: 2, links: 2 },
  { path: 'etc/symlink', mode: 0o120777, data: Buffer.from('/etc/config') },
  { path: 'dev/console', mode: 0o020600, data: Buffer.alloc(0), device: { major: 5, minor: 1 } },
]);
async function write(bytes: Buffer) {
  const root = await mkdtemp(join(tmpdir(), 'rat-guest-archive-')); roots.push(root);
  const filename = join(root, 'guest.gz'); await writeFile(filename, bytes); return filename;
}

it('verifies streamed bytes, ownership, hardlinks, symlinks and device metadata', async () => {
  const f = fixture();
  await expect(verifyGuestArchive(await write(f.bytes), f.inventory, identity(f.bytes))).resolves.toEqual(identity(f.bytes));
});

it('rejects an archive that differs from the previously admitted compressed identity', async () => {
  const f = fixture();
  await expect(verifyGuestArchive(await write(f.bytes), f.inventory, { ...identity(f.bytes), sha256: 'f'.repeat(64) })).rejects.toThrow('changed during verification');
});

it.each(['content', 'owner', 'hardlink', 'target', 'device'] as const)('rejects changed %s despite an unchanged inventory', async kind => {
  const f = fixture();
  if (kind === 'content') f.inventory.entries[1]!.sha256 = 'f'.repeat(64);
  if (kind === 'owner') f.inventory.entries[1]!.uid = 10001;
  if (kind === 'hardlink') f.inventory.entries[2]!.sha256 = 'f'.repeat(64);
  if (kind === 'target') f.inventory.entries[3]!.target = '/other';
  if (kind === 'device') f.inventory.entries[4]!.device!.major = 1;
  await expect(verifyGuestArchive(await write(f.bytes), f.inventory)).rejects.toThrow('archive bytes differ');
});

it.each(['truncated', 'crc', 'extra', 'padding', 'missing', 'size', 'gzip-time'] as const)('rejects malformed archives: %s', async kind => {
  const f = fixture(); let bytes = f.bytes;
  if (kind === 'truncated') bytes = gzipSync(f.raw.subarray(0, -8));
  if (kind === 'crc') { bytes = Buffer.from(bytes); bytes[bytes.length - 8] = bytes[bytes.length - 8]! ^ 1; }
  if (kind === 'extra') bytes = gzipSync(Buffer.concat([f.raw, Buffer.from('extra')]));
  if (kind === 'padding') { const raw = Buffer.from(f.raw); raw[114] = 1; bytes = gzipSync(raw); }
  if (kind === 'missing') f.inventory.entries.pop();
  if (kind === 'size') f.inventory.uncompressedBytes++;
  if (kind === 'gzip-time') { bytes = Buffer.from(bytes); bytes.writeUInt32LE(123, 4); }
  await expect(verifyGuestArchive(await write(bytes), f.inventory)).rejects.toThrow();
});

it('rejects huge declared payloads before allocation or decompression of their contents', async () => {
  const f = fixture();
  const raw = newcEntry([1, 0o100444, 0, 0, 1, 1, 0xffffffff, 0, 0, 0, 0, 0, 0], 'huge');
  await expect(verifyGuestArchive(await write(gzipSync(raw)), f.inventory)).rejects.toThrow('expanded byte limit');
});

it('rejects duplicate paths and invalid hardlink metadata', async () => {
  for (const change of ['path', 'size', 'owner'] as const) {
    const files = [
      { path: 'first', mode: 0o100444, data: Buffer.from('first'), links: 2 },
      { path: change === 'path' ? 'first' : 'second', mode: change === 'owner' ? 0o100644 : 0o100444,
        data: change === 'size' ? Buffer.from('second') : Buffer.alloc(0), inode: 1, links: 2 },
    ];
    const f = newcFixture(files);
    await expect(verifyGuestArchive(await write(f.bytes), f.inventory)).rejects.toThrow(/member|hard link/);
  }
});

it('accepts hard-linked symlinks with repeated target bytes, and rejects conflicting targets', async () => {
  const files = ['first', 'second'].map(path => ({ path, mode: 0o120777, data: Buffer.from('/etc/config'), inode: 1, links: 2 }));
  const f = newcFixture(files);
  await expect(verifyGuestArchive(await write(f.bytes), f.inventory)).resolves.toEqual(identity(f.bytes));
  files[1]!.data = Buffer.from('/other'); const changed = newcFixture(files);
  await expect(verifyGuestArchive(await write(changed.bytes), changed.inventory)).rejects.toThrow('hard link contents');
});
