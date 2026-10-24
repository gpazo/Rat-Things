import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { NativeRuntimeChangeIntent, NativeRuntimeChangePhase } from '../../src/domain/local-native-change.js';
import { fixtureBundle, fixtureHome, fixtureInstallation, fixtureProbeWithoutVM, removeInstallationFixture } from '../fixtures/native-installation.js';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await removeInstallationFixture(directory); });

it('persists authenticated intent before copying or selecting and reports finite phases separately from checkpoints', async () => {
  const { directory, profile } = await fixtureHome(); directories.push(directory);
  const bundle = await fixtureBundle(directory, 'progress');
  const phases: NativeRuntimeChangePhase[] = [];
  let intent: NativeRuntimeChangeIntent | undefined;
  const checkpoint = vi.fn(async () => { expect(intent?.target).toBe(bundle.id); });
  const installation = fixtureInstallation(profile, bundle.bundle, { checkpoint,
    probe: { ...fixtureProbeWithoutVM, run: async () => {
      expect(intent).toEqual({ target: bundle.id, startingGeneration: 0, requestedGeneration: 1 });
      expect(installation.status().change).toMatchObject({ kind: 'working', phase: 'probing' });
      return { kind: 'ready' };
    } } });
  await installation.startup();
  const result = await installation.setup({
    beforeMutation: async value => {
      expect(installation.status().selection.generation).toBe(0);
      expect(await readdir(join(profile, 'runtime/versions'))).toEqual([]);
      intent = value;
    }, progress: phase => { phases.push(phase); },
  });
  expect(result.change).toEqual({ kind: 'none' });
  expect(result.selected?.id).toBe(bundle.id);
  expect(new Set(phases)).toEqual(new Set(['checking', 'copying', 'verifying', 'probing', 'selecting']));
  expect(checkpoint).toHaveBeenCalled();
});

it('refuses mutation when intent persistence fails but ignores progress callback failures', async () => {
  const { directory, profile } = await fixtureHome(); directories.push(directory);
  const bundle = await fixtureBundle(directory, 'intent-failure');
  const installation = fixtureInstallation(profile, bundle.bundle);
  await installation.startup();
  const failed = await installation.setup({ beforeMutation: async () => { throw new Error('receipt write failed'); } });
  expect(failed.change).toMatchObject({ kind: 'failed' });
  expect(failed.selection.generation).toBe(0);
  expect(await readdir(join(profile, 'runtime/versions'))).toEqual([]);
  const successful = await installation.setup({ progress: async () => { throw new Error('progress write failed'); } });
  expect(successful.selection.active).toBe(bundle.id);
  expect(successful.change).toEqual({ kind: 'none' });
});

it('does not claim an authoritative selection before recovery permits reading it', async () => {
  const { directory, profile } = await fixtureHome(); directories.push(directory);
  const bundle = await fixtureBundle(directory, 'unknown-selection');
  const initial = fixtureInstallation(profile, bundle.bundle); await initial.startup(); await initial.setup();
  const failed = fixtureInstallation(profile, bundle.bundle, { probe: { ...fixtureProbeWithoutVM,
    recover: async () => ({ kind: 'failed', failure: { kind: 'probe', reason: 'recovery', detail: 'fixture lock held' } }) } });
  expect((await failed.startup()).selectionKnown).toBe(false);
  expect((await initial.startup()).selectionKnown).toBe(true);
});
