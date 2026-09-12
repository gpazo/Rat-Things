import { access, lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { RepositoryInput } from '../domain/contracts.js';
import type { CredentialBroker } from '../credentials/broker.js';
import { runProcess } from './process.js';
import { agentProcessIdentity } from './agent-identity.js';
import {
  assertWorkspaceScope,
  credentialGitEnvironment,
  emptyWorkspaceCommands,
  redactGitDiagnostic,
  repositoryBaseFetchArguments,
  repositoryCheckoutCommands,
  trustedGitEnvironment,
  validateRepositoryUrl,
  workspacePatchCommand,
} from './workspace-planning.js';

export async function prepareWorkspace(
  repository: RepositoryInput | undefined,
  workspace: string,
  credentials: CredentialBroker,
  options: { reuseExisting?: boolean } = {},
): Promise<void> {
  const absolute = resolve(workspace);
  const root = resolve(process.env.WORKSPACE_ROOT ?? '/tmp/agent-runtime');
  assertWorkspaceScope(absolute, root);
  if (options.reuseExisting) {
    if (await isReusableWorkspace(absolute)) return;
    await resetPersistentWorkspace(absolute);
  } else {
    await rm(absolute, { recursive: true, force: true });
  }
  await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
  if (!repository) {
    await mkdir(absolute, { recursive: true, mode: 0o700 });
    await handoff(absolute);
    for (const args of emptyWorkspaceCommands(absolute)) await git(args, root);
    return;
  }
  validateRepositoryUrl(repository.url, process.env.ALLOWED_REPOSITORY_HOSTS);
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  await handoff(absolute);
  let env = gitEnvironment();
  if (repository.credentialSecretArn) {
    const token = await credentials.read(
      repository.credentialSecretArn,
      ['token', 'access_token', 'password'],
    );
    env = credentialGitEnvironment(env, repository.provider, token, process.env.GIT_ASKPASS_PATH);
  }
  await git(['init', '--quiet', absolute], root, env);
  await git(['-C', absolute, 'remote', 'add', 'origin', repository.url], root, env);
  for (const args of repositoryCheckoutCommands(absolute, repository.ref)) await git(args, root, env);
  const baseFetch = repositoryBaseFetchArguments(absolute, repository.baseRef);
  if (baseFetch) await git(baseFetch, root, env);
  await git(['-C', absolute, 'update-ref', 'refs/agent-runtime/base', 'HEAD'], root, env);
  await handoff(absolute);
}

/** Resets first-use durable workspaces without removing the artifact bind mount. */
async function resetPersistentWorkspace(workspace: string): Promise<void> {
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(workspace)) {
    if (entry !== '.rat-things') {
      await rm(resolve(workspace, entry), { recursive: true, force: true });
      continue;
    }
    const control = resolve(workspace, entry);
    const stat = await lstat(control);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      await rm(control, { recursive: true, force: true });
      continue;
    }
    for (const child of await readdir(control)) {
      if (child !== 'artifacts') {
        await rm(resolve(control, child), { recursive: true, force: true });
      }
    }
  }
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
  const stage = workspacePatchCommand(workspace, 'stage', process.env, identity);
  const add = await runProcess('git', stage.args, stage.options);
  if (add.exitCode !== 0) throw new Error(`git add failed: ${add.stderr.toString('utf8').slice(-1_000)}`);
  const diff = workspacePatchCommand(workspace, 'diff', process.env, identity);
  const result = await runProcess('git', diff.args, diff.options);
  if (result.exitCode !== 0) throw new Error(`git diff failed: ${result.stderr.toString('utf8').slice(-1_000)}`);
  return result.stdout.length > 0 ? result.stdout : undefined;
}

async function git(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = gitEnvironment(),
): Promise<void> {
  const identity = configuredAgentIdentity();
  const result = await runProcess('git', args, {
    cwd,
    env,
    timeoutMs: 120_000,
    maxStdoutBytes: 2 * 1024 * 1024,
    maxStderrBytes: 2 * 1024 * 1024,
    ...identity,
  });
  if (result.exitCode !== 0) {
    throw new Error(`git failed with ${result.exitCode}: ${redactGitDiagnostic(result.stderr.toString('utf8')).slice(-1_000)}`);
  }
}

function gitEnvironment(): NodeJS.ProcessEnv {
  return trustedGitEnvironment(process.env);
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
  return agentProcessIdentity(process.env.RUN_AGENT_UID, process.env.RUN_AGENT_GID);
}
