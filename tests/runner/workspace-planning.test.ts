import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertWorkspaceScope, credentialGitEnvironment, emptyWorkspaceCommands, redactGitDiagnostic,
  repositoryBaseFetchArguments, repositoryCheckoutCommands, trustedGitEnvironment,
  validateRepositoryUrl, workspacePatchCommand,
} from '../../src/runner/workspace-planning.js';

afterEach(() => vi.unstubAllEnvs());

describe('workspace scope and repository policy', () => {
  it('accepts the resolved root and descendants while rejecting sibling prefixes', () => {
    expect(() => assertWorkspaceScope('/runtime', '/runtime')).not.toThrow();
    expect(() => assertWorkspaceScope('/runtime/run-1/nested', '/runtime')).not.toThrow();
    for (const target of ['/runtime-other/run-1', '/elsewhere', '/']) {
      expect(() => assertWorkspaceScope(target, '/runtime')).toThrow('workspace must be below /runtime');
    }
  });

  it('uses the supplied host list with normalized hostnames and preserves allowed ports', () => {
    vi.stubEnv('ALLOWED_REPOSITORY_HOSTS', 'ambient.invalid');
    expect(() => validateRepositoryUrl('https://github.com/owner/repo.git', undefined)).not.toThrow();
    expect(() => validateRepositoryUrl('https://gitlab.com/owner/repo.git', undefined)).not.toThrow();
    expect(() => validateRepositoryUrl('https://CODE.EXAMPLE:8443/owner/repo.git', ' , Code.Example , ')).not.toThrow();
    expect(() => validateRepositoryUrl('https://github.com/repo', '')).toThrow('repository URL is not allowed');
    expect(() => validateRepositoryUrl('https://sub.code.example/repo', 'code.example')).toThrow('repository URL is not allowed');
  });

  it.each([
    'http://github.com/repo',
    'ssh://github.com/repo',
    'file:///tmp/repo',
    'https://user@github.com/repo',
    'https://user:token@github.com/repo',
    'https://github.com/repo?token=secret',
    'https://github.com/repo#fragment',
    'https://github.com.attacker.invalid/repo',
  ])('rejects an unapproved repository URL: %s', (url) => {
    expect(() => validateRepositoryUrl(url, undefined)).toThrow('repository URL is not allowed');
  });

  it('retains the URL parser error for malformed values', () => {
    expect(() => validateRepositoryUrl('not a URL', undefined)).toThrow(TypeError);
  });
});

describe('Git setup planning', () => {
  it('constructs an empty baseline in order using fresh argument arrays', () => {
    const first = emptyWorkspaceCommands('/work space');
    expect(first).toEqual([
      ['init', '--quiet', '/work space'],
      ['-C', '/work space', '-c', 'user.name=Agent Runtime', '-c', 'user.email=runtime@invalid', 'commit', '--quiet', '--allow-empty', '-m', 'runtime baseline'],
      ['-C', '/work space', 'update-ref', 'refs/agent-runtime/base', 'HEAD'],
    ]);
    first[0]!.push('changed');
    expect(emptyWorkspaceCommands('/work space')[0]).toEqual(['init', '--quiet', '/work space']);
  });

  it('uses a shallow HEAD fetch for missing or empty refs, retaining explicit refs as single arguments', () => {
    for (const ref of [undefined, '']) {
      expect(repositoryCheckoutCommands('/workspace', ref)).toEqual([
        ['-C', '/workspace', 'fetch', '--quiet', '--depth=1', 'origin', 'HEAD'],
        ['-C', '/workspace', 'checkout', '--quiet', '--detach', 'FETCH_HEAD'],
      ]);
    }
    const ref = 'feature; $(touch marker)';
    expect(repositoryCheckoutCommands('/workspace', ref)[0])
      .toEqual(['-C', '/workspace', 'fetch', '--quiet', '--depth=50', 'origin', ref]);
  });

  it('omits absent base fetches and builds the remote tracking ref for a supplied base', () => {
    expect(repositoryBaseFetchArguments('/workspace', undefined)).toBeUndefined();
    expect(repositoryBaseFetchArguments('/workspace', '')).toBeUndefined();
    expect(repositoryBaseFetchArguments('/workspace', 'release/main'))
      .toEqual(['-C', '/workspace', 'fetch', '--quiet', '--depth=50', 'origin', 'release/main:refs/remotes/origin/release/main']);
  });

  it('isolates trusted Git configuration from supplied host settings and keeps empty overrides', () => {
    const environment = Object.freeze({
      PATH: '', HOME: '/agent-writable', GIT_TRUSTED_HOME: '', GIT_CONFIG_GLOBAL: '/agent/config',
      GIT_TOKEN: 'unselected-token', AWS_SECRET_ACCESS_KEY: 'host-key',
    });
    const planned = trustedGitEnvironment(environment);
    expect(planned).toStrictEqual({
      PATH: '', HOME: '', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    });
    planned.HOME = '/changed';
    expect(environment.GIT_TRUSTED_HOME).toBe('');
    expect(trustedGitEnvironment({})).toStrictEqual({
      PATH: undefined, HOME: '/opt/agent-runtime', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    });
  });

  it.each([
    ['github', 'x-access-token'], ['gitlab', 'oauth2'], ['generic', 'oauth2'],
  ] as const)('adds credentials for %s without mutating the trusted environment', (provider, username) => {
    const original = Object.freeze(trustedGitEnvironment({ PATH: '/bin' }));
    const planned = credentialGitEnvironment(original, provider, '', '');
    expect(planned).toEqual({ ...original, GIT_TOKEN: '', GIT_USERNAME: username, GIT_ASKPASS: '' });
    expect(original).not.toHaveProperty('GIT_TOKEN');
    expect(credentialGitEnvironment(original, provider, 'token', undefined).GIT_ASKPASS).toBe('/app/bin/git-askpass.sh');
  });

  it('redacts every HTTPS user-info segment while retaining the rest of the diagnostic', () => {
    expect(redactGitDiagnostic('https://user:token@host/repo and https://other@host/repo failed for user@example.com'))
      .toBe('https://[REDACTED]@host/repo and https://[REDACTED]@host/repo failed for user@example.com');
    expect(redactGitDiagnostic('')).toBe('');
  });
});

describe('workspace patch command planning', () => {
  it('excludes runner control files from staging and diff while retaining separate output limits', () => {
    const identity = Object.freeze({ uid: 10001, gid: 10002 });
    const environment = Object.freeze({ PATH: '/bin', HOME: '/agent', GIT_TOKEN: 'host-token' });
    const stage = workspacePatchCommand('/workspace', 'stage', environment, identity);
    const diff = workspacePatchCommand('/workspace', 'diff', environment, identity);
    expect(stage.args).toEqual(['-C', '/workspace', 'add', '--intent-to-add', '--all', '--', '.', ':(exclude).rat-things/**']);
    expect(diff.args).toEqual(['-C', '/workspace', 'diff', '--binary', 'refs/agent-runtime/base', '--', '.', ':(exclude).rat-things/**']);
    expect(stage.options).toEqual({
      cwd: '/workspace', env: { PATH: '/bin', HOME: '/agent' }, timeoutMs: 30_000,
      maxStdoutBytes: 64 * 1024, maxStderrBytes: 256 * 1024, uid: 10001, gid: 10002,
    });
    expect(diff.options).toEqual({
      cwd: '/workspace', env: { PATH: '/bin', HOME: '/agent' }, timeoutMs: 30_000,
      maxStdoutBytes: 8 * 1024 * 1024, uid: 10001, gid: 10002,
    });
    stage.options.env!.PATH = '/changed';
    expect(diff.options.env!.PATH).toBe('/bin');
    expect(environment.PATH).toBe('/bin');
    expect(workspacePatchCommand('/workspace', 'diff', {}, undefined).options).not.toHaveProperty('uid');
  });
});
