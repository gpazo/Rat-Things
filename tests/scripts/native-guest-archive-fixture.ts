import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

export function newcEntry(fields: number[], name: string, data = Buffer.alloc(0)): Buffer {
  const nameBytes = Buffer.from(name + '\0');
  const values = [...fields]; values[11] = nameBytes.length;
  const header = Buffer.from('070701' + values.map(value => value.toString(16).padStart(8, '0')).join(''));
  return Buffer.concat([header, nameBytes, Buffer.alloc((-(110 + nameBytes.length)) & 3), data, Buffer.alloc((-data.length) & 3)]);
}

export function newcFixture(files: { path: string; data: Buffer; mode: number; inode?: number; links?: number; device?: { major: number; minor: number } }[]) {
  const hashes = new Map<number, string>();
  const entries = files.map((file, index) => {
    const inode = file.inode ?? index + 1; const kind = file.mode & 0o170000;
    const sha256 = (kind === 0o100000 ? hashes.get(inode) : undefined) ?? createHash('sha256').update(file.data).digest('hex'); hashes.set(inode, sha256);
    return { path: file.path, mode: file.mode, uid: 0, gid: 0, inode, links: file.links ?? 1, mtime: 1, bytes: file.data.length,
      ...([0o100000, 0o120000].includes(kind) ? { sha256 } : {}),
      ...(kind === 0o120000 ? { target: file.data.toString() } : {}), ...(file.device ? { device: file.device } : {}) };
  });
  const raw = Buffer.concat([...entries.map((file, index) => newcEntry([file.inode, file.mode, file.uid, file.gid, file.links, file.mtime,
    file.bytes, 0, 0, file.device?.major ?? 0, file.device?.minor ?? 0, 0, 0], file.path, files[index]!.data)),
  newcEntry([0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0], 'TRAILER!!!')]);
  return { raw, bytes: gzipSync(raw), inventory: { format: 'newc', sourceDateEpoch: 1, uncompressedBytes: raw.length, entries } };
}
