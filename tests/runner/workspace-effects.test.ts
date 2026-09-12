import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProcessOptions, ProcessResult } from '../../src/runner/process.js';
import type { RepositoryInput } from '../../src/domain/contracts.js';
import { CredentialBroker } from '../../src/credentials/broker.js';

const run = vi.hoisted(() => vi.fn<(command: string, args: string[], options: ProcessOptions) => Promise<ProcessResult>>());
vi.mock('../../src/runner/process.js', () => ({ runProcess: run }));

import { collectWorkspacePatch, prepareWorkspace } from '../../src/runner/workspace.js';

const roots: string[] = [];
beforeEach(() => {
  run.mockReset().mockResolvedValue(result());
  vi.stubEnv('RUN_AGENT_UID', '');
  vi.stubEnv('RUN_AGENT_GID', '');
  vi.stubEnv('ALLOWED_REPOSITORY_HOSTS', undefined);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function result(exitCode = 0, stdout = Buffer.alloc(0), stderr = ''): ProcessResult {
  return { exitCode, stdout, stderr: Buffer.from(stderr), durationMs: 1 };
}

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'rat-workspace-effects-'));
  roots.push(root);
  vi.stubEnv('WORKSPACE_ROOT', root);
  return join(root, 'workspace');
}

function credentials() {
  return new CredentialBroker({ get: vi.fn() });
}

const repository: RepositoryInput = { provider: 'github', url: 'https://github.com/owner/repo.git' };

describe('workspace preparation effects', () => {
  it('returns for a reusable checkout without validating the repository or changing its files', async () => {
    const target = await workspace();
    await mkdir(join(target, '.git'), { recursive: true });
    await writeFile(join(target, 'staged.txt'), 'keep');
    vi.stubEnv('RUN_AGENT_UID', 'invalid');
    const broker = credentials();
    const read = vi.spyOn(broker, 'read');

    await prepareWorkspace({ ...repository, url: 'invalid', credentialSecretArn: 'secret-ref' }, target, broker, { reuseExisting: true });
    expect(await readFile(join(target, 'staged.txt'), 'utf8')).toBe('keep');
    expect(run).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it('preserves the existing reset-before-validation ordering for a fresh checkout', async () => {
    const target = await workspace();
    await mkdir(target);
    await writeFile(join(target, 'old.txt'), 'old');
    const broker = credentials();
    const read = vi.spyOn(broker, 'read');

    await expect(prepareWorkspace({ ...repository, url: 'http://github.com/repo' }, target, broker)).rejects.toThrow('repository URL is not allowed');
    await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(run).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it('hands off the directory before reading credentials and runs Git commands sequentially with one authenticated environment', async () => {
    const target = await workspace();
    vi.stubEnv('RUN_AGENT_UID', '10001');
    vi.stubEnv('RUN_AGENT_GID', '10002');
    vi.stubEnv('GIT_TRUSTED_HOME', '/trusted-before-read');
    vi.stubEnv('GIT_ASKPASS_PATH', '/askpass-before-read');
    const events: string[] = [];
    run.mockImplementation(async (command, args) => {
      events.push(command === 'chown' ? 'handoff' : args[0] === 'init' ? 'init' : args[2]!);
      return result();
    });
    const broker = credentials();
    const read = vi.spyOn(broker, 'read').mockImplementation(async () => {
      await access(target);
      events.push('credential');
      vi.stubEnv('GIT_TRUSTED_HOME', '/trusted-after-read');
      vi.stubEnv('GIT_ASKPASS_PATH', '/askpass-after-read');
      return '';
    });

    await prepareWorkspace({ ...repository, credentialSecretArn: 'secret-ref', ref: 'feature', baseRef: 'main' }, target, broker);
    expect(events).toEqual(['handoff', 'credential', 'init', 'remote', 'fetch', 'checkout', 'fetch', 'update-ref', 'handoff']);
    expect(read).toHaveBeenCalledExactlyOnceWith('secret-ref', ['token', 'access_token', 'password']);
    const gitCalls = run.mock.calls.filter(([command]) => command === 'git');
    expect(gitCalls).toHaveLength(6);
    const environment = gitCalls[0]![2].env;
    expect(environment).toMatchObject({ HOME: '/trusted-before-read', GIT_TOKEN: '', GIT_USERNAME: 'x-access-token', GIT_ASKPASS: '/askpass-after-read' });
    for (const [, args, options] of gitCalls) {
      expect(args.join(' ')).not.toContain('secret-ref');
      expect(options.env).toBe(environment);
      expect(options).toMatchObject({ uid: 10001, gid: 10002, timeoutMs: 120_000 });
    }
    expect(gitCalls[2]![1]).toEqual(['-C', target, 'fetch', '--quiet', '--depth=50', 'origin', 'feature']);
    expect(gitCalls[4]![1]).toEqual(['-C', target, 'fetch', '--quiet', '--depth=50', 'origin', 'main:refs/remotes/origin/main']);
  });

  it('leaves the created directory in place when credential resolution fails', async () => {
    const target = await workspace();
    const cause = new Error('credential unavailable');
    const broker = credentials();
    vi.spyOn(broker, 'read').mockRejectedValue(cause);
    await expect(prepareWorkspace({ ...repository, credentialSecretArn: 'secret-ref' }, target, broker)).rejects.toBe(cause);
    await expect(access(target)).resolves.toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  it('stops after a failed Git command and redacts its diagnostic before taking the bounded tail', async () => {
    const target = await workspace();
    run.mockResolvedValueOnce(result()).mockResolvedValueOnce(result(9, Buffer.alloc(0), `prefix ${'x'.repeat(1_000)} https://user:token@github.com/repo failed`));
    await expect(prepareWorkspace(repository, target, credentials())).rejects.toThrow(
      `git failed with 9: ${`prefix ${'x'.repeat(1_000)} https://[REDACTED]@github.com/repo failed`.slice(-1_000)}`,
    );
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]![1]).toEqual(['-C', target, 'remote', 'add', 'origin', repository.url]);
  });

  it('reads identity and default Git environment again between empty-baseline commands', async () => {
    const target = await workspace();
    vi.stubEnv('GIT_TRUSTED_HOME', '/first');
    run.mockImplementationOnce(async () => {
      vi.stubEnv('GIT_TRUSTED_HOME', '/second');
      vi.stubEnv('RUN_AGENT_UID', '10001');
      vi.stubEnv('RUN_AGENT_GID', '10002');
      return result();
    });
    await prepareWorkspace(undefined, target, credentials());
    expect(run).toHaveBeenCalledTimes(3);
    expect(run.mock.calls[0]![2].env?.HOME).toBe('/first');
    expect(run.mock.calls[0]![2]).not.toHaveProperty('uid');
    expect(run.mock.calls[1]![2]).toMatchObject({ uid: 10001, gid: 10002, env: { HOME: '/second' } });
    expect(run.mock.calls[2]![1]).toEqual(['-C', target, 'update-ref', 'refs/agent-runtime/base', 'HEAD']);
  });
});

describe('workspace patch effects', () => {
  it('reuses the initial identity but reads environment settings separately for staging and diff', async () => {
    const bytes = Buffer.from('binary patch');
    vi.stubEnv('RUN_AGENT_UID', '10001');
    vi.stubEnv('RUN_AGENT_GID', '10002');
    vi.stubEnv('PATH', '/first-path');
    run.mockImplementationOnce(async () => {
      vi.stubEnv('RUN_AGENT_UID', 'invalid');
      vi.stubEnv('PATH', '/second-path');
      return result();
    }).mockResolvedValueOnce(result(0, bytes));

    expect(await collectWorkspacePatch('/workspace')).toBe(bytes);
    expect(run.mock.calls.map(([, , options]) => options.uid)).toEqual([10001, 10001]);
    expect(run.mock.calls.map(([, , options]) => options.env?.PATH)).toEqual(['/first-path', '/second-path']);
    expect(run.mock.calls[0]![2]).toMatchObject({ maxStdoutBytes: 64 * 1024, maxStderrBytes: 256 * 1024 });
    expect(run.mock.calls[1]![2]).toMatchObject({ maxStdoutBytes: 8 * 1024 * 1024 });
    expect(run.mock.calls[1]![2]).not.toHaveProperty('maxStderrBytes');
    for (const [, args] of run.mock.calls) expect(args.slice(-3)).toEqual(['--', '.', ':(exclude).rat-things/**']);
  });

  it('stops before diff when staging fails and preserves its diagnostic format', async () => {
    run.mockResolvedValue(result(1, Buffer.alloc(0), 'stage failed'));
    await expect(collectWorkspacePatch('/workspace')).rejects.toThrow('git add failed: stage failed');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('distinguishes an empty patch from a failed diff', async () => {
    expect(await collectWorkspacePatch('/workspace')).toBeUndefined();
    run.mockResolvedValueOnce(result()).mockResolvedValueOnce(result(2, Buffer.alloc(0), 'diff failed'));
    await expect(collectWorkspacePatch('/workspace')).rejects.toThrow('git diff failed: diff failed');
  });
});
