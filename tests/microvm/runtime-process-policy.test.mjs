import { describe, expect, it } from 'vitest';
import { planCodexLaunch } from '../../src/runner/agent-planning.js';
import { trustedRunnerOptions } from '../../microvm/runtime-process-policy.mjs';

describe('MicroVM runtime process policy', () => {
  it('keeps the trusted runner separate from the non-root agent identity', () => {
    const environment = { RUN_ID: 'run-1' };

    expect(trustedRunnerOptions({ uid: 10001, gid: 10001, environment })).toEqual({
      cwd: '/opt/agent-runtime',
      env: { ...environment, CODEX_BINARY: '/opt/codex-runtime/bin/codex', RUN_AGENT_UID: '10001', RUN_AGENT_GID: '10001' },
      uid: 0,
      gid: 0,
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    });
  });

  it.each([undefined, 'codex', '/workspace/untrusted-codex'])('pins packaged Codex through launch planning when the inherited binary is %s', binary => {
    const environment = Object.freeze({ CODEX_BINARY: binary, PATH: '/workspace/bin', PERSISTENT_SESSION: 'true',
      CODEX_HOME: '/mnt/session/codex-home', CODEX_SQLITE_HOME: '/mnt/session/codex-home/sqlite' });
    const options = trustedRunnerOptions({ uid: 10001, gid: 10001, environment });
    const plan = planCodexLaunch({ version: '1', prompt: '' }, '/mnt/session/workspace', 30_000, options.env);
    expect(plan).toMatchObject({ binary: '/opt/codex-runtime/bin/codex', identity: { uid: 10001, gid: 10001 }, persistent: true,
      environment: { CODEX_HOME: environment.CODEX_HOME, CODEX_SQLITE_HOME: environment.CODEX_SQLITE_HOME } });
    expect(options.uid).toBe(0);
    expect(options.env).not.toBe(environment);
    expect(environment.CODEX_BINARY).toBe(binary);
  });

  it('refuses root or malformed identities', () => {
    expect(() => trustedRunnerOptions({ uid: 0, gid: 10001, environment: {} }))
      .toThrow('UID');
    expect(() => trustedRunnerOptions({ uid: 10001, gid: 0, environment: {} }))
      .toThrow('GID');
  });
});
