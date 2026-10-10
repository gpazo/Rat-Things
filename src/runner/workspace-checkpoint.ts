import { constants } from 'node:fs';
import { chmod, chown, lstat, mkdir, open, readdir, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, posix, resolve } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';

export const checkpointLimits = { archiveBytes: 96 * 1024 * 1024, expandedBytes: 128 * 1024 * 1024, fileBytes: 32 * 1024 * 1024, totalBytes: 80 * 1024 * 1024, entries: 20_000 };
type Entry = { path: string; mode: number } & ({ kind: 'directory' } | { kind: 'link'; target: string } | { kind: 'file'; data: string; sha256: string });
interface Archive { version: 1; entries: Entry[] }
export const checkpointHash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const excluded = (path: string) => path === '.rat-things' || path.startsWith('.rat-things/');
function validPath(path: string): boolean {
  return path.length > 0 && path.length <= 2048 && !path.includes('\\') && !path.includes('\0') && !path.startsWith('/')
    && path.split('/').length <= 64 && path.split('/').every(part => part !== '' && part !== '.' && part !== '..') && !excluded(path);
}
function validLink(path: string, target: string): boolean {
  if (!target || target.length > 2048 || target.startsWith('/') || target.includes('\\') || target.includes('\0')) return false;
  const destination = posix.normalize(posix.join(posix.dirname(path), target));
  return destination !== '..' && !destination.startsWith('../') && !excluded(destination);
}

export async function captureWorkspace(root: string, signal?: AbortSignal): Promise<Buffer> {
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Checkpoint workspace is invalid');
  const entries: Entry[] = [];
  let total = 0;
  const walk = async (directory: string, prefix: string): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      signal?.throwIfAborted();
      const path = prefix ? `${prefix}/${name}` : name;
      if (excluded(path)) continue;
      if (!validPath(path) || entries.length >= checkpointLimits.entries) throw new Error('Checkpoint path or entry limit exceeded');
      const absolute = join(directory, name);
      const state = await lstat(absolute);
      if (state.dev !== rootStat.dev) throw new Error('Checkpoint cannot cross a workspace mount');
      const mode = state.mode & 0o777;
      if (state.isSymbolicLink()) {
        const target = await readlink(absolute);
        if (!validLink(path, target)) throw new Error('Checkpoint symlink escapes its workspace');
        entries.push({ kind: 'link', path, mode, target });
      } else if (state.isDirectory()) {
        entries.push({ kind: 'directory', path, mode });
        await walk(absolute, path);
      } else if (state.isFile()) {
        total += state.size;
        if (state.size > checkpointLimits.fileBytes || total > checkpointLimits.totalBytes) throw new Error('Checkpoint file size limit exceeded');
        const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const current = await file.stat();
          if (current.ino !== state.ino || current.dev !== state.dev || current.size !== state.size) throw new Error('Checkpoint file changed');
          const bytes = await file.readFile();
          if (bytes.length !== state.size) throw new Error('Checkpoint file changed');
          entries.push({ kind: 'file', path, mode, data: bytes.toString('base64'), sha256: checkpointHash(bytes) });
        } finally { await file.close(); }
      } else throw new Error('Checkpoint contains an unsupported special file');
    }
  };
  await walk(root, '');
  signal?.throwIfAborted();
  const json = Buffer.from(JSON.stringify({ version: 1, entries }));
  if (json.length > checkpointLimits.expandedBytes) throw new Error('Checkpoint expanded size exceeded');
  const compressed = gzipSync(json, { level: 1 });
  if (compressed.length > checkpointLimits.archiveBytes) throw new Error('Checkpoint archive size exceeded');
  return compressed;
}

export function validateWorkspaceArchive(bytes: Uint8Array, digest: string): Archive {
  if (!bytes.length || bytes.length > checkpointLimits.archiveBytes || checkpointHash(bytes) !== digest) throw new Error('Checkpoint archive integrity failed');
  const value: unknown = JSON.parse(gunzipSync(bytes, { maxOutputLength: checkpointLimits.expandedBytes }).toString('utf8'));
  if (!record(value) || value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > checkpointLimits.entries) throw new Error('Checkpoint archive format is invalid');
  const paths = new Map<string, string>();
  let total = 0;
  for (const entry of value.entries) {
    if (!record(entry) || typeof entry.path !== 'string' || !validPath(entry.path) || paths.has(entry.path)
      || !Number.isInteger(entry.mode) || Number(entry.mode) < 0 || Number(entry.mode) > 0o777) throw new Error('Checkpoint entry is invalid');
    const parent = posix.dirname(entry.path);
    if (parent !== '.' && paths.get(parent) !== 'directory') throw new Error('Checkpoint parent is not a directory');
    if (entry.kind === 'file') {
      if (typeof entry.data !== 'string' || entry.data.length > Math.ceil(checkpointLimits.fileBytes / 3) * 4 || typeof entry.sha256 !== 'string') throw new Error('Checkpoint file is invalid');
      const data = Buffer.from(entry.data, 'base64');
      total += data.length;
      if (data.toString('base64') !== entry.data || data.length > checkpointLimits.fileBytes || total > checkpointLimits.totalBytes || checkpointHash(data) !== entry.sha256) throw new Error('Checkpoint file integrity failed');
    } else if (entry.kind === 'link') {
      if (typeof entry.target !== 'string' || !validLink(entry.path, entry.target)) throw new Error('Checkpoint symlink is invalid');
    } else if (entry.kind !== 'directory') throw new Error('Checkpoint entry type is invalid');
    paths.set(entry.path, entry.kind);
  }
  return value as unknown as Archive;
}

export async function restoreWorkspace(root: string, bytes: Uint8Array, digest: string, identity?: { uid: number; gid: number }, signal?: AbortSignal): Promise<void> {
  const archive = validateWorkspaceArchive(bytes, digest);
  const state = await lstat(root);
  if (!state.isDirectory() || state.isSymbolicLink()) throw new Error('Checkpoint destination is invalid');
  const stage = join(dirname(resolve(root)), `.checkpoint-restore-${randomUUID()}`);
  const backup = join(stage, 'previous');
  const data = join(stage, 'data');
  await mkdir(data, { recursive: true, mode: 0o700 });
  await mkdir(backup, { mode: 0o700 });
  const moved: string[] = [];
  const installed: string[] = [];
  try {
    for (const entry of archive.entries) {
      signal?.throwIfAborted();
      const path = join(data, entry.path);
      if (entry.kind === 'directory') await mkdir(path, { mode: 0o700 });
      else if (entry.kind === 'file') await writeFile(path, Buffer.from(entry.data, 'base64'), { flag: 'wx', mode: 0o600 });
      else await symlink(entry.target, path);
      if (entry.kind !== 'link') {
        if (identity) await chown(path, identity.uid, identity.gid);
        if (entry.kind === 'file') await chmod(path, entry.mode);
      }
    }
    for (const entry of [...archive.entries].reverse()) if (entry.kind === 'directory') await chmod(join(data, entry.path), entry.mode);
    signal?.throwIfAborted();
    for (const name of await readdir(root)) {
      signal?.throwIfAborted();
      if (excluded(name)) continue;
      await rename(join(root, name), join(backup, name)); moved.push(name);
    }
    for (const name of await readdir(data)) { signal?.throwIfAborted(); await rename(join(data, name), join(root, name)); installed.push(name); }
  } catch (error) {
    for (const name of installed) await rm(join(root, name), { recursive: true, force: true });
    for (const name of moved) await rename(join(backup, name), join(root, name));
    throw error;
  } finally { await rm(stage, { recursive: true, force: true }); }
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
