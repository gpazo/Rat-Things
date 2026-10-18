import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { AgentsStore } from '../core/agents-ports.js';
import type { SessionState } from '../core/session-ports.js';
import type { SessionFork } from '../domain/session-fork.js';
import { forkSnapshotStorageKey } from '../domain/workspace-checkpoint.js';
import { WorkspaceHandoffService } from '../core/workspace-handoff-service.js';
import { runProcess } from './process.js';
import { syncWorkspaceStorage } from './workspace-sync.js';

/** The copier uses directory handles and O_NOFOLLOW for every source and destination component. */
export async function copyForkTree(source: string, destination: string, rootThreadId: string, options: { runtime?: 'codex' | 'pi'; maxBytes?: number; deadline?: number; uid?: number; gid?: number; signal?: AbortSignal } = {}): Promise<number> {
  if (options.runtime !== 'pi' && !/^[A-Za-z0-9-]+$/.test(rootThreadId)) throw new Error('Invalid native fork identity');
  const result = await runProcess('python3', ['-c', copier, source, destination, options.runtime === 'pi' ? '' : rootThreadId,
    String(options.maxBytes ?? 256 * 1024 * 1024), String(options.deadline ?? Math.floor(Date.now() / 1000) + 90),
    String(options.uid ?? process.getuid?.() ?? 10001), String(options.gid ?? process.getgid?.() ?? 10001)],
  { cwd: '/', timeoutMs: 95_000, ...(options.signal ? { signal: options.signal } : {}) });
  if (result.exitCode !== 0) throw new Error('Fork workspace copy failed or exceeded its limits');
  const bytes = Number(result.stdout.toString('utf8').trim());
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid fork copy receipt');
  return bytes;
}

export async function prepareForkWorkspace(options: { store: AgentsStore; ownerId: string; sessionId: string; stateRoot: string; fork: Omit<SessionFork, 'history'>; signal?: AbortSignal }): Promise<void> {
  const { store, ownerId, sessionId, stateRoot, fork } = options;
  const key = (id: string) => createHash('sha256').update(JSON.stringify([ownerId, id])).digest('hex');
  if (stateRoot.split('/').at(-1) !== key(sessionId) || fork.sourceSessionId === sessionId
    || fork.storageKey !== forkSnapshotStorageKey(ownerId, fork.sourceSessionId, fork.checkpoint.id, fork.lease.id)) throw new Error('Invalid fork storage identity');
  const source = await store.get<import('../core/environment-service.js').StoredEnvironment>(ownerId, 'environments', fork.sourceEnvironmentId);
  const handoff = source?.value.handoff;
  if (source?.value.sessionId !== fork.sourceSessionId || source.value.retired || handoff?.phase !== 'committed'
    || handoff.checkpoint.id !== fork.checkpoint.id || handoff.snapshotLease?.id !== fork.lease.id
    || handoff.snapshotLease.expiresAt <= Date.now() / 1000) throw new Error('Fork source lease is unavailable');
  const root = dirname(stateRoot);
  const snapshotRoot = join(root, fork.storageKey);
  const copyOptions = { ...(fork.piContextId ? { runtime: 'pi' as const } : {}), deadline: Math.min(fork.lease.expiresAt - 5, Math.floor(Date.now() / 1000) + 90), uid: 10001, gid: 10001, ...(options.signal ? { signal: options.signal } : {}) };
  const bytes = await copyForkTree(join(root, key(fork.sourceSessionId)), snapshotRoot, fork.checkpoint.rootThreadId, copyOptions);
  await syncWorkspaceStorage(snapshotRoot);
  const handoffs = new WorkspaceHandoffService({ store, enabled: true });
  await handoffs.publishSnapshot(ownerId, fork.sourceEnvironmentId, fork.checkpoint.id, fork.lease.id, bytes);
  // The source may resume only after immutable content is published. The child now reads its own snapshot.
  for (let attempt = 0; attempt < 5; attempt++) {
    const sourceSession = await store.get<SessionState>(ownerId, 'sessions', fork.sourceSessionId);
    if (!sourceSession || sourceSession.value.forkLock?.id !== sessionId) break;
    const { forkLock: _lock, ...value } = sourceSession.value;
    try { await store.put({ ...sourceSession, revision: sourceSession.revision + 1, value }, sourceSession.revision); break; }
    catch (error) { if (attempt === 4) throw error; }
  }
  await copyForkTree(snapshotRoot, stateRoot, fork.checkpoint.rootThreadId, { ...copyOptions, deadline: Math.floor(Date.now() / 1000) + 90 });
  await syncWorkspaceStorage(stateRoot);
}

const copier = String.raw`
import os, sys, stat, time, posixpath
src, dst, thread, cap, deadline, uid, gid = sys.argv[1:]
cap, deadline, uid, gid = int(cap), int(deadline), int(uid), int(gid)
size = 0
entries = 0
created = []
success = False
directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
def directory(path, create=False):
    if not path.startswith('/') or any(p in ('.', '..') for p in path.split('/')): raise RuntimeError('invalid root')
    fd = os.open('/', directory_flags)
    try:
        walked = ''
        for part in path.split('/'):
            if not part: continue
            walked += '/' + part
            if create:
                try:
                    os.mkdir(part, 0o700, dir_fd=fd)
                    created.append((walked, True))
                except FileExistsError: pass
            new = os.open(part, directory_flags, dir_fd=fd)
            os.close(fd)
            fd = new
        return fd
    except:
        os.close(fd)
        raise
def budget():
    global entries
    entries += 1
    if entries > 50000 or time.time() >= deadline: raise RuntimeError('copy limit')
def tree(s, d, path, history=False):
    global size
    for name in sorted(os.listdir(s)):
        budget()
        if '/' in name or name in ('.', '..'): raise RuntimeError('invalid entry')
        rel = path + '/' + name
        if rel == 'workspace/.rat-things/artifacts': continue
        info = os.stat(name, dir_fd=s, follow_symlinks=False)
        if stat.S_ISDIR(info.st_mode):
            child = os.open(name, directory_flags, dir_fd=s)
            try:
                try:
                    os.mkdir(name, 0o700, dir_fd=d)
                    created.append((dst + '/' + rel, True))
                except FileExistsError: pass
                target = os.open(name, directory_flags, dir_fd=d)
                try:
                    os.fchown(target, uid, gid)
                    tree(child, target, rel, history)
                    os.fsync(target)
                finally: os.close(target)
            finally: os.close(child)
        elif history and not name.endswith('-' + thread + '.jsonl'): continue
        elif stat.S_ISLNK(info.st_mode):
            if history: raise RuntimeError('history link')
            link = os.readlink(name, dir_fd=s)
            resolved = posixpath.normpath(posixpath.join(posixpath.dirname(rel), link))
            if link.startswith('/') or not (resolved == 'workspace' or resolved.startswith('workspace/')): raise RuntimeError('escaping link')
            os.symlink(link, name, dir_fd=d)
            created.append((dst + '/' + rel, False))
            os.chown(name, uid, gid, dir_fd=d, follow_symlinks=False)
        elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
            handle = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=s)
            try:
                actual = os.fstat(handle)
                if not stat.S_ISREG(actual.st_mode) or actual.st_nlink != 1 or (actual.st_dev, actual.st_ino) != (info.st_dev, info.st_ino): raise RuntimeError('source changed')
                size += actual.st_size
                if size > cap: raise RuntimeError('byte limit')
                target = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o700 if actual.st_mode & 0o111 else 0o600, dir_fd=d)
                created.append((dst + '/' + rel, False))
                try:
                    remaining = actual.st_size
                    while remaining:
                        budget()
                        data = os.read(handle, min(1024 * 1024, remaining))
                        if not data: raise RuntimeError('short read')
                        remaining -= len(data)
                        while data: data = data[os.write(target, data):]
                    if os.read(handle, 1): raise RuntimeError('source grew')
                    os.fchown(target, uid, gid)
                    os.fsync(target)
                finally: os.close(target)
            finally: os.close(handle)
        else: raise RuntimeError('unsupported entry')
source = destination = None
try:
    source = directory(src)
    destination = directory(dst, True)
    for sub in (('workspace',) if not thread else ('workspace', 'codex-home/sessions', 'codex-home/archived_sessions')):
        try: s = directory(src + '/' + sub)
        except FileNotFoundError:
            if sub == 'workspace': raise
            continue
        d = directory(dst + '/' + sub, True)
        try:
            os.fchown(d, uid, gid)
            tree(s, d, sub, sub != 'workspace')
            os.fsync(d)
        finally:
            os.close(s)
            os.close(d)
    os.fsync(destination)
    print(size)
    success = True
finally:
    if source is not None: os.close(source)
    if destination is not None: os.close(destination)
    if not success:
        for path, isdir in reversed(created):
            try:
                parent = directory(posixpath.dirname(path))
                try:
                    if isdir: os.rmdir(posixpath.basename(path), dir_fd=parent)
                    else: os.unlink(posixpath.basename(path), dir_fd=parent)
                finally: os.close(parent)
            except OSError: pass
`;
