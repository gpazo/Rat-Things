import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, readlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { captureWorkspace, checkpointHash, checkpointLimits, restoreWorkspace, validateWorkspaceArchive } from '../../src/runner/workspace-checkpoint.js';
import { MutationGate } from '../../src/runner/mutation-gate.js';

const archive = (entries: unknown[]) => gzipSync(JSON.stringify({ version: 1, entries }));
const file = (path: string, text = 'saved') => ({ kind: 'file', path, mode: 0o644, data: Buffer.from(text).toString('base64'), sha256: checkpointHash(Buffer.from(text)) });

describe('immutable workspace archives', () => {
  it('restores committed git/package files and internal links, excludes runtime mounts, and retains the workspace inode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rat-checkpoint-'));
    const source = join(root, 'source'); const destination = join(root, 'destination');
    try {
      for (const path of ['.git/objects', '.packages/lib', 'node_modules/.bin', '.rat-things/artifacts', 'outputs']) await mkdir(join(source, path), { recursive: true });
      await writeFile(join(source, '.git/config'), '[core]\nrepositoryformatversion = 0');
      await writeFile(join(source, '.packages/lib/tool'), 'executable', { mode: 0o755 });
      await symlink('../../.packages/lib/tool', join(source, 'node_modules/.bin/tool'));
      await writeFile(join(source, '.rat-things/artifacts/private'), 'excluded');
      await writeFile(join(source, 'outputs/result'), 'committed');
      const bytes = await captureWorkspace(source);
      const digest = checkpointHash(bytes);
      expect(validateWorkspaceArchive(bytes, digest).entries.some(entry => entry.path.startsWith('.rat-things'))).toBe(false);
      await writeFile(join(source, 'outputs/result'), 'later uncommitted value');
      await mkdir(join(destination, '.rat-things/artifacts'), { recursive: true });
      await writeFile(join(destination, '.rat-things/artifacts/private'), 'new runtime mount');
      await writeFile(join(destination, 'stale'), 'discarded after verification');
      const inode = (await stat(destination)).ino;
      await restoreWorkspace(destination, bytes, digest);
      expect((await stat(destination)).ino).toBe(inode);
      expect(await readFile(join(destination, 'outputs/result'), 'utf8')).toBe('committed');
      expect(await readFile(join(destination, '.git/config'), 'utf8')).toContain('repositoryformatversion');
      expect((await stat(join(destination, '.packages/lib/tool'))).mode & 0o777).toBe(0o755);
      expect(await readlink(join(destination, 'node_modules/.bin/tool'))).toBe('../../.packages/lib/tool');
      expect(await readFile(join(destination, 'node_modules/.bin/tool'), 'utf8')).toBe('executable');
      expect(await readFile(join(destination, '.rat-things/artifacts/private'), 'utf8')).toBe('new runtime mount');
      await expect(stat(join(destination, 'stale'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([
    [file('../escape')], [file('/absolute')], [file('.rat-things/credentials')], [file('same'), file('same')],
    [{ kind: 'link', path: 'parent', mode: 0o777, target: 'safe' }, file('parent/child')],
    [{ kind: 'link', path: 'link', mode: 0o777, target: '../outside' }],
    [{ kind: 'link', path: 'link', mode: 0o777, target: '.rat-things/artifacts' }],
    [{ ...file('invalid-digest'), sha256: '0'.repeat(64) }],
    [{ ...file('bad-mode'), mode: 0o4755 }],
    [{ kind: 'socket', path: 'socket', mode: 0o600 }],
  ])('rejects malicious archive %# before altering the destination', async (...entries) => {
    const root = await mkdtemp(join(tmpdir(), 'rat-invalid-checkpoint-'));
    try {
      await writeFile(join(root, 'keep'), 'untouched');
      const bytes = archive(entries);
      await expect(restoreWorkspace(root, bytes, checkpointHash(bytes))).rejects.toThrow();
      expect(await readFile(join(root, 'keep'), 'utf8')).toBe('untouched');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('accepts a large file within the documented bounds without regex recursion', () => {
    const bytes = archive([file('large', 'a'.repeat(8 * 1024 * 1024))]);
    expect(validateWorkspaceArchive(bytes, checkpointHash(bytes)).entries).toHaveLength(1);
  });

  it('rejects escaped source symlinks and corrupt compressed bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rat-source-checkpoint-'));
    try {
      await symlink('../outside', join(root, 'escape'));
      await expect(captureWorkspace(root)).rejects.toThrow('symlink');
      const bytes = archive([file('proof')]); bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 255;
      expect(() => validateWorkspaceArchive(bytes, checkpointHash(bytes))).toThrow();
      const oversized = archive(Array.from({ length: checkpointLimits.entries + 1 }, (_, n) => ({ kind: 'directory', path: String(n), mode: 0o700 })));
      expect(() => validateWorkspaceArchive(oversized, checkpointHash(oversized))).toThrow('format');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('serializes already admitted operations and recovers its queue after a failed checkpoint', async () => {
    const gate = new MutationGate(); const events: string[] = []; let release!: () => void;
    const first = gate.run(async () => { events.push('file-start'); await new Promise<void>(resolve => { release = resolve; }); events.push('file-finish'); });
    await Promise.resolve();
    const checkpoint = gate.run(async () => { events.push('checkpoint'); throw new Error('capture failed'); });
    const handled = checkpoint.catch(() => {});
    const next = gate.run(async () => { events.push('turn'); });
    release(); await Promise.all([first, handled, next]);
    expect(events).toEqual(['file-start', 'file-finish', 'checkpoint', 'turn']);
  });
});
