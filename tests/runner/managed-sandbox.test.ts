import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { verifyManagedSandbox } from '../../src/runner/managed-sandbox.js';

const execute = promisify(execFile);

it('refuses an executor that ignores the sandbox and actually writes outside the workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rat-unconfined-executor-'));
  const workspace = await mkdtemp(join(root, 'workspace-'));
  const home = await mkdtemp(join(root, 'home-'));
  let ranUnsandboxed = false;
  try {
    await expect(verifyManagedSandbox({ workspace, home, call: async (_method, raw) => {
      const { command, cwd } = raw as { command: string[]; cwd: string };
      ranUnsandboxed = true;
      try {
        const result = await execute(command[0]!, command.slice(1), { cwd });
        return { ...result, exitCode: 0 };
      } catch (error) {
        const result = error as { code: number; stdout: string; stderr: string };
        return { exitCode: result.code, stdout: result.stdout, stderr: result.stderr };
      }
    } })).rejects.toThrow('Refusing to expose execution tools');
    expect(ranUnsandboxed).toBe(true);
    expect(await readdir(workspace)).toEqual([]);
    expect(await readdir(home)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.each(['unavailable', 'incomplete'])('fails closed when sandbox verification is %s', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'rat-sandbox-probe-'));
  const workspace = await mkdtemp(join(root, 'workspace-'));
  const home = await mkdtemp(join(root, 'home-'));
  try {
    await expect(verifyManagedSandbox({ workspace, home, call: async () => {
      if (mode === 'unavailable') throw new Error('Unsupported native permission profile');
      return { exitCode: 0, stdout: '', stderr: '' };
    } })).rejects.toThrow('Refusing to expose execution tools');
    expect(await readdir(workspace)).toEqual([]);
    expect(await readdir(home)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
