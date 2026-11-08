import { expect, it } from 'vitest';
import { trustedRunnerOptions } from '../../microvm/runtime-process-policy.mjs';

it('adds only the private fd4 pipe for storage startup while preserving fd3 IPC and root identity', () => {
  const base = trustedRunnerOptions({ uid: 10001, gid: 10001, environment: { RUN_ID: 'run-1' } });
  const gated = trustedRunnerOptions({ uid: 10001, gid: 10001, environment: { RUN_ID: 'run-1' }, startupGate: true });

  expect(base).toMatchObject({ uid: 0, gid: 0, env: { RUN_AGENT_UID: '10001', RUN_AGENT_GID: '10001' } });
  expect(base.stdio).toEqual(['inherit', 'inherit', 'inherit', 'ipc']);
  expect(gated.stdio).toEqual(['inherit', 'inherit', 'inherit', 'ipc', 'pipe']);
  expect(gated.uid).toBe(0);
  expect(gated.gid).toBe(0);
  expect(gated.env).toMatchObject({ RUN_AGENT_UID: '10001', RUN_AGENT_GID: '10001' });
});
