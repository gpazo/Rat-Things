import { redactText, secretRedactionPatterns } from '../domain/output-redaction.js';
import { access, lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { RepositoryInput } from '../domain/contracts.js';
import type { CredentialBroker } from '../credentials/broker.js';
import { ProcessExecutionError, runProcess } from './process.js';
import { agentProcessIdentity } from './agent-identity.js';
import { observeGitFetch } from './git-fetch-diagnostic.js';
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

type WorkspaceGitPhase = 'init' | 'remote' | 'fetch' | 'base_fetch' | 'checkout' | 'base_ref' | 'empty_baseline';

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
    const [init, baseline, baseRef] = emptyWorkspaceCommands(absolute);
    await git('init', init, root, gitEnvironment(), configuredAgentIdentity());
    await git('empty_baseline', baseline, root, gitEnvironment(), configuredAgentIdentity());
    await git('base_ref', baseRef, root, gitEnvironment(), configuredAgentIdentity());
    return;
  }
  validateRepositoryUrl(repository.url, process.env.ALLOWED_REPOSITORY_HOSTS);
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  const setupEnv = trustedGitEnvironment(process.env, absolute);
  let env = setupEnv;
  if (repository.credentialSecretArn) {
    const token = await credentials.read(
      repository.credentialSecretArn,
      ['token', 'access_token', 'password'],
    );
    env = credentialGitEnvironment(env, repository.provider, token, process.env.GIT_ASKPASS_PATH);
  }
  await git('init', ['init', '--quiet', absolute], root, setupEnv);
  await git('remote', ['-C', absolute, 'remote', 'add', 'origin', repository.url], root, setupEnv);
  const [fetch, checkout] = repositoryCheckoutCommands(absolute, repository.ref);
  await git('fetch', fetch, root, env);
  const baseFetch = repositoryBaseFetchArguments(absolute, repository.baseRef);
  if (baseFetch) await git('base_fetch', baseFetch, root, env);
  await handoff(absolute);
  const identity = configuredAgentIdentity();
  await git('checkout', checkout, root, gitEnvironment(), identity);
  await git('base_ref', ['-C', absolute, 'update-ref', 'refs/agent-runtime/base', 'HEAD'], root, gitEnvironment(), identity);
}

/** Resets first-use durable workspaces without removing the artifact bind mount. */
export async function resetPersistentWorkspace(workspace: string, clearArtifacts = false): Promise<void> {
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
      } else if (clearArtifacts) {
        const artifacts = resolve(control, child);
        const state = await lstat(artifacts);
        if (!state.isDirectory() || state.isSymbolicLink()) await rm(artifacts, { recursive: true, force: true });
        else for (const entry of await readdir(artifacts)) await rm(resolve(artifacts, entry), { recursive: true, force: true });
      }
    }
  }
}

async function isReusableWorkspace(workspace: string): Promise<boolean> {
  try {
    await access(workspace);
    await access(`${workspace}/.git`);
  } catch {
    return false;
  }
  const identity = configuredAgentIdentity();
  for (const ref of ['HEAD', 'refs/agent-runtime/base']) {
    const result = await runProcess('git', ['-C', workspace, 'rev-parse', '--quiet', '--verify', `${ref}^{commit}`], {
      cwd: workspace,
      env: gitEnvironment(),
      timeoutMs: 30_000,
      maxStdoutBytes: 64 * 1024,
      maxStderrBytes: 64 * 1024,
      ...identity,
    });
    if (result.exitCode !== 0) return false;
  }
  return true;
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
  phase: WorkspaceGitPhase,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = gitEnvironment(),
  identity?: { uid: number; gid: number },
): Promise<void> {
  const result = await runProcess('git', args, {
    cwd,
    env,
    timeoutMs: 120_000,
    maxStdoutBytes: 2 * 1024 * 1024,
    maxStderrBytes: 2 * 1024 * 1024,
    ...(phase === 'fetch' ? { onSpawn: observeGitFetch } : {}),
    ...identity,
  }).catch((error: unknown) => {
    throw safeGitExecutionError(phase, error);
  });
  if (result.exitCode !== 0) {
    const patterns = secretRedactionPatterns(env.GIT_TOKEN ? [{ secret: env.GIT_TOKEN, replacement: '[REDACTED]' }] : []);
    const diagnostic = redactText(result.stderr.toString('utf8'), patterns).value;
    throw new Error(`git ${phase} failed with ${result.exitCode}: ${redactGitDiagnostic(diagnostic).slice(-1_000)}`);
  }
}

function safeGitExecutionError(phase: WorkspaceGitPhase, error: unknown): Error {
  if (!(error instanceof ProcessExecutionError)) return new Error(`git ${phase} could not start`);
  const failure = /^process timed out after \d+ms$/.test(error.message)
    ? 'timed out'
    : /^process output exceeded \d+ bytes$/.test(error.message)
      ? 'exceeded output limit'
      : error.message === 'process was cancelled'
        ? 'was cancelled'
        : 'failed';
  return new ProcessExecutionError(`git ${phase} ${failure}`);
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
