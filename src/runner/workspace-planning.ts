import type { RepositoryProvider } from '../domain/contracts.js';
import type { AgentProcessIdentity } from './agent-identity.js';
import type { ProcessOptions } from './process.js';

/** Paths are resolved by the caller so checking scope does not depend on cwd. */
export function assertWorkspaceScope(absolute: string, root: string): void {
  if (absolute !== root && !absolute.startsWith(`${root}/`)) {
    throw new Error(`workspace must be below ${root}`);
  }
}

export function validateRepositoryUrl(value: string, allowedHosts: string | undefined): void {
  const url = new URL(value);
  const allowed = (allowedHosts ?? 'github.com,gitlab.com')
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

export function emptyWorkspaceCommands(workspace: string): string[][] {
  return [
    ['init', '--quiet', workspace],
    ['-C', workspace, '-c', 'user.name=Agent Runtime', '-c', 'user.email=runtime@invalid', 'commit', '--quiet', '--allow-empty', '-m', 'runtime baseline'],
    ['-C', workspace, 'update-ref', 'refs/agent-runtime/base', 'HEAD'],
  ];
}

export function repositoryCheckoutCommands(workspace: string, ref: string | undefined): string[][] {
  return [
    ref
      ? ['-C', workspace, 'fetch', '--quiet', '--depth=50', 'origin', ref]
      : ['-C', workspace, 'fetch', '--quiet', '--depth=1', 'origin', 'HEAD'],
    ['-C', workspace, 'checkout', '--quiet', '--detach', 'FETCH_HEAD'],
  ];
}

export function repositoryBaseFetchArguments(workspace: string, baseRef: string | undefined): string[] | undefined {
  return baseRef
    ? ['-C', workspace, 'fetch', '--quiet', '--depth=50', 'origin', `${baseRef}:refs/remotes/origin/${baseRef}`]
    : undefined;
}

export function trustedGitEnvironment(environment: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  return {
    PATH: environment.PATH,
    // Ignore agent-writable user/system Git configuration during trusted setup.
    HOME: environment.GIT_TRUSTED_HOME ?? '/opt/agent-runtime',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  };
}

export function credentialGitEnvironment(
  environment: Readonly<NodeJS.ProcessEnv>,
  provider: RepositoryProvider,
  token: string,
  askpassPath: string | undefined,
): NodeJS.ProcessEnv {
  return {
    ...environment,
    GIT_TOKEN: token,
    GIT_USERNAME: provider === 'github' ? 'x-access-token' : 'oauth2',
    GIT_ASKPASS: askpassPath ?? '/app/bin/git-askpass.sh',
  };
}

export function workspacePatchCommand(
  workspace: string,
  phase: 'stage' | 'diff',
  environment: Readonly<NodeJS.ProcessEnv>,
  identity: AgentProcessIdentity | undefined,
): { args: string[]; options: ProcessOptions } {
  const pathspec = ['--', '.', ':(exclude).rat-things/**'];
  return {
    args: phase === 'stage'
      ? ['-C', workspace, 'add', '--intent-to-add', '--all', ...pathspec]
      : ['-C', workspace, 'diff', '--binary', 'refs/agent-runtime/base', ...pathspec],
    options: {
      cwd: workspace,
      env: { PATH: environment.PATH, HOME: environment.HOME },
      timeoutMs: 30_000,
      ...(phase === 'stage'
        ? { maxStdoutBytes: 64 * 1024, maxStderrBytes: 256 * 1024 }
        : { maxStdoutBytes: 8 * 1024 * 1024 }),
      ...identity,
    },
  };
}

export function redactGitDiagnostic(value: string): string {
  return value.replace(/https:\/\/[^@\s]+@/g, 'https://[REDACTED]@');
}
