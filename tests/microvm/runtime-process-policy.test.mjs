import { describe, expect, it } from 'vitest';
import { untrustedChildOptions } from '../../microvm/runtime-process-policy.mjs';

describe('MicroVM runtime process policy', () => {
  it('keeps IPC while dropping the agent child to its dedicated UID and GID', () => {
    const environment = { RUN_ID: 'run-1' };

    expect(untrustedChildOptions({ uid: 10001, gid: 10001, environment })).toEqual({
      cwd: '/workspace',
      env: environment,
      uid: 10001,
      gid: 10001,
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    });
  });

  it('refuses root or malformed identities', () => {
    expect(() => untrustedChildOptions({ uid: 0, gid: 10001, environment: {} }))
      .toThrow('UID');
    expect(() => untrustedChildOptions({ uid: 10001, gid: 0, environment: {} }))
      .toThrow('GID');
  });
});
