import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { SqliteAgentsStore } from '../../src/adapters/sqlite-agents-store.js';
import { createLocalServices, LOCAL_OWNER } from '../../src/app/local-composition.js';
import { LocalNativeService, type LocalNativeServiceOptions } from '../../src/app/local-native-service.js';
import { AgentService } from '../../src/core/agent-service.js';
import { SessionService } from '../../src/core/session-service.js';
import type { SessionState } from '../../src/core/session-ports.js';
import type { NativeInstallationLease } from '../../src/core/native-installation-ports.js';
import { startLocalServer } from '../../src/local-server.js';
import { LocalSessionExecution } from '../../src/runner/local-session-execution.js';
import { fixtureBundle, fixtureHome, fixtureInstallation, fixtureLimits, fixtureProbeWithoutVM, fixtureRequirements,
  fixtureVerifierWithoutSignatures, removeInstallationFixture } from '../fixtures/native-installation.js';
import { gate } from '../simulation/native-runtime-fixtures.js';

async function fixture(installed = false) {
  const home = await fixtureHome();
  const bundle = await fixtureBundle(home.directory, 'startup');
  if (installed) {
    const installation = fixtureInstallation(home.profile, bundle.bundle);
    await installation.startup();
    expect((await installation.setup()).selected?.id).toBe(bundle.id);
  }
  const native: LocalNativeServiceOptions = { bundledRuntimePath: bundle.bundle, verifier: fixtureVerifierWithoutSignatures,
    probe: () => fixtureProbeWithoutVM, requirements: fixtureRequirements, limits: fixtureLimits, environment: {} };
  return { ...home, bundle, native, cleanup: () => removeInstallationFixture(home.directory) };
}

function lease(store: SqliteAgentsStore, directory: string): NativeInstallationLease {
  return { profileDirectory: directory, assertHeld: () => store.assertServerLease(), runWhileHeld: work => store.runWhileServerLeaseHeld(work) };
}

it('binds authenticated HTTP before recovery and answers status without starting account or model processes', async () => {
  const test = await fixture();
  const held = gate();
  const recover = vi.fn(async () => { await held.promise; return { kind: 'ready' as const }; });
  const server = await startLocalServer({ directory: test.profile, native: { ...test.native,
    probe: () => ({ ...fixtureProbeWithoutVM, recover }) } });
  const get = (path: string) => fetch(`${server.baseURL}/${path}`, {
    headers: { authorization: `Bearer ${server.token}` }, signal: AbortSignal.timeout(2000),
  });
  try {
    await vi.waitFor(() => expect(recover).toHaveBeenCalledOnce());
    expect((await get('workspace')).status).toBe(200);
    expect(await (await get('workspace/runtime')).json()).toMatchObject({ ready: false, installation: { state: 'checking' } });
    expect(await (await get('workspace/health')).json()).toMatchObject({ subscription: { state: 'waiting_for_runtime' }, runtime: { ready: false } });
    for (const path of ['workspace/subscription', 'models']) {
      const response = await get(path);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: 'local_runtime_starting' } });
    }
    const create = await fetch(`${server.baseURL}/agents/sessions`, { method: 'POST', headers: {
      authorization: `Bearer ${server.token}`, 'content-type': 'application/json',
    }, body: JSON.stringify({ agent: { model: 'fixture' }, environment: { type: 'none' }, input: 'Wait for setup' }) });
    expect(create.status).toBe(503);
    await expect(lstat(join(test.profile, 'codex'))).rejects.toMatchObject({ code: 'ENOENT' });
    held.release();
    await expect.poll(async () => (await (await get('workspace/runtime')).json()).installation.state).toBe('needs_setup');
  } finally { held.release(); await server.close(); await test.cleanup(); }
});

it('keeps persisted Turn receipts undispatched until startup selects a release', async () => {
  const test = await fixture();
  const store = new SqliteAgentsStore(test.profile);
  const execution = new LocalSessionExecution({ store, directory: test.profile, maxSessions: 1, environment: {} });
  const sessions = new SessionService({ store, agents: new AgentService({ store }), execution });
  const session = await sessions.create(LOCAL_OWNER, { agent: { model: 'fixture' }, environment: { type: 'none' }, input: 'Queued input' });
  const held = gate();
  const recover = vi.fn(async () => { await held.promise; return { kind: 'ready' as const }; });
  const initialize = vi.fn(async () => {});
  const services = createLocalServices({ directory: test.profile, native: { ...test.native,
    probe: () => ({ ...fixtureProbeWithoutVM, recover }) }, execution: liveStore => {
    const live = new LocalSessionExecution({ store: liveStore, directory: test.profile, maxSessions: 1, environment: {} });
    live.initialize = initialize;
    return live;
  } });
  try {
    services.start();
    await vi.waitFor(() => expect(recover).toHaveBeenCalledOnce());
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(initialize).not.toHaveBeenCalled();
    expect((await store.get<SessionState>(LOCAL_OWNER, 'sessions', session.id))!.value.receipts.initial?.dispatched).toBe(false);
    expect((await store.list(LOCAL_OWNER, 'local_turn_attempts', {})).data).toEqual([]);
  } finally { held.release(); await services.close(); await execution.shutdown(); store.close(); await test.cleanup(); }
});

it('retains the lease through held startup and never exposes a late selection after shutdown', async () => {
  const test = await fixture(true);
  const owner = new SqliteAgentsStore(test.profile);
  const contender = new SqliteAgentsStore(test.profile);
  owner.acquireServerLease();
  const held = gate();
  const recover = vi.fn(async () => { await held.promise; return { kind: 'ready' as const }; });
  const service = new LocalNativeService(lease(owner, test.profile), { ...test.native, probe: () => ({ ...fixtureProbeWithoutVM, recover }) });
  try {
    service.start();
    const stopped = service.stop();
    const draining = owner.drainServerLease();
    await vi.waitFor(() => expect(recover).toHaveBeenCalledOnce());
    expect(() => owner.close(true)).toThrow('still running');
    expect(() => contender.acquireServerLease()).toThrow('already running');
    held.release();
    await stopped; await draining;
    expect(service.status().installation).toMatchObject({ state: 'stopping', active: test.bundle.id });
    expect(service.ready()).toBe(false);
    expect(() => service.hostCodex()).toThrow('not ready');
    await expect(lstat(join(test.profile, 'codex'))).rejects.toMatchObject({ code: 'ENOENT' });
    owner.close(true);
    contender.acquireServerLease();
  } finally { held.release(); await service.stop(); await service.runtime.close(); owner.close(true); contender.close(true); await test.cleanup(); }
});

it('pins the copied host and companion paths without accepting ambient executable overrides', async () => {
  const test = await fixture(true);
  const owner = new SqliteAgentsStore(test.profile);
  owner.acquireServerLease();
  const ambient = { CODEX_BINARY: '/untrusted/codex', PATH: '/untrusted/bin', HTTPS_PROXY: 'http://proxy.example' };
  const service = new LocalNativeService(lease(owner, test.profile), { ...test.native, environment: ambient });
  try {
    expect(() => service.hostCodex()).toThrow('not ready');
    service.start();
    ambient.PATH = '/changed/bin'; ambient.HTTPS_PROXY = 'http://changed.example';
    await vi.waitFor(() => expect(service.ready()).toBe(true));
    const host = service.hostCodex();
    const bundle = join(test.profile, 'runtime/versions', test.bundle.id, 'Runtime.bundle');
    expect(host.binary).toBe(join(bundle, 'Contents/Helpers/codex'));
    expect(host.environment.PATH).toBe(`${bundle}/Contents/Resources/codex/codex-path:${bundle}/Contents/Resources/codex/codex-resources/zsh/bin:/usr/bin:/bin:/usr/sbin:/sbin`);
    expect(host.environment.HTTPS_PROXY).toBe('http://proxy.example');
    expect(Object.isFrozen(host)).toBe(true);
    expect(Object.isFrozen(host.environment)).toBe(true);
    expect(service.hostCodex()).toBe(host);
  } finally { await service.stop(); await service.runtime.close(); await owner.drainServerLease(); owner.close(true); await test.cleanup(); }
});

it('reports an unavailable selection without leaking filesystem details or running account processes', async () => {
  const test = await fixture(true);
  const owner = new SqliteAgentsStore(test.profile);
  owner.acquireServerLease();
  const service = new LocalNativeService(lease(owner, test.profile), { ...test.native, verifier: {
    verify: async () => { throw new Error('/private/host/path must not be returned over HTTP'); },
  } });
  try {
    service.start();
    await expect.poll(() => service.status().installation?.state).toBe('failed');
    expect(service.status().installation?.failure).toBe('verifier_unavailable');
    expect(JSON.stringify(service.status())).not.toContain('/private/host/path');
    expect(() => service.hostCodex()).toThrow('not ready');
  } finally { await service.stop(); await service.runtime.close(); await owner.drainServerLease(); owner.close(true); await test.cleanup(); }
});
