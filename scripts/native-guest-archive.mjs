import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isDeepStrictEqual } from 'node:util';
import { createGunzip } from 'node:zlib';
import { regularFileChunks } from './native-build-files.mjs';

const limits = { compressedBytes: 600 * 1024 ** 2, expandedBytes: 1400 * 1024 ** 2, entries: 100_000 };
const decode = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const safePath = path => path.length > 0 && Buffer.byteLength(path) <= 1024 && path.normalize('NFC') === path
  && !/[\\\u0000-\u001f\u007f]/.test(path) && path.split('/').length <= 32
  && path.split('/').every(part => part && part !== '.' && part !== '..' && Buffer.byteLength(part) <= 255);

function headerFields(bytes) {
  if (bytes.subarray(0, 6).toString() !== '070701' || !/^[a-fA-F0-9]{104}$/.test(bytes.subarray(6).toString())) {
    throw new Error('Invalid guest newc header.');
  }
  return Array.from({ length: 13 }, (_, index) => parseInt(bytes.subarray(6 + index * 8, 14 + index * 8).toString(), 16));
}

function reader(stream) {
  const iterator = stream[Symbol.asyncIterator](); let chunk = Buffer.alloc(0); let offset = 0; let bytes = 0;
  const available = async () => {
    if (offset < chunk.length) return true;
    const next = await iterator.next();
    if (next.done) return false;
    chunk = next.value; offset = 0;
    return true;
  };
  const consume = async (length, visit) => {
    if (bytes + length > limits.expandedBytes) throw new Error('Guest archive exceeds its expanded byte limit.');
    let remaining = length;
    while (remaining) {
      if (!await available()) throw new Error('Truncated guest newc archive.');
      const size = Math.min(remaining, chunk.length - offset);
      visit(chunk.subarray(offset, offset + size)); offset += size; bytes += size; remaining -= size;
    }
  };
  const take = async length => {
    const result = Buffer.alloc(length); let copied = 0;
    await consume(length, part => { part.copy(result, copied); copied += part.length; });
    return result;
  };
  const padding = async length => {
    if ((await take(length)).some(byte => byte !== 0)) throw new Error('Nonzero guest newc padding.');
  };
  return { consume, take, padding, available, count: () => bytes };
}

/** Verify the actual gzip/newc payload against its complete inventory and compressed identity. */
export async function verifyGuestArchive(filename, inventory, expected) {
  if (inventory?.format !== 'newc' || !Number.isInteger(inventory.sourceDateEpoch)
    || inventory.sourceDateEpoch < 0 || inventory.sourceDateEpoch > 0xffffffff
    || !Array.isArray(inventory.entries) || inventory.entries.length > limits.entries
    || !Number.isSafeInteger(inventory.uncompressedBytes) || inventory.uncompressedBytes < 124
    || inventory.uncompressedBytes > limits.expandedBytes) throw new Error('Invalid guest archive inventory.');
  const compressedHash = createHash('sha256'); let compressedBytes = 0;
  const source = Readable.from((async function* () {
    for await (const chunk of regularFileChunks(filename, limits.compressedBytes)) {
      if (compressedBytes === 0 && (chunk.length < 10 || chunk[0] !== 0x1f || chunk[1] !== 0x8b
        || chunk[2] !== 8 || chunk[3] !== 0 || chunk.readUInt32LE(4) !== 0)) throw new Error('Guest gzip header is not normalized.');
      compressedBytes += chunk.length; compressedHash.update(chunk); yield chunk;
    }
  })());
  const expanded = createGunzip();
  const completion = pipeline(source, expanded); completion.catch(() => {});
  const input = reader(expanded); const paths = new Set(); const inodes = new Map(); let count = 0;
  try {
    for (;;) {
      const fields = headerFields(await input.take(110));
      const [inode, mode, uid, gid, links, mtime, size, devMajor, devMinor, major, minor, nameSize, checksum] = fields;
      if (nameSize < 2 || nameSize > 1025 || devMajor !== 0 || devMinor !== 0 || checksum !== 0) throw new Error('Invalid guest newc metadata.');
      const nameBytes = await input.take(nameSize);
      if (nameBytes.at(-1) !== 0) throw new Error('Unterminated guest newc name.');
      const path = decode(nameBytes.subarray(0, -1));
      await input.padding((-(110 + nameSize)) & 3);
      if (path === 'TRAILER!!!') {
        if (!isDeepStrictEqual(fields, [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 11, 0])) throw new Error('Invalid guest newc trailer.');
        break;
      }
      if (++count > limits.entries || !safePath(path) || paths.has(path) || inode === 0 || links === 0
        || mtime !== inventory.sourceDateEpoch) throw new Error('Invalid guest newc member.');
      paths.add(path);
      const kind = mode & 0o170000;
      if (![0o100000, 0o120000, 0o040000, 0o020000, 0o060000, 0o010000].includes(kind)
        || (![0o100000, 0o120000].includes(kind) && size !== 0)
        || (![0o020000, 0o060000].includes(kind) && (major !== 0 || minor !== 0))) throw new Error('Unsupported guest newc member type.');
      const member = { path, mode, uid, gid, inode, links, mtime, bytes: size };
      const prior = inodes.get(inode);
      if (prior && (kind === 0o040000 || prior.kind !== kind || prior.mode !== mode || prior.uid !== uid
        || prior.gid !== gid || prior.links !== links || links < 2 || (kind === 0o100000 && size !== 0))) throw new Error('Invalid guest newc hard link.');
      if (kind === 0o120000) {
        if (size > 4096) throw new Error('Guest symlink target exceeds its byte limit.');
        const target = await input.take(size); member.target = decode(target);
        if (!member.target || member.target.includes('\0')) throw new Error('Invalid guest symlink target.');
        member.sha256 = createHash('sha256').update(target).digest('hex');
      } else {
        const hash = createHash('sha256'); await input.consume(size, bytes => hash.update(bytes));
        if (kind === 0o100000) member.sha256 = prior?.sha256 ?? hash.digest('hex');
      }
      await input.padding((-size) & 3);
      if ([0o020000, 0o060000].includes(kind)) member.device = { major, minor };
      if (prior && kind !== 0o100000 && !isDeepStrictEqual(
        { bytes: member.bytes, sha256: member.sha256, target: member.target, device: member.device },
        { bytes: prior.bytes, sha256: prior.sha256, target: prior.target, device: prior.device })) throw new Error('Invalid guest newc hard link contents.');
      if (!isDeepStrictEqual(member, inventory.entries[count - 1])) throw new Error(`Guest archive bytes differ from its inventory: ${path}.`);
      if (!prior) inodes.set(inode, { ...member, kind });
    }
    if (await input.available() || count !== inventory.entries.length || input.count() !== inventory.uncompressedBytes) {
      throw new Error('Guest archive membership or expanded size differs from its inventory.');
    }
    await completion;
    const identity = { bytes: compressedBytes, sha256: compressedHash.digest('hex') };
    if (expected && !isDeepStrictEqual(identity, { bytes: expected.bytes, sha256: expected.sha256 })) throw new Error('Guest archive changed during verification.');
    return identity;
  } finally {
    source.destroy(); expanded.destroy(); await completion.catch(() => {});
  }
}
