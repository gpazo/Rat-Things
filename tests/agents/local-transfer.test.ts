import OpenAI from 'openai';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { integrationFixture } from './integration-fixtures.js';
import { LocalTransferService } from '../../src/app/local-transfer.js';
import { EnvironmentService } from '../../src/core/environment-service.js';
import { EnvironmentTemplateService } from '../../src/core/environment-template-service.js';
import type { SessionImport } from '../../src/domain/session-transfer.js';

it.each([undefined, 'bedrock-test-model'])('preflights, snapshots and resumes an import with destination model %s and local state retained', async (model) => {
  const f = await integrationFixture();
  f.execution.items = async () => [];
  const templates = new EnvironmentTemplateService({ store: f.store });
  const environments = new EnvironmentService({ store: f.store, templates, managedFiles: async () => [],
    uploadedFiles: { retrieve: async (_owner, id) => ({ id, object: 'file', filename: 'workspace', bytes: 100, created_at: 1, purpose: 'user_data', status: 'processed' }), reference: async () => ({ bucket: 'fixture', key: 'workspace', sha256: '0'.repeat(64) }) },
    credentials: { create: async () => { throw new Error('no credentials'); }, read: async () => { throw new Error('no credentials'); }, revoke: async () => {} } });
  f.execution.prepare = (owner, id, input) => environments.prepare(owner, id, input);
  const source = await f.sessions.create('operator', { agent: { model: 'test' }, environment: { type: 'openai_hosted', setup_commands: [{ command: 'echo only-once' }],
    env: { GITHUB_TOKEN: 'local-token-fixture', PROJECT_MODE: 'local-mode-fixture' } } });
  const requests: Array<{ path: string; body: unknown }> = [];
  let loseResponse = true;
  let catalogAvailable = true;
  const client = () => new OpenAI({ apiKey: 'fixture', baseURL: 'https://fixture.example/v1', maxRetries: 0, fetch: async (input, init) => {
    const request = new Request(input, init); const path = new URL(request.url).pathname;
    if (request.method === 'GET') return Response.json(path.endsWith('/models') ? { object: 'list', data: catalogAvailable ? [{ id: model ?? 'test', object: 'model', created: 1, owned_by: 'fixture' }] : [] } : { version: 1, max_history_bytes: 2 * 1024 * 1024, credentials: 'destination', execution: 'on_next_message' });
    if (path.endsWith('/files')) { requests.push({ path, body: 'workspace archive' }); return Response.json({ id: 'file-fixture' }); }
    const body = await request.json() as SessionImport; requests.push({ path, body });
    const imported = await f.sessions.import('destination', body);
    if (loseResponse) { loseResponse = false; throw new Error('Response lost after commit'); }
    return Response.json(imported);
  } });
  const options = { store: f.store, sessions: f.sessions, environments, owner: 'operator', snapshot: vi.fn(async () => [{ path: 'home.txt', mode: 0o644, data: Buffer.from('portable workspace').toString('base64') }]), client,
    modelsFetch: () => async () => Response.json({ object: 'list', data: catalogAvailable ? [{ id: model ?? 'test', object: 'model' }] : [] }) };
  let service = new LocalTransferService(options);
  const plan = await service.create({ session_id: source.id, endpoint: 'https://fixture.example/v1', region: 'us-west-2', ...(model ? { model } : {}) });
  await expect.poll(async () => { const result = await service.retrieve(plan.id); return { status: result.status, error: result.error }; }).toEqual({ status: 'ready', error: null });
  expect(requests).toHaveLength(0);
  expect(await service.retrieve(plan.id)).toMatchObject({ source_model: 'test', model: model ?? 'test' });
  expect(JSON.stringify(await service.retrieve(plan.id))).not.toContain('portable workspace');
  await service.execute(plan.id);
  await expect.poll(async () => (await service.retrieve(plan.id)).status).toBe('failed');
  await service.close();
  catalogAvailable = false;
  service = new LocalTransferService(options);
  await service.execute(plan.id);
  await expect.poll(async () => (await service.retrieve(plan.id)).status).toBe('complete');
  expect(requests.filter(request => request.path.endsWith('/files'))).toHaveLength(1);
  const imports = requests.filter(request => request.path.endsWith('/import'));
  expect(imports).toHaveLength(2);
  expect(imports[0]?.body).toEqual(imports[1]?.body);
  expect((imports[0]?.body as SessionImport).session.agent?.model).toBe(model ?? 'test');
  expect(JSON.stringify(imports[0]?.body)).not.toContain('only-once');
  expect(JSON.stringify(imports[0]?.body)).not.toContain('local-token-fixture');
  expect(JSON.stringify(imports[0]?.body)).not.toContain('local-mode-fixture');
  expect((imports[0]?.body as SessionImport).session.environment).not.toHaveProperty('env');
  if (source.environment.type !== 'openai_hosted') throw new Error('Expected managed environment');
  expect((await environments.managedLaunch('operator', source.environment.id)).hostedConfiguration?.env).toEqual({ GITHUB_TOKEN: 'local-token-fixture', PROJECT_MODE: 'local-mode-fixture' });
  expect((await f.sessions.list('destination')).data).toHaveLength(1);
  expect((await f.sessions.retrieve('operator', source.id)).id).toBe(source.id);
  expect((await f.sessions.retrieve('operator', source.id)).agent.model).toBe('test');
  expect(f.execution.start).not.toHaveBeenCalled();
  expect(options.snapshot).toHaveBeenCalledTimes(1);
  await service.close();
});

it('rejects unavailable destination models before snapshot and rechecks them before upload', async () => {
  const f = await integrationFixture();
  f.execution.items = async () => [];
  const source = await f.sessions.create('operator', { agent: { model: 'test' }, environment: { type: 'none' }, input: 'Keep this local.' });
  await f.sessions.dispatch('operator', source.id);
  const observed = [...f.observations.values()][0]!;
  f.observations.set(observed.turn.id, { ...observed, turn: { ...observed.turn, status: 'completed', completed_at: 2 } });
  const environments = new EnvironmentService({ store: f.store, templates: new EnvironmentTemplateService({ store: f.store }),
    credentials: { create: async () => { throw new Error('unused'); }, read: async () => { throw new Error('unused'); }, revoke: async () => {} } });
  const snapshot = vi.spyOn(f.sessions, 'snapshotForTransfer');
  let models = ['bedrock-test-model'];
  const posts = vi.fn();
  const client = () => new OpenAI({ apiKey: 'fixture', baseURL: 'https://fixture.example/v1', maxRetries: 0, fetch: async (input, init) => {
    const request = new Request(input, init);
    if (request.method !== 'GET') { posts(); throw new Error('Unexpected upload'); }
    return Response.json(new URL(request.url).pathname.endsWith('/models')
      ? { object: 'list', data: models.map(id => ({ id, object: 'model', created: 1, owned_by: 'fixture' })) }
      : { version: 1, max_history_bytes: 2 * 1024 * 1024, credentials: 'destination', execution: 'on_next_message' });
  } });
  const service = new LocalTransferService({ store: f.store, sessions: f.sessions, environments, owner: 'operator', snapshot: async () => [], client,
    modelsFetch: () => async () => Response.json({ object: 'list', data: models.map(id => ({ id, object: 'model' })) }) });
  const input = { session_id: source.id, endpoint: 'https://fixture.example/v1', region: 'us-west-2' };
  try {
    for (const model of [null, '', ' padded ', 42, 'bad\nmodel']) await expect(service.create({ ...input, model })).rejects.toMatchObject({ status: 400, param: 'model' });
    const rejected = await service.create(input);
    await expect.poll(async () => (await service.retrieve(rejected.id)).status).toBe('failed');
    expect((await service.retrieve(rejected.id)).error).toContain('selected model');
    expect(snapshot).not.toHaveBeenCalled();
    const ready = await service.create({ ...input, model: 'bedrock-test-model' });
    await expect.poll(async () => (await service.retrieve(ready.id)).status).toBe('ready');
    expect(snapshot).toHaveBeenCalledTimes(1);
    models = [];
    await service.execute(ready.id);
    await expect.poll(async () => (await service.retrieve(ready.id)).status).toBe('failed');
    expect(posts).not.toHaveBeenCalled();
    expect((await f.sessions.retrieve('operator', source.id)).agent.model).toBe('test');
  } finally { await service.close(); }
});

it.each(['snapshot.request', 'importRequest'] as const)('rejects legacy saved %s environment values before upload or import', async (legacyLocation) => {
  const f = await integrationFixture();
  const id = randomUUID();
  const request = (env: Record<string, string>) => ({
    version: 1 as const,
    transfer_id: id,
    source_session_id: 'sess_source',
    history: [],
    session: { environment: { type: 'openai_hosted' as const, env } },
  }) as unknown as SessionImport;
  const safeRequest = request({});
  const legacyRequest = request({ GITHUB_TOKEN: 'legacy-token-fixture' });
  const client = vi.fn(() => { throw new Error('Destination must not be contacted'); });
  const service = new LocalTransferService({
    store: f.store,
    sessions: f.sessions,
    environments: {} as EnvironmentService,
    owner: 'operator',
    snapshot: async () => [],
    client: client as never,
  });
  await f.store.put({ ownerId: 'operator', collection: 'local_transfers', id, createdAt: 1, revision: 1,
    value: {
      plan: { id, source_session_id: 'sess_source', destination: { baseURL: 'https://fixture.example/v1', region: 'us-west-2' },
        status: 'ready', files: 1, bytes: 1, history_items: 0, uploaded_parts: 0, total_parts: 1,
        destination_session_id: null, error: null, source_model: 'test', model: 'test' },
      snapshot: { request: legacyLocation === 'snapshot.request' ? legacyRequest : safeRequest, archive: Buffer.from('archive').toString('base64'), sha256: '0'.repeat(64) },
      fileIds: [],
      ...(legacyLocation === 'importRequest' ? { importRequest: legacyRequest } : {}),
    },
  }, 0);

  try {
    await service.execute(id);
    await expect.poll(async () => service.retrieve(id)).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('local environment values'),
    });
    expect(client).not.toHaveBeenCalled();
  } finally { await service.close(); }
});
