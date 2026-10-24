import { expect, it } from 'vitest';
import { localWorkspaceSetupTimeoutMs } from '../../src/domain/local-workspace-setup.js';

it('reserves registration time without charging for empty package lists', () => {
  expect(localWorkspaceSetupTimeoutMs(undefined, 'create')).toBe(60_000);
  expect(localWorkspaceSetupTimeoutMs({ packages: { system: [], npm: [], python: [] }, setup_commands: [] }, 'create')).toBe(60_000);
});

it('budgets every sequential command and each package-manager invocation', () => {
  const configuration = { packages: { system: ['git', 'make'], npm: ['typescript', 'eslint'], python: ['pytest'] },
    setup_commands: [{ command: 'compile first target' }, { command: 'compile second target' }] };
  // Five sequential operations, each allowed its full 610s RPC deadline.
  expect(localWorkspaceSetupTimeoutMs(configuration, 'create')).toBe(3_110_000);
  expect(localWorkspaceSetupTimeoutMs(configuration, 'resume')).toBe(670_000);
  expect(localWorkspaceSetupTimeoutMs({ ...configuration, packages: { npm: ['typescript'] } }, 'resume')).toBe(60_000);
});

it('does not silently truncate a large admitted command list', () => {
  expect(localWorkspaceSetupTimeoutMs({ setup_commands: Array.from({ length: 4000 }, () => ({ command: 'true' })) }, 'create')).toBe(2_440_060_000);
});
