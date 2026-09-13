import { describe, expect, it } from 'vitest';
import { trustedRunnerOptions } from '../../microvm/runtime-process-policy.mjs';

describe('MicroVM runtime process policy', () => {
  it('keeps the trusted runner separate from the non-root agent identity', () => {
    const environment = { RUN_ID: 'run-1' };

    expect(trustedRunnerOptions({ uid: 10001, gid: 10001, environment })).toEqual({
      cwd: '/opt/agent-runtime',
      env: { ...environment, RUN_AGENT_UID: '10001', RUN_AGENT_GID: '10001' },
      uid: 0,
      gid: 0,
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    });
  });

  it('refuses root or malformed identities', () => {
    expect(() => trustedRunnerOptions({ uid: 0, gid: 10001, environment: {} }))
      .toThrow('UID');
    expect(() => trustedRunnerOptions({ uid: 10001, gid: 0, environment: {} }))
      .toThrow('GID');
  });
});
