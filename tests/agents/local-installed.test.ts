import { expect, it } from 'vitest';
import { installedNativeOptions, installedPaths, installedRuntime } from '../../src/app/local-installed.js';

it('keeps development composition separate from compiled installed mode', async () => {
  expect(installedRuntime).toBe(false);
  expect(await installedNativeOptions()).toEqual({});
});

it('derives every executable from the installed app layout', () => {
  expect(installedPaths('file:///Applications/Rat%20Things.app/Contents/Resources/cli.mjs', '/Applications/Rat Things.app/Contents/MacOS/node'))
    .toMatchObject({ bundledRuntime: '/Applications/Rat Things.app/Contents/Resources/Runtime.bundle',
      verifier: '/Applications/Rat Things.app/Contents/Helpers/rat-runtime-verifier',
      recovery: '/Applications/Rat Things.app/Contents/Helpers/rat-native-recovery' });
});

it('refuses a checkout, unrelated Node binary, or arbitrary script', () => {
  for (const [script, node] of [
    ['file:///checkout/src/cli.ts', '/usr/local/bin/node'],
    ['file:///Applications/Rat.app/Contents/Resources/cli.mjs', '/usr/local/bin/node'],
    ['file:///Applications/Rat.app/Contents/Resources/untrusted.mjs', '/Applications/Rat.app/Contents/MacOS/node'],
  ]) expect(() => installedPaths(script!, node!)).toThrow('installed Rat Things');
});
