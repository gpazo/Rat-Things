import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { SqliteAgentsStore } from '../../src/adapters/sqlite-agents-store.js';
import { LocalNativeRuntime } from '../../src/adapters/local-native-runtime.js';
import { createLocalServices, LOCAL_OWNER } from '../../src/app/local-composition.js';
import { LocalNativeService, type LocalNativeServiceOptions } from '../../src/app/local-native-service.js';
import type { NativeReleaseProbe } from '../../src/core/native-installation-ports.js';
import type { NativeRuntimeChangeRecord, NativeRuntimeChangeView } from '../../src/domain/local-native-change.js';
import { nativeReleaseId } from '../../src/domain/native-release.js';
import { startLocalServer } from '../../src/local-server.js';
import { LocalSessionExecution } from '../../src/runner/local-session-execution.js';
import { fixtureBundle, fixtureHome, fixtureInstallation, fixtureLimits, fixtureProbeWithoutVM, fixtureRequirements,
  fixtureVerifierWithoutSignatures, removeInstallationFixture } from '../fixtures/native-installation.js';
import { gate } from '../simulation/native-runtime-fixtures.js';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await removeInstallationFixture(directory); });

async function fixture() {
  const home = await fixtureHome(); directories.push(home.directory);
  const bundle = await fixtureBundle(home.directory, 'jobs-a');
  return { ...home, bundle };
}
function options(bundle: string, probe: NativeReleaseProbe = fixtureProbeWithoutVM): LocalNativeServiceOptions {
  return { bundledRuntimePath: bundle, verifier: fixtureVerifierWithoutSignatures, probe: () => probe,
    requirements: fixtureRequirements, limits: fixtureLimits, environment: {} };
}
function service(profile: string, native: LocalNativeServiceOptions) {
  const store = new SqliteAgentsStore(profile); store.acquireServerLease();
  const runtime = new LocalNativeService({ profileDirectory: profile, assertHeld: () => store.assertServerLease(),
    runWhileHeld: work => store.runWhileServerLeaseHeld(work) }, native, { store, owner: LOCAL_OWNER });
  return { store, runtime, async close() { await runtime.close(); await runtime.runtime.close(); await store.drainServerLease(); store.close(true); } };
}
async function settled(runtime: LocalNativeService, id: string, status: NativeRuntimeChangeView['status']) {
  await expect.poll(async () => (await runtime.retrieveChange(id)).status).toBe(status);
  return runtime.retrieveChange(id);
}
async function ready(runtime: LocalNativeService) {
  runtime.start();
  await expect.poll(() => runtime.status().installation?.state).not.toBe('checking');
}

it('reconciles a committed change on polling after transient terminal receipt failures', async () => {
  const test = await fixture();
  const run = vi.fn(fixtureProbeWithoutVM.run);
  const owner = service(test.profile, options(test.bundle.bundle, { ...fixtureProbeWithoutVM, run }));
  const put = owner.store.put.bind(owner.store);
  let failedWrites = 0;
  vi.spyOn(owner.store, 'put').mockImplementation(async (resource, revision) => {
    if ((resource.value as NativeRuntimeChangeRecord).state?.status === 'complete' && failedWrites < 2) {
      failedWrites++;
      throw new Error('Transient receipt write failure');
    }
    return put(resource, revision);
  });
  const id = randomUUID();
  try {
    await ready(owner.runtime);
    await owner.runtime.createChange('setup', { id });
    await expect.poll(() => failedWrites).toBe(2);
    await settled(owner.runtime, id, 'complete');
    expect(await owner.runtime.createChange('setup', { id })).toMatchObject({ kind: 'accepted', change: { status: 'complete' } });
    expect(run).toHaveBeenCalledTimes(1);
    expect(owner.runtime.ready()).toBe(true);
  } finally { await owner.close(); }
});

it('returns 202 while a probe is held, serves progress, and rejects overlapping changes', async () => {
  const test = await fixture(); const entered = gate(); const held = gate();
  const run = vi.fn(async () => { entered.release(); await held.promise; return { kind: 'ready' as const }; });
  const server = await startLocalServer({ directory: test.profile, native: options(test.bundle.bundle, { ...fixtureProbeWithoutVM, run }) });
  const id = randomUUID();
  const request = (path: string, body?: unknown) => fetch(`${server.baseURL}/workspace/runtime${path}`, {
    headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), signal: AbortSignal.timeout(2000),
  });
  try {
    await expect.poll(async () => (await (await request('')).json()).installation.state).toBe('needs_setup');
    const submitted = await request('/setup', { id });
    expect(submitted.status).toBe(202);
    expect(await submitted.json()).toMatchObject({ id, action: 'setup', status: 'queued' });
    await entered.promise;
    const progress = await (await request(`/changes/${id}`)).json();
    expect(progress).toMatchObject({ id, status: 'working', phase: 'probing' });
    expect(JSON.stringify(progress)).not.toContain(test.profile);
    expect(JSON.stringify(progress)).not.toContain(test.bundle.id);
    expect((await request('')).status).toBe(200);
    const duplicate = await request('/setup', { id });
    expect(duplicate.status).toBe(202);
    expect(await duplicate.json()).toMatchObject({ id, status: 'working' });
    for (const [path, body, code] of [['/rollback', { id }, 'request_id_reused'], ['/setup', { id: randomUUID() }, 'change_active']] as const) {
      const conflict = await request(path, body);
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toMatchObject({ error: { code, current_change_id: id } });
    }
    const reader = new SqliteAgentsStore(test.profile);
    try {
      expect((await reader.get<NativeRuntimeChangeRecord>(LOCAL_OWNER, 'local_native_changes', id))!.value.intent)
        .toEqual({ target: test.bundle.id, startingGeneration: 0, requestedGeneration: 1 });
    } finally { reader.close(); }
    await expect(lstat(join(test.profile, 'codex'))).rejects.toMatchObject({ code: 'ENOENT' });
    held.release();
    await expect.poll(async () => (await (await request(`/changes/${id}`)).json()).status).toBe('complete');
    expect(await (await request('/setup', { id })).json()).toMatchObject({ id, status: 'complete' });
    expect(run).toHaveBeenCalledOnce();
    for (const body of [{ id: 'invalid' }, { id: randomUUID(), bundledRuntimePath: test.bundle.bundle }, { id: randomUUID(), target: test.bundle.id }]) {
      expect((await request('/setup', body)).status).toBe(400);
    }
    expect((await fetch(`${server.baseURL}/workspace/runtime/setup`, { method: 'POST', body: JSON.stringify({ id: randomUUID() }) })).status).toBe(403);
  } finally { held.release(); await server.close(); }
});

it('reconciles a selection commit after the completion receipt could not be saved', async () => {
  const test = await fixture(); const run = vi.fn(fixtureProbeWithoutVM.run);
  const native = options(test.bundle.bundle, { ...fixtureProbeWithoutVM, run });
  const first = service(test.profile, native); const id = randomUUID();
  const put = first.store.put.bind(first.store);
  const failure = vi.spyOn(first.store, 'put').mockImplementation(async (resource, revision) => {
    if (resource.collection === 'local_native_changes' && (resource.value as NativeRuntimeChangeRecord).state.status === 'complete') throw new Error('fixture lost completion write');
    await put(resource, revision);
  });
  try {
    await ready(first.runtime);
    await first.runtime.createChange('setup', { id });
    await expect.poll(() => first.runtime.ready()).toBe(true);
    await first.runtime.stop();
    expect((await first.runtime.retrieveChange(id)).status).toBe('working');
    expect((await first.store.get<NativeRuntimeChangeRecord>(LOCAL_OWNER, 'local_native_changes', id))!.value.intent?.target).toBe(test.bundle.id);
  } finally { failure.mockRestore(); await first.close(); }
  const next = service(test.profile, native);
  try {
    await ready(next.runtime);
    expect(await next.runtime.retrieveChange(id)).toMatchObject({ status: 'complete' });
    expect(await next.runtime.createChange('setup', { id })).toMatchObject({ kind: 'accepted', change: { status: 'complete' } });
    expect(next.runtime.status().installation?.generation).toBe(2);
    expect(run).toHaveBeenCalledOnce();
  } finally { await next.close(); }
});

it('reconciles rollback without executing it again against a changed previous release', async () => {
  const test = await fixture(); const b = await fixtureBundle(test.directory, 'jobs-b');
  const initial = fixtureInstallation(test.profile, test.bundle.bundle); await initial.startup(); await initial.setup();
  const update = fixtureInstallation(test.profile, b.bundle); await update.startup(); await update.setup();
  const first = service(test.profile, options(b.bundle)); const id = randomUUID();
  try {
    await ready(first.runtime);
    const host = first.runtime.hostCodex();
    await first.runtime.createChange('rollback', { id });
    await settled(first.runtime, id, 'awaiting_restart');
    expect(first.runtime.hostCodex()).toBe(host);
    expect(first.runtime.status().installation).toMatchObject({ active: b.id, pending: test.bundle.id, generation: 5 });
  } finally { await first.close(); }
  const newer = await fixtureBundle(test.directory, 'jobs-c');
  const next = service(test.profile, options(newer.bundle));
  try {
    await ready(next.runtime);
    expect(await next.runtime.retrieveChange(id)).toMatchObject({ status: 'complete' });
    expect(await next.runtime.createChange('rollback', { id })).toMatchObject({ kind: 'accepted', change: { status: 'complete' } });
    expect(next.runtime.status().installation).toMatchObject({ active: test.bundle.id, previous: b.id, pending: null, generation: 6 });
    expect(next.runtime.hostCodex().binary).toContain(test.bundle.id);
  } finally { await next.close(); }
});

it('keeps the pinned host and pending selection after a failed update and needs a fresh retry ID', async () => {
  const test = await fixture(); const b = await fixtureBundle(test.directory, 'jobs-b');
  const initial = fixtureInstallation(test.profile, test.bundle.bundle); await initial.startup(); await initial.setup();
  let rejected = false;
  const verify = vi.fn(async (input: Parameters<typeof fixtureVerifierWithoutSignatures.verify>[0]) => {
    if (rejected) throw new Error('/private/source subprocess output must stay private');
    return fixtureVerifierWithoutSignatures.verify(input);
  });
  const first = service(test.profile, { ...options(b.bundle), verifier: { verify } });
  const stagedId = randomUUID(); const failedId = randomUUID();
  try {
    await ready(first.runtime);
    const host = first.runtime.hostCodex();
    await first.runtime.createChange('setup', { id: stagedId }); await settled(first.runtime, stagedId, 'awaiting_restart');
    rejected = true;
    await first.runtime.createChange('setup', { id: failedId });
    expect(await settled(first.runtime, failedId, 'failed')).toMatchObject({ failure: 'verifier_unavailable' });
    const calls = verify.mock.calls.length;
    rejected = false;
    expect(await first.runtime.createChange('setup', { id: failedId })).toMatchObject({ change: { status: 'failed' } });
    expect(verify).toHaveBeenCalledTimes(calls);
    expect(first.runtime.hostCodex()).toBe(host);
    expect(first.runtime.status().installation).toMatchObject({ active: test.bundle.id, pending: b.id });
    const retryId = randomUUID(); await first.runtime.createChange('setup', { id: retryId }); await settled(first.runtime, retryId, 'awaiting_restart');
    expect(first.runtime.hostCodex()).toBe(host);
    expect(JSON.stringify(await first.runtime.retrieveChange(failedId))).not.toContain('/private/source');
  } finally { await first.close(); }
  const next = service(test.profile, options(b.bundle, { ...fixtureProbeWithoutVM,
    run: async () => ({ kind: 'failed', failure: { kind: 'probe', reason: 'failed', detail: '/private/failed-probe' } }) }));
  try {
    await ready(next.runtime);
    expect(next.runtime.status().installation).toMatchObject({ state: 'ready', active: test.bundle.id, pending: b.id, failure: 'probe' });
    expect(next.runtime.hostCodex().binary).toContain(test.bundle.id);
    expect(await next.runtime.retrieveChange(failedId)).toMatchObject({ status: 'failed', failure: 'verifier_unavailable' });
    expect(JSON.stringify(next.runtime.status())).not.toContain('/private/failed-probe');
  } finally { await next.close(); }
});

it('marks an uneffected prior request interrupted without retargeting it to the included release', async () => {
  const test = await fixture(); const next = service(test.profile, options(test.bundle.bundle)); const id = randomUUID();
  await next.store.put({ ownerId: LOCAL_OWNER, collection: 'local_native_changes', id, createdAt: 1, revision: 1,
    value: { schemaVersion: 1, id, action: 'setup', createdAt: 1, updatedAt: 1, intent: null, state: { status: 'queued' } } satisfies NativeRuntimeChangeRecord }, 0);
  try {
    await ready(next.runtime);
    expect(await next.runtime.retrieveChange(id)).toMatchObject({ status: 'failed', failure: 'interrupted' });
    expect(await next.runtime.createChange('setup', { id })).toMatchObject({ change: { status: 'failed', failure: 'interrupted' } });
    expect(next.runtime.status().installation).toMatchObject({ state: 'needs_setup', generation: 0, active: null });
    expect(() => next.runtime.hostCodex()).toThrow('not ready');
  } finally { await next.close(); }
});

it('keeps dispatch closed until restart receipt reconciliation is persisted', async () => {
  const test = await fixture(); const initial = fixtureInstallation(test.profile, test.bundle.bundle); await initial.startup(); await initial.setup();
  const next = service(test.profile, options(test.bundle.bundle)); const id = randomUUID();
  await next.store.put({ ownerId: LOCAL_OWNER, collection: 'local_native_changes', id, createdAt: 1, revision: 1,
    value: { schemaVersion: 1, id, action: 'setup', createdAt: 1, updatedAt: 1,
      intent: { target: nativeReleaseId(test.bundle.id), startingGeneration: 0, requestedGeneration: 1 },
      state: { status: 'working', phase: 'selecting' } } satisfies NativeRuntimeChangeRecord }, 0);
  const entered = gate(); const held = gate(); const put = next.store.put.bind(next.store);
  const write = vi.spyOn(next.store, 'put').mockImplementation(async (resource, revision) => {
    if (resource.collection === 'local_native_changes') { entered.release(); await held.promise; }
    await put(resource, revision);
  });
  try {
    next.runtime.start(); await entered.promise;
    expect(next.runtime.ready()).toBe(false); expect(() => next.runtime.hostCodex()).toThrow('not ready');
    held.release(); await expect.poll(() => next.runtime.ready()).toBe(true);
    expect(await next.runtime.retrieveChange(id)).toMatchObject({ status: 'complete' });
  } finally { held.release(); write.mockRestore(); await next.close(); }
});

it('drains a job accepted during startup before closing its probe or releasing the lease', async () => {
  const test = await fixture(); const recovery = gate(); const entered = gate(); const held = gate();
  const closeProbe = vi.fn(async () => {});
  const server = await startLocalServer({ directory: test.profile, native: options(test.bundle.bundle, {
    recover: async () => { await recovery.promise; return { kind: 'ready' }; },
    run: async () => { entered.release(); await held.promise; return { kind: 'ready' }; }, close: closeProbe,
  }) });
  const contender = new SqliteAgentsStore(test.profile); const id = randomUUID();
  const response = await fetch(`${server.baseURL}/workspace/runtime/setup`, { method: 'POST', headers: {
    authorization: `Bearer ${server.token}`, 'content-type': 'application/json',
  }, body: JSON.stringify({ id }), signal: AbortSignal.timeout(2000) });
  expect(response.status).toBe(202);
  let stopped = false; const closing = server.close().then(() => { stopped = true; });
  try {
    recovery.release(); await entered.promise;
    expect(stopped).toBe(false); expect(closeProbe).not.toHaveBeenCalled();
    expect(() => contender.acquireServerLease()).toThrow('already running');
    held.release(); await closing;
    expect(closeProbe).toHaveBeenCalledOnce();
    expect((await contender.get<NativeRuntimeChangeRecord>(LOCAL_OWNER, 'local_native_changes', id))!.value.state.status).toBe('complete');
    contender.acquireServerLease();
  } finally { recovery.release(); held.release(); await closing; contender.close(true); }
});

it('attempts runtime cleanup but keeps the lease when probe cleanup remains unconfirmed', async () => {
  const test = await fixture(); let owner: SqliteAgentsStore | undefined;
  const closeRuntime = vi.spyOn(LocalNativeRuntime.prototype, 'close');
  const services = createLocalServices({ directory: test.profile, native: options(test.bundle.bundle, { ...fixtureProbeWithoutVM,
    close: async () => { throw new Error('fixture cleanup unconfirmed'); } }), execution: store => {
    owner = store; return new LocalSessionExecution({ store, directory: test.profile, maxSessions: 1, environment: {} });
  } });
  const contender = new SqliteAgentsStore(test.profile);
  try {
    services.start();
    await expect(services.close()).rejects.toThrow('shutdown did not complete');
    expect(closeRuntime).toHaveBeenCalledOnce();
    expect(() => contender.acquireServerLease()).toThrow('already running');
  } finally { owner!.close(true); contender.close(); closeRuntime.mockRestore(); }
});
