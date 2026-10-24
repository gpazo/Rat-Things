import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { LocalNativeService } from '../../src/app/local-native-service.js';
import { LocalNativeRuntime } from '../../src/adapters/local-native-runtime.js';
import { SqliteAgentsStore } from '../../src/adapters/sqlite-agents-store.js';
import { LocalSubscription } from '../../src/runner/local-subscription.js';
import { startLocalServer } from '../../src/local-server.js';
import { fixtureHome, fixtureBundle, fixtureInstallation, fixtureVerifierWithoutSignatures, fixtureProbeWithoutVM,
  fixtureRequirements, fixtureLimits, removeInstallationFixture } from '../fixtures/native-installation.js';
import { gate } from '../simulation/native-runtime-fixtures.js';

vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, rm: vi.fn(original.rm) };
});

async function fixture(installed = false) {
  const home = await fixtureHome();
  const bundle = await fixtureBundle(home.directory, 'shutdown-review');
  if (installed) {
    const installer = fixtureInstallation(home.profile, bundle.bundle);
    await installer.startup(); await installer.setup();
  }
  const native = { bundledRuntimePath: bundle.bundle, verifier: fixtureVerifierWithoutSignatures,
    probe: () => fixtureProbeWithoutVM, requirements: fixtureRequirements, limits: fixtureLimits, environment: {} };
  return { ...home, native, cleanup: () => removeInstallationFixture(home.directory) };
}

it('closes the native selection gate before waiting for connection-file cleanup', async () => {
  const test = await fixture(true);
  const recovery = gate(); const cleanup = gate(); const reachedCleanup = gate();
  const originalStart = LocalNativeService.prototype.start;
  let service: LocalNativeService | undefined;
  const start = vi.spyOn(LocalNativeService.prototype, 'start').mockImplementation(function (this: LocalNativeService) {
    service = this; originalStart.call(this);
  });
  const originalFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const server = await startLocalServer({ directory: test.profile, native: { ...test.native,
    probe: () => ({ ...fixtureProbeWithoutVM, recover: async () => { await recovery.promise; return { kind: 'ready' as const }; } }) } });
  vi.mocked(rm).mockImplementation(async (path, options) => {
    if (path === join(test.profile, 'connection.json')) { reachedCleanup.release(); await cleanup.promise; }
    return originalFs.rm(path, options);
  });
  const closing = server.close();
  try {
    await reachedCleanup.promise;
    expect(service!.status().installation?.state).toBe('stopping');
    recovery.release();
    await service!.stop();
    expect(service!.ready()).toBe(false);
    expect(() => service!.hostCodex()).toThrow('not ready');
  } finally {
    recovery.release(); cleanup.release(); await closing;
    start.mockRestore(); vi.mocked(rm).mockImplementation(originalFs.rm); await test.cleanup();
  }
});

it('retains the service until an accepted account request settles', async () => {
  const test = await fixture(); const entered = gate(); const pending = gate();
  const status = vi.spyOn(LocalSubscription.prototype, 'status').mockImplementation(async () => {
    entered.release(); await pending.promise;
    return { harness: 'codex', provider: 'chatgpt', signed_in: false, account_type: null, email: null, plan: null };
  });
  const server = await startLocalServer({ directory: test.profile, native: test.native });
  const contender = new SqliteAgentsStore(test.profile);
  const request = fetch(`${server.baseURL}/workspace/subscription`, { headers: { authorization: `Bearer ${server.token}` } }).catch(() => undefined);
  let closed = false;
  let closing: Promise<void> | undefined;
  try {
    await entered.promise;
    closing = server.close().then(() => { closed = true; });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(closed).toBe(false);
    expect(() => contender.acquireServerLease()).toThrow('already running');
    pending.release(); await closing;
    expect(closed).toBe(true);
    contender.acquireServerLease();
  } finally {
    pending.release(); await closing; await server.close(); await request;
    contender.close(true); status.mockRestore(); await test.cleanup();
  }
});

it('still closes runtime children when connection-file removal fails', async () => {
  const test = await fixture();
  const runtimeClose = vi.spyOn(LocalNativeRuntime.prototype, 'close');
  const originalFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const server = await startLocalServer({ directory: test.profile, native: test.native });
  vi.mocked(rm).mockImplementation(async (path, options) => {
    if (path === join(test.profile, 'connection.json')) throw new Error('fixture connection cleanup failed');
    return originalFs.rm(path, options);
  });
  try {
    await expect(server.close()).rejects.toThrow('shutdown did not complete');
    expect(runtimeClose).toHaveBeenCalled();
  } finally {
    vi.mocked(rm).mockImplementation(originalFs.rm); runtimeClose.mockRestore();
    await test.cleanup();
  }
});
