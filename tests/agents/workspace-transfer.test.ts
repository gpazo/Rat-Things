import { expect, it } from 'vitest';
import { archiveWorkspace, restoreWorkspaceCommand } from '../../src/domain/workspace-transfer.js';
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
    const program = command.slice("python3 -c '".length, -1).replaceAll("'\\''", "'").replaceAll("'/workspace", `'${root}`);
    await promisify(execFile)('python3', ['-c', program]);
    expect(await readFile(join(root, 'bin/run'), 'utf8')).toBe('echo home');
    expect((await stat(join(root, 'bin/run'))).mode & 0o777).toBe(0o755);
    expect(await readlink(join(root, 'run'))).toBe('bin/run');
    expect(await readFile(join(root, '__proto__'), 'utf8')).toBe('');
    expect((await stat(join(root, 'empty'))).isDirectory()).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
it('rejects traversal, ambiguous data and escaping symlinks before creating an archive', () => {
  for (const path of ['../escape', '/absolute', 'a/../../b', 'a\\b', 'a//b', '.rat-transfer/part-0']) expect(() => archiveWorkspace([{ path, data: '', mode: 0o600 }])).toThrow();
  expect(() => archiveWorkspace([{ path: 'link', data: '', mode: 0o777, link: '../escape' }])).toThrow();
  expect(() => archiveWorkspace([{ path: 'file', data: 'not base64', mode: 0o600 }])).toThrow();
  expect(() => restoreWorkspaceCommand('invalid')).toThrow();
});
it('recognizes local engines without classifying a remote URL as a VM socket', () => {
  expect(classifyLocalEngine('unix:///Users/me/.colima/default/docker.sock', 'darwin')).toBe('colima');
  expect(classifyLocalEngine('unix:///Users/me/.docker/run/docker.sock', 'darwin')).toBe('docker-desktop');
  expect(classifyLocalEngine('unix:///Users/me/.orbstack/run/docker.sock', 'darwin')).toBe('orbstack');
  expect(classifyLocalEngine('tcp://example.com:2375', 'darwin')).toBe('unknown');
  expect(() => localWorkerNames('0123456789abcdef', '../escape')).toThrow();
});
