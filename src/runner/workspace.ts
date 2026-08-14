import { access, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { RepositoryInput } from '../domain/contracts.js';
import type { CredentialBroker } from '../credentials/broker.js';
import { runProcess } from './process.js';

export async function prepareWorkspace(
  repository: RepositoryInput | undefined,
  workspace: string,
  credentials: CredentialBroker,
  options: { reuseExisting?: boolean } = {},
): Promise<void> {
  const absolute = resolve(workspace);
  const root = resolve(process.env.WORKSPACE_ROOT ?? '/tmp/agent-runtime');
  if (absolute !== root && !absolute.startsWith(`${root}/`)) {
    throw new Error(`workspace must be below ${root}`);
  }
  if (options.reuseExisting && await isReusableWorkspace(absolute)) return;
  await rm(absolute, { recursive: true, force: true });
  await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
  if (!repository) {
    await mkdir(absolute, { recursive: true, mode: 0o700 });
    await git(['init', '--quiet', absolute], root);
    await git(['-C', absolute, '-c', 'user.name=Agent Runtime', '-c', 'user.email=runtime@invalid', 'commit', '--quiet', '--allow-empty', '-m', 'runtime baseline'], root);
    await git(['-C', absolute, 'update-ref', 'refs/agent-runtime/base', 'HEAD'], root);
    await handoff(absolute);
    return;
  }
  validateRepositoryUrl(repository.url);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GIT_TERMINAL_PROMPT: '0',
  };
  if (repository.credentialSecretArn) {
    env.GIT_TOKEN = await credentials.read(
      repository.credentialSecretArn,
      ['token', 'access_token', 'password'],
    );
    env.GIT_USERNAME = repository.provider === 'github' ? 'x-access-token' : 'oauth2';
    env.GIT_ASKPASS = process.env.GIT_ASKPASS_PATH ?? '/app/bin/git-askpass.sh';
  }
  await git(['init', '--quiet', absolute], root, env);
  await git(['-C', absolute, 'remote', 'add', 'origin', repository.url], root, env);
  if (repository.ref) {
    await git(['-C', absolute, 'fetch', '--quiet', '--depth=50', 'origin', repository.ref], root, env);
    await git(['-C', absolute, 'checkout', '--quiet', '--detach', 'FETCH_HEAD'], root, env);
  } else {
    await git(['-C', absolute, 'fetch', '--quiet', '--depth=1', 'origin', 'HEAD'], root, env);
    await git(['-C', absolute, 'checkout', '--quiet', '--detach', 'FETCH_HEAD'], root, env);
  }
  if (repository.baseRef) {
    await git(
      [
        '-C',
        absolute,
        'fetch',
        '--quiet',
        '--depth=50',
        'origin',
        `${repository.baseRef}:refs/remotes/origin/${repository.baseRef}`,
      ],
      root,
      env,
    );
  }
  await git(['-C', absolute, 'update-ref', 'refs/agent-runtime/base', 'HEAD'], root, env);
  await handoff(absolute);
}

async function isReusableWorkspace(workspace: string): Promise<boolean> {
  try {
    await access(workspace);
    await access(`${workspace}/.git`);
    return true;
  } catch {
    return false;
  }
}

export async function collectWorkspacePatch(workspace: string): Promise<Buffer | undefined> {
  const identity = configuredAgentIdentity();
  const artifactExclusion = ':(exclude).rat-things/**';
  const add = await runProcess(
    'git',
    ['-C', workspace, 'add', '--intent-to-add', '--all', '--', '.', artifactExclusion],
    {
    cwd: workspace,
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    timeoutMs: 30_000,
    maxStdoutBytes: 64 * 1024,
    maxStderrBytes: 256 * 1024,
    ...identity,
    },
  );
  if (add.exitCode !== 0) throw new Error(`git add failed: ${add.stderr.toString('utf8').slice(-1_000)}`);
  const result = await runProcess(
    'git',
    ['-C', workspace, 'diff', '--binary', 'refs/agent-runtime/base', '--', '.', artifactExclusion],
    {
    cwd: workspace,
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    timeoutMs: 30_000,
    maxStdoutBytes: 8 * 1024 * 1024,
    ...identity,
    },
  );
  if (result.exitCode !== 0) throw new Error(`git diff failed: ${result.stderr.toString('utf8').slice(-1_000)}`);
  return result.stdout.length > 0 ? result.stdout : undefined;
}

async function git(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME },
): Promise<void> {
  const result = await runProcess('git', args, {
    cwd,
    env,
    timeoutMs: 120_000,
    maxStdoutBytes: 2 * 1024 * 1024,
    maxStderrBytes: 2 * 1024 * 1024,
  });
  if (result.exitCode !== 0) {
    throw new Error(`git failed with ${result.exitCode}: ${redact(result.stderr.toString('utf8')).slice(-1_000)}`);
  }
}

function validateRepositoryUrl(value: string): void {
  const url = new URL(value);
  const allowed = (process.env.ALLOWED_REPOSITORY_HOSTS ?? 'github.com,gitlab.com')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !allowed.includes(url.hostname.toLowerCase())
  ) {
    throw new Error('repository URL is not allowed');
  }
}

function redact(value: string): string {
  return value.replace(/https:\/\/[^@\s]+@/g, 'https://[REDACTED]@');
}

async function handoff(workspace: string): Promise<void> {
  const identity = configuredAgentIdentity();
  if (!identity) return;
  const { uid, gid } = identity;
  const result = await runProcess('chown', ['-R', `${uid}:${gid}`, workspace], {
    cwd: workspace,
    timeoutMs: 30_000,
    maxStdoutBytes: 64 * 1024,
    maxStderrBytes: 64 * 1024,
  });
  if (result.exitCode !== 0) {
    throw new Error(`failed to hand workspace to agent UID: ${result.stderr.toString('utf8')}`);
  }
}

function configuredAgentIdentity(): { uid: number; gid: number } | undefined {
  const rawUid = process.env.RUN_AGENT_UID;
  const rawGid = process.env.RUN_AGENT_GID;
  if (!rawUid && !rawGid) return undefined;
  const uid = Number(rawUid);
  const gid = Number(rawGid);
  if (!Number.isInteger(uid) || uid < 1 || !Number.isInteger(gid) || gid < 1) {
    throw new Error('RUN_AGENT_UID and RUN_AGENT_GID must both be positive integers');
  }
  return { uid, gid };
}
