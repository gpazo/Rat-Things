import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { copyForkTree } from '../../src/runner/fork-workspace.js';

it('copies independent files and only the root rollout, excluding credentials and transient data', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rat-fork-')));
  try {
    const source = join(root, 'source'), snapshot = join(root, 'snapshot'), child = join(root, 'child');
    for (const path of ['workspace/.rat-things/artifacts', 'codex-home/sessions/day', 'codex-home/sqlite', 'codex-home/browser-profile']) await mkdir(join(source, path), { recursive: true });
    await writeFile(join(source, 'workspace/file'), 'source');
    await writeFile(join(source, 'workspace/.rat-things/artifacts/transient'), 'excluded');
    await writeFile(join(source, 'codex-home/auth.json'), 'excluded');
    await writeFile(join(source, 'codex-home/sessions/day/rollout-root.jsonl'), 'root history');
    await writeFile(join(source, 'codex-home/sessions/day/rollout-child.jsonl'), 'excluded');
    await symlink('file', join(source, 'workspace/link'));
    expect(await copyForkTree(source, snapshot, 'root')).toBe(18);
    await copyForkTree(snapshot, child, 'root');
    expect(await readFile(join(child, 'workspace/link'), 'utf8')).toBe('source');
    await writeFile(join(child, 'workspace/file'), 'child');
    expect(await readFile(join(source, 'workspace/file'), 'utf8')).toBe('source');
    expect(await readFile(join(snapshot, 'workspace/file'), 'utf8')).toBe('source');
    for (const path of ['codex-home/auth.json', 'codex-home/sessions/day/rollout-child.jsonl', 'workspace/.rat-things/artifacts/transient']) await expect(readFile(join(child, path))).rejects.toMatchObject({ code: 'ENOENT' });
    await rm(source, { recursive: true });
    expect(await readFile(join(child, 'codex-home/sessions/day/rollout-root.jsonl'), 'utf8')).toBe('root history');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.each(['link', 'directory', 'bytes', 'deadline'])('rejects unsafe or over-budget copies: %s', async mode => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rat-fork-')));
  try {
    const source = join(root, 'source');
    await mkdir(join(source, 'workspace'), { recursive: true });
    await writeFile(join(source, 'workspace/file'), 'content');
    if (mode === 'link') await symlink('../../outside', join(source, 'workspace/escape'));
    if (mode === 'directory') { await mkdir(join(root, 'outside')); await symlink(join(root, 'outside'), join(source, 'workspace/dir')); }
    await expect(copyForkTree(source, join(root, 'child'), 'root', { ...(mode === 'bytes' ? { maxBytes: 1 } : {}), ...(mode === 'deadline' ? { deadline: 1 } : {}) })).rejects.toThrow('copy failed');
    await expect(readFile(join(root, 'child/workspace/file'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
