import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { startLocalServer } from '../../src/local-server.js';
import { runWorkspaceCli } from '../../src/workspace-cli.js';
import type { LocalRuntime, LocalStartRequest } from '../../src/core/local-runtime-ports.js';
import { planLocalRuntimeSetup, type LocalRuntimeStatus } from '../../src/domain/local-runtime.js';
import { createLocalServices, LOCAL_OWNER } from '../../src/app/local-composition.js';
import { LocalSessionExecution } from '../../src/runner/local-session-execution.js';
import type { LocalManagedEnvironment } from '../../src/runner/local-managed-environment.js';
import type { SqliteAgentsStore } from '../../src/adapters/sqlite-agents-store.js';
import { LocalSubscription } from '../../src/runner/local-subscription.js';
import { LocalTransferService } from '../../src/app/local-transfer.js';

const status: LocalRuntimeStatus = { ready: true, engine: 'orbstack', image: 'fixture-image', checks: [{ id: 'image', ready: true, message: 'Fixture worker ready' }] };
function runtime(): LocalRuntime {
  return { status: vi.fn(async () => status), setup: vi.fn(async () => status),
    start: vi.fn(async (_request, commitWorkspaceClaim) => { await commitWorkspaceClaim(); return 'http://127.0.0.1:3211'; }), admitTurn: vi.fn(async () => {}), stop: vi.fn(async () => {}), running: vi.fn(async () => true),
    snapshot: vi.fn(async () => []), close: vi.fn(async () => {}) };
}
afterEach(() => vi.restoreAllMocks());

it('authenticates destination discovery and rejects malformed requests as client errors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rat-model-discovery-api-'));
  const models = vi.spyOn(LocalTransferService.prototype, 'models');
  const server = await startLocalServer({ directory, runtime: runtime() });
  try {
    const url = `${server.baseURL}/workspace/transfers/models`;
    const headers = { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' };
    expect((await fetch(url, { method: 'POST', body: '{}' })).status).toBe(403);
    expect(models).not.toHaveBeenCalled();
    const invalid = await fetch(url, { method: 'POST', headers, body: '{' });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: { code: 'invalid_json' } });
    expect(models).not.toHaveBeenCalled();
    expect((await fetch(url, { method: 'POST', headers, body: '' })).status).toBe(400);
    const catalog = { destination: { baseURL: 'https://fixture.example/v1', region: 'us-west-2' },
      models: { object: 'list' as const, data: [{ object: 'model' as const, id: 'cloud-model' }] } };
    models.mockResolvedValue(catalog);
    const input = { endpoint: 'https://fixture.example', region: 'us-west-2' };
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(input) });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual(catalog);
    expect(models).toHaveBeenLastCalledWith(input);
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
});

it('blocks setup before installing when prerequisites fail, and distinguishes missing artifacts', () => {
  expect(planLocalRuntimeSetup({ ...status, ready: false, install: 'build', checks: [{ id: 'engine', ready: false, message: 'No VM.', action: 'Start it.' }] }))
    .toEqual({ kind: 'blocked', message: 'No VM. Start it.' });
  expect(planLocalRuntimeSetup(status)).toEqual({ kind: 'ready' });
  expect(planLocalRuntimeSetup({ ...status, ready: false, install: 'pull', checks: [{ id: 'image', ready: false, message: 'Missing' }] }))
    .toEqual({ kind: 'install', method: 'pull' });
  expect(planLocalRuntimeSetup({ ...status, ready: false, install: 'unavailable', checks: [{ id: 'image', ready: false, message: 'Missing', action: 'No compatible release.' }] }))
    .toEqual({ kind: 'blocked', message: 'No compatible release.' });
});

it('keeps CLI dry-run observational and surfaces setup failure without reporting success', async () => {
  const backend = runtime();
  const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  await runWorkspaceCli(['runtime', 'setup', '--dry-run', '--json'], { runtime: backend });
  expect(backend.status).toHaveBeenCalledOnce();
  expect(backend.setup).not.toHaveBeenCalled();
  expect(JSON.parse(String(output.mock.calls[0]![0]))).toEqual(status);
  expect(backend.close).not.toHaveBeenCalled();
  output.mockClear();
  vi.mocked(backend.setup).mockRejectedValueOnce(new Error('Image verification failed'));
  await expect(runWorkspaceCli(['runtime', 'setup'], { runtime: backend })).rejects.toThrow('Image verification failed');
  expect(output).not.toHaveBeenCalled();
  expect(backend.close).not.toHaveBeenCalled();
});

it('reports the injected workspace runtime behind the authenticated local API and closes it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rat-runtime-api-'));
  const backend = runtime();
  const server = await startLocalServer({ directory, runtime: backend });
  try {
    expect((await fetch(`${server.baseURL}/workspace/runtime`)).status).toBe(403);
    expect(backend.status).not.toHaveBeenCalled();
    const response = await fetch(`${server.baseURL}/workspace/runtime`, { headers: { authorization: `Bearer ${server.token}` } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(status);
    expect(backend.status).toHaveBeenCalledOnce();
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
  expect(backend.close).toHaveBeenCalledOnce();
});

it('reports account and runtime health independently without exposing unexpected errors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rat-health-api-'));
  const backend = runtime();
  const account = { harness: 'codex' as const, provider: 'chatgpt', signed_in: true, account_type: 'chatgpt', email: null, plan: null };
  const readAccount = vi.spyOn(LocalSubscription.prototype, 'status').mockRejectedValue(new Error('private account diagnostic'));
  const server = await startLocalServer({ directory, runtime: backend });
  try {
    const url = `${server.baseURL}/workspace/health`;
    const headers = { authorization: `Bearer ${server.token}` };
    expect((await fetch(url)).status).toBe(403);
    expect(readAccount).not.toHaveBeenCalled();
    expect(backend.status).not.toHaveBeenCalled();
    const first = await fetch(url, { headers });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ runtime: status, subscription: { error: 'ChatGPT account status is unavailable. Try checking setup again.' } });
    readAccount.mockResolvedValue(account);
    vi.mocked(backend.status).mockRejectedValue(new Error('private runtime diagnostic'));
    const second = await fetch(url, { headers });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ subscription: account, runtime: { error: 'Local runtime status is unavailable. Try checking setup again.' } });
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
});

it('claims identity before boot and resumes the same generation after failure and restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rat-runtime-worker-'));
  const backend = runtime();
  let managed!: LocalManagedEnvironment;
  let store!: SqliteAgentsStore;
  const configurations: LocalStartRequest[] = [];
  let ready!: () => void;
  let fail!: (error: Error) => void;
  vi.mocked(backend.start).mockImplementation(async (request, commitWorkspaceClaim) => {
    await commitWorkspaceClaim();
    const url = 'http://127.0.0.1:3211';
    configurations.push(request);
    await new Promise<void>((resolve, reject) => { ready = resolve; fail = reject; });
    return url;
  });
  const services = createLocalServices({ directory, runtime: backend, execution: (storage, environment) => {
    managed = environment; store = storage;
    return new LocalSessionExecution({ store, directory, maxSessions: 2, managed });
  } });
  try {
    const environment = await managed.prepare(LOCAL_OWNER, 'sess_proof', { type: 'openai_hosted' });
    const agent = await services.agents.create(LOCAL_OWNER, { model: 'gpt-5.4' });
    const session = { id: 'sess_proof', object: 'agent.session' as const, agent: { ...agent, tools: [] }, environment, created_at: 1, last_active_at: 1,
      error: null, metadata: {}, status: 'idle' as const, required_actions: [], usage: null, vault_ids: [] };
    const first = managed.initialize(LOCAL_OWNER, session);
    const rejected = expect(first).rejects.toThrow('Boot failed');
    await vi.waitFor(() => expect(configurations).toHaveLength(1));
    const claimed = await store.get(LOCAL_OWNER, 'local_prepared', session.id);
    expect(claimed?.value).toMatchObject({ version: 1, sessionId: session.id });
    expect(configurations[0]!.workspace.kind).toBe('create');
    fail(new Error('Boot failed')); await rejected;
    expect(await store.get(LOCAL_OWNER, 'local_prepared', session.id)).toEqual(claimed);
    const retry = managed.initialize(LOCAL_OWNER, session);
    await vi.waitFor(() => expect(configurations).toHaveLength(2));
    expect(configurations[1]).toMatchObject({ workspace: { kind: 'resume', identity: claimed!.value }, worker: { sessionId: session.id } });
    expect(configurations[1]!.worker.executorKey).not.toBe(configurations[1]!.worker.harnessKey);
    ready(); await retry;
    expect(await store.get(LOCAL_OWNER, 'local_prepared', session.id)).toBeDefined();
    vi.mocked(backend.stop).mockRejectedValueOnce(new Error('Stop unconfirmed'));
    await expect(managed.close(LOCAL_OWNER, session)).rejects.toThrow('Stop unconfirmed');
    await expect(managed.initialize(LOCAL_OWNER, session)).rejects.toThrow('Local worker cleanup is unconfirmed');
    expect(configurations).toHaveLength(2);
    await managed.close(LOCAL_OWNER, session);
    const restart = managed.initialize(LOCAL_OWNER, session);
    await vi.waitFor(() => expect(configurations).toHaveLength(3));
    expect(configurations[2]!.workspace).toEqual(configurations[1]!.workspace);
    ready(); await restart;
    await managed.snapshot(session.id);
    expect(backend.snapshot).toHaveBeenCalledExactlyOnceWith(session.id);
    expect(backend.stop).toHaveBeenCalledWith(session.id);
    const reconnect = managed.initialize(LOCAL_OWNER, session);
    await vi.waitFor(() => expect(configurations).toHaveLength(4));
    ready(); await reconnect;
    const statusWrite = vi.spyOn(services.environments, 'managedStatus').mockRejectedValue(new Error('Status unavailable'));
    vi.mocked(backend.stop).mockClear();
    await expect(managed.close(LOCAL_OWNER, session)).rejects.toThrow('Status unavailable');
    expect(backend.stop).toHaveBeenCalledExactlyOnceWith(session.id);
    statusWrite.mockRestore();
    await managed.close(LOCAL_OWNER, session);
    const saved = (await store.get(LOCAL_OWNER, 'local_prepared', session.id))!;
    await store.put({ ...saved, revision: saved.revision + 1, value: { prepared: true } }, saved.revision);
    vi.mocked(backend.stop).mockClear();
    await expect(managed.initialize(LOCAL_OWNER, session)).rejects.toThrow();
    expect(configurations).toHaveLength(4);
    expect(backend.stop).not.toHaveBeenCalled();
  } finally { await services.close(); await rm(directory, { recursive: true, force: true }); }
  expect(backend.close).toHaveBeenCalledOnce();
});

it('reserves the last worker slot before asynchronous preparation can claim another workspace', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rat-runtime-capacity-'));
  const backend = runtime();
  let managed!: LocalManagedEnvironment;
  let store!: SqliteAgentsStore;
  const services = createLocalServices({ directory, runtime: backend, maxSessions: 1, execution: (storage, environment) => {
    managed = environment; store = storage;
    return new LocalSessionExecution({ store, directory, maxSessions: 1, managed });
  } });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(backend.start).mockImplementation(async (_request, commitWorkspaceClaim) => { await commitWorkspaceClaim(); await gate; return 'http://127.0.0.1:3211'; });
  try {
    const agent = await services.agents.create(LOCAL_OWNER, { model: 'gpt-5.4' });
    const sessions = await Promise.all(['sess_first', 'sess_second'].map(async id => ({ id, object: 'agent.session' as const,
      agent: { ...agent, tools: [] }, environment: await managed.prepare(LOCAL_OWNER, id, { type: 'openai_hosted' }), created_at: 1, last_active_at: 1,
      error: null, metadata: {}, status: 'idle' as const, required_actions: [], usage: null, vault_ids: [] })));
    const first = managed.initialize(LOCAL_OWNER, sessions[0]!);
    const second = managed.initialize(LOCAL_OWNER, sessions[1]!);
    await expect(second).rejects.toMatchObject({ code: 'local_capacity' });
    await vi.waitFor(() => expect(backend.start).toHaveBeenCalledOnce());
    expect(await store.get(LOCAL_OWNER, 'local_prepared', 'sess_second')).toBeUndefined();
    release(); await first;
  } finally { release(); await services.close(); await rm(directory, { recursive: true, force: true }); }
});

it('leaves workspace and attachment metadata untouched when a runtime refuses admission', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rat-runtime-refusal-'));
  const backend = runtime();
  let managed!: LocalManagedEnvironment;
  let store!: SqliteAgentsStore;
  const services = createLocalServices({ directory, runtime: backend, execution: (storage, environment) => {
    managed = environment; store = storage;
    return new LocalSessionExecution({ store, directory, maxSessions: 2, managed });
  } });
  const attach = vi.spyOn(services.environments, 'attachManaged');
  const writeStatus = vi.spyOn(services.environments, 'managedStatus');
  vi.mocked(backend.start).mockRejectedValue(new Error('Admission refused'));
  try {
    const agent = await services.agents.create(LOCAL_OWNER, { model: 'fixture' });
    const session = { id: 'sess_refused', object: 'agent.session' as const, agent: { ...agent, tools: [] },
      environment: await managed.prepare(LOCAL_OWNER, 'sess_refused', { type: 'openai_hosted' }), created_at: 1, last_active_at: 1,
      error: null, metadata: {}, status: 'idle' as const, required_actions: [], usage: null, vault_ids: [] };
    await managed.close(LOCAL_OWNER, session);
    expect(backend.start).not.toHaveBeenCalled();
    expect(backend.stop).not.toHaveBeenCalled();
    for (let attempt = 0; attempt < 2; attempt++) await expect(managed.initialize(LOCAL_OWNER, session)).rejects.toThrow('Admission refused');
    await managed.close(LOCAL_OWNER, session);
    expect(await store.get(LOCAL_OWNER, 'local_prepared', session.id)).toBeUndefined();
    expect(attach).not.toHaveBeenCalled();
    expect(writeStatus).not.toHaveBeenCalled();
    expect(backend.stop).not.toHaveBeenCalled();
    vi.mocked(backend.start).mockImplementation(async (request, commitWorkspaceClaim) => {
      expect(request.workspace.kind).toBe('create');
      expect(await store.get(LOCAL_OWNER, 'local_prepared', session.id)).toBeUndefined();
      await commitWorkspaceClaim();
      expect((await store.get(LOCAL_OWNER, 'local_prepared', session.id))?.value).toEqual(request.workspace.identity);
      return 'http://127.0.0.1:3211';
    });
    await managed.initialize(LOCAL_OWNER, session);
    expect(attach).toHaveBeenCalledOnce();
  } finally { await services.close(); await rm(directory, { recursive: true, force: true }); }
});
