import { expect, it } from 'vitest';
import { archiveWorkspace, restoreWorkspaceCommand, WORKSPACE_EXPORT_SCRIPT, type PortableFile } from '../../src/domain/workspace-transfer.js';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import { classifyLocalEngine, localWorkerNames } from '../../src/domain/local-runtime.js';
import { mkdtemp, mkdir, readFile, readlink, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

it('copies executable files and internal symlinks with digest verification and no host paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rat-restore-'));
  try {
    const { archive, sha256 } = archiveWorkspace([{ path: 'empty', data: '', mode: 0o700, directory: true }, { path: 'bin/run', data: Buffer.from('echo home').toString('base64'), mode: 0o755 }, { path: 'run', data: '', mode: 0o777, link: 'bin/run' }, { path: '__proto__', data: '', mode: 0o600 }]);
    await mkdir(join(root, '.rat-transfer'));
    await writeFile(join(root, '.rat-transfer/part-0'), archive);
    const command = restoreWorkspaceCommand(sha256);
    await promisify(execFile)('bash', ['-c', command.replaceAll('/workspace/', `${root}/`).replaceAll("/workspace'", `${root}'`)]);
    expect(await readFile(join(root, 'bin/run'), 'utf8')).toBe('echo home');
    expect((await stat(join(root, 'bin/run'))).mode & 0o777).toBe(0o755);
    expect(await readlink(join(root, 'run'))).toBe('bin/run');
    expect(await readFile(join(root, '__proto__'), 'utf8')).toBe('');
    expect((await stat(join(root, 'empty'))).isDirectory()).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
it('rejects traversal, ambiguous data and escaping symlinks before creating an archive', () => {
  for (const path of ['../escape', '/absolute', 'a/../../b', 'a\\b', 'a//b', '.rat-transfer/part-0', 'codex-bwrap-synthetic-mount-targets-10001', 'codex-bwrap-synthetic-mount-targets-42/lock']) expect(() => archiveWorkspace([{ path, data: '', mode: 0o600 }])).toThrow();
  expect(() => archiveWorkspace([{ path: 'link', data: '', mode: 0o777, link: '../escape' }])).toThrow();
  expect(() => archiveWorkspace([{ path: 'file', data: 'not base64', mode: 0o600 }])).toThrow();
  expect(() => restoreWorkspaceCommand('invalid')).toThrow();
});
it('exports user workspace data while leaving each executor its own sandbox registry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rat-export-'));
  try {
    for (const directory of ['.rat-transfer', 'codex-bwrap-synthetic-mount-targets-10001', 'codex-bwrap-synthetic-mount-targets-42', '.packages', 'outputs']) {
      await mkdir(join(root, directory));
      await writeFile(join(root, directory, 'lock'), 'content');
    }
    await writeFile(join(root, 'codex-bwrap-synthetic-mount-targets-notes'), 'user notes');
    const result = await promisify(execFile)(process.execPath, ['-e', WORKSPACE_EXPORT_SCRIPT.replaceAll('/workspace/', `${root}/`)]);
    const files = JSON.parse(result.stdout) as PortableFile[];
    expect(files.map(file => file.path).sort()).toEqual(['.packages', '.packages/lock', 'codex-bwrap-synthetic-mount-targets-notes', 'outputs', 'outputs/lock']);
    expect(archiveWorkspace(files).files).toBe(5);
  } finally { await rm(root, { recursive: true, force: true }); }
});
it.each(['.rat-transfer', 'codex-bwrap-synthetic-mount-targets-10001/lock'])('rejects an incoming reserved path %s before extracting any entry', async path => {
  const root = await mkdtemp(join(tmpdir(), 'rat-reserved-'));
  try {
    const archive = zipSync({ 'proof.txt': Buffer.from('changed'), [path]: Buffer.from('hostile') });
    await mkdir(join(root, '.rat-transfer'));
    await writeFile(join(root, '.rat-transfer/part-0'), archive);
    await writeFile(join(root, 'proof.txt'), 'original');
    const command = restoreWorkspaceCommand(createHash('sha256').update(archive).digest('hex'));
    await expect(promisify(execFile)('bash', ['-c', command.replaceAll('/workspace/', `${root}/`).replaceAll("/workspace'", `${root}'`)])).rejects.toThrow();
    expect(await readFile(join(root, 'proof.txt'), 'utf8')).toBe('original');
  } finally { await rm(root, { recursive: true, force: true }); }
});
it('recognizes local engines without classifying a remote URL as a VM socket', () => {
  expect(classifyLocalEngine('unix:///Users/me/.colima/default/docker.sock', 'darwin')).toBe('colima');
  expect(classifyLocalEngine('unix:///Users/me/.docker/run/docker.sock', 'darwin')).toBe('docker-desktop');
  expect(classifyLocalEngine('unix:///Users/me/.orbstack/run/docker.sock', 'darwin')).toBe('orbstack');
  expect(classifyLocalEngine('tcp://example.com:2375', 'darwin')).toBe('unknown');
  expect(() => localWorkerNames('0123456789abcdef', '../escape')).toThrow();
});
