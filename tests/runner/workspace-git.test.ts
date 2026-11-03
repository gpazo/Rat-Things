import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { CredentialBroker } from '../../src/credentials/broker.js';
import { ProcessExecutionError } from '../../src/runner/process.js';
import * as processes from '../../src/runner/process.js';
import { prepareWorkspace } from '../../src/runner/workspace.js';
import { repositoryBaseFetchArguments, repositoryCheckoutCommands, trustedGitEnvironment } from '../../src/runner/workspace-planning.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each([
  {
    failure: (details: string) => new ProcessExecutionError('process timed out after 120000ms', {
      exitCode: 143,
      stdout: Buffer.from(details),
      stderr: Buffer.from(details),
      durationMs: 120_000,
    }),
    message: 'git fetch timed out',
    name: 'ProcessExecutionError',
  },
  {
    failure: (details: string) => new ProcessExecutionError('process output exceeded 2097152 bytes', {
      exitCode: 143,
      stdout: Buffer.from(details),
      stderr: Buffer.from(details),
      durationMs: 1,
    }),
    message: 'git fetch exceeded output limit',
    name: 'ProcessExecutionError',
  },
  {
    failure: (details: string) => Object.assign(new Error(`spawn git ENOENT ${details}`), { code: 'ENOENT' }),
    message: 'git fetch could not start',
    name: 'Error',
  },
])('reports a safe Git fetch failure for $message', async ({ failure, message, name }) => {
  const root = await mkdtemp(join(tmpdir(), 'rat-workspace-failure-'));
  const work = join(root, 'workspace');
  const token = 'private-clone-token';
  const repositoryUrl = 'https://github.com/owner/private-repository.git';
  vi.stubEnv('WORKSPACE_ROOT', root);
  vi.stubEnv('RUN_AGENT_UID', '');
  vi.stubEnv('RUN_AGENT_GID', '');
  const broker = new CredentialBroker({ get: vi.fn().mockResolvedValue(token) });
  const runProcess = processes.runProcess;
  vi.spyOn(processes, 'runProcess').mockImplementation(async (command, args, options) => {
    if (command === 'git' && args[2] === 'fetch') throw failure(`${token} ${repositoryUrl} ${work}`);
    return runProcess(command, args, options);
  });

  try {
    let caught: unknown;
    try {
      await prepareWorkspace({ provider: 'github', url: repositoryUrl, credentialSecretArn: 'credential-ref' }, work, broker);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ name, message });
    if (caught instanceof ProcessExecutionError) expect(caught.result).toBeUndefined();
    expect((caught as Error).message).not.toContain(token);
    expect((caught as Error).message).not.toContain(repositoryUrl);
    expect((caught as Error).message).not.toContain(work);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('redacts clone tokens from a nonzero Git diagnostic while keeping the fetch phase', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rat-workspace-redaction-'));
  const work = join(root, 'workspace');
  const token = 'private-clone-token';
  const repositoryUrl = 'https://github.com/owner/private-repository.git';
  vi.stubEnv('WORKSPACE_ROOT', root);
  vi.stubEnv('RUN_AGENT_UID', '');
  vi.stubEnv('RUN_AGENT_GID', '');
  const broker = new CredentialBroker({ get: vi.fn().mockResolvedValue(token) });
  const runProcess = processes.runProcess;
  vi.spyOn(processes, 'runProcess').mockImplementation(async (command, args, options) => {
    if (command === 'git' && args[2] === 'fetch') {
      return {
        exitCode: 128,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from(`fatal: token=${token} from ${repositoryUrl}`),
        durationMs: 1,
      };
    }
    return runProcess(command, args, options);
  });

  try {
    let caught: unknown;
    try {
      await prepareWorkspace({ provider: 'github', url: repositoryUrl, credentialSecretArn: 'credential-ref' }, work, broker);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ message: expect.stringContaining('git fetch failed with 128') });
    expect((caught as Error).message).not.toContain(token);
    expect((caught as Error).message).toContain('[REDACTED]');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('fetches a differently owned workspace with invocation-only trust for that exact path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rat-fetch-head-'));
  const source = join(root, 'source');
  const work = join(root, 'workspace');
  const environment = trustedGitEnvironment(process.env);
  const otherOwner = { ...environment, GIT_TEST_ASSUME_DIFFERENT_OWNER: '1' };
  const setupEnvironment = { ...trustedGitEnvironment(process.env, work), GIT_TEST_ASSUME_DIFFERENT_OWNER: '1' };
  const git = async (args: string[], env = environment) => (await promisify(execFile)('git', args, { env })).stdout.trim();
  try {
    await git(['init', '--quiet', '--initial-branch=main', source]);
    await git(['-C', source, '-c', 'user.name=Test', '-c', 'user.email=test@invalid', 'commit', '--quiet', '--allow-empty', '-m', 'base']);
    const base = await git(['-C', source, 'rev-parse', 'HEAD']);
    await git(['-C', source, 'checkout', '--quiet', '-b', 'feature']);
    await git(['-C', source, '-c', 'user.name=Test', '-c', 'user.email=test@invalid', 'commit', '--quiet', '--allow-empty', '-m', 'head']);
    const head = await git(['-C', source, 'rev-parse', 'HEAD']);
    await git(['init', '--quiet', work], setupEnvironment);
    await expect(git(['-C', work, 'remote', 'add', 'origin', source], otherOwner)).rejects.toThrow('dubious ownership');
    await git(['-C', work, 'remote', 'add', 'origin', source], setupEnvironment);
    const [fetch, checkout] = repositoryCheckoutCommands(work, 'feature');
    await git(fetch, setupEnvironment);
    await git(repositoryBaseFetchArguments(work, 'main')!, setupEnvironment);
    await expect(git(['-C', source, 'rev-parse', 'HEAD'], setupEnvironment)).rejects.toThrow('dubious ownership');
    await expect(git(['-C', work, 'rev-parse', 'FETCH_HEAD'], otherOwner)).rejects.toThrow('dubious ownership');
    await expect(git(['-C', work, 'config', '--local', '--get-all', 'safe.directory'])).rejects.toMatchObject({ code: 1 });
    await git(checkout);
    expect(await git(['-C', work, 'rev-parse', 'HEAD'])).toBe(head);
    expect(await git(['-C', work, 'rev-parse', 'refs/remotes/origin/main'])).toBe(base);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.each(['remote', 'fetch', 'checkout', 'update-ref'])('retries incomplete setup after %s fails and preserves completed checkouts', async (failedCommand) => {
  const root = await mkdtemp(join(tmpdir(), 'rat-workspace-retry-'));
  const source = join(root, 'source');
  const work = join(root, 'workspace');
  const git = async (args: string[]) => (await promisify(execFile)('git', args, { env: trustedGitEnvironment(process.env) })).stdout.trim();
  const runProcess = processes.runProcess;
  const broker = new CredentialBroker({ get: vi.fn() });
  const read = vi.spyOn(broker, 'read').mockResolvedValue('test-clone-token');
  vi.stubEnv('WORKSPACE_ROOT', root);
  vi.stubEnv('RUN_AGENT_UID', '10001');
  vi.stubEnv('RUN_AGENT_GID', '10002');
  try {
    await git(['init', '--quiet', '--initial-branch=main', source]);
    await writeFile(join(source, 'source.txt'), 'repository content');
    await git(['-C', source, 'add', 'source.txt']);
    await git(['-C', source, '-c', 'user.name=Test', '-c', 'user.email=test@invalid', 'commit', '--quiet', '-m', 'base']);
    const head = await git(['-C', source, 'rev-parse', 'HEAD']);
    let failSetup = true;
    const run = vi.spyOn(processes, 'runProcess').mockImplementation(async (command, args, options) => {
      if (command === 'chown') return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), durationMs: 1 };
      if (failSetup && command === 'git' && args[2] === failedCommand) {
        failSetup = false;
        return { exitCode: 128, stdout: Buffer.alloc(0), stderr: Buffer.from('setup interrupted'), durationMs: 1 };
      }
      const localArgs = command === 'git' && args[2] === 'remote' ? [...args.slice(0, -1), source] : args;
      const localOptions = command === 'git' && options.uid === undefined
        ? { ...options, env: { ...options.env, GIT_TEST_ASSUME_DIFFERENT_OWNER: '1' } }
        : options;
      const { uid: _uid, gid: _gid, ...currentUserOptions } = localOptions;
      return runProcess(command, localArgs, currentUserOptions);
    });
    const repository = { provider: 'github' as const, url: 'https://github.com/owner/repo.git', credentialSecretArn: 'test-secret-ref' };

    await expect(prepareWorkspace(repository, work, broker, { reuseExisting: true })).rejects.toThrow('setup interrupted');
    expect(await readFile(join(work, '.git/HEAD'), 'utf8')).toBeTruthy();
    await writeFile(join(work, 'incomplete.txt'), 'discard');
    await prepareWorkspace(repository, work, broker, { reuseExisting: true });

    expect(await readFile(join(work, 'source.txt'), 'utf8')).toBe('repository content');
    await expect(readFile(join(work, 'incomplete.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await git(['-C', work, 'rev-parse', 'HEAD'])).toBe(head);
    expect(await git(['-C', work, 'rev-parse', 'refs/agent-runtime/base'])).toBe(head);
    expect(read).toHaveBeenCalledTimes(2);
    await writeFile(join(work, 'continued.txt'), 'keep');
    const beforeReuse = run.mock.calls.length;
    await prepareWorkspace(repository, work, broker, { reuseExisting: true });
    expect(await readFile(join(work, 'continued.txt'), 'utf8')).toBe('keep');
    expect(read).toHaveBeenCalledTimes(2);
    const reuseCalls = run.mock.calls.slice(beforeReuse);
    expect(reuseCalls).toHaveLength(2);
    expect(reuseCalls.every(([, args, options]) => args[2] === 'rev-parse' && options.uid === 10001)).toBe(true);
    const guestCalls = run.mock.calls.filter(([, , options]) => options.uid !== undefined);
    expect(guestCalls.length).toBeGreaterThan(0);
    for (const [, , options] of guestCalls) {
      expect(options.env).not.toHaveProperty('GIT_TOKEN');
      expect(options.env).not.toHaveProperty('GIT_ASKPASS');
      expect(Object.values(options.env ?? {})).not.toContain('safe.directory');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
