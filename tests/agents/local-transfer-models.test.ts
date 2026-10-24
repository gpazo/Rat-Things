import { afterEach, expect, it, vi } from 'vitest';
import { LocalTransferService } from '../../src/app/local-transfer.js';
import { EnvironmentService } from '../../src/core/environment-service.js';
import { EnvironmentTemplateService } from '../../src/core/environment-template-service.js';
import { integrationFixture } from './integration-fixtures.js';

const target = { endpoint: 'https://fixture.example', region: 'us-west-2' };
const catalog = { object: 'list', data: [{ object: 'model', id: 'cloud-model' }], default_model: 'cloud-model' };
async function fixture(transport: typeof fetch) {
  const f = await integrationFixture();
  const environments = new EnvironmentService({ store: f.store, templates: new EnvironmentTemplateService({ store: f.store }),
    credentials: { create: async () => { throw new Error('unused'); }, read: async () => { throw new Error('unused'); }, revoke: async () => {} } });
  const snapshot = vi.fn(async () => []);
  const modelsFetch = vi.fn(() => transport);
  const put = vi.spyOn(f.store, 'put');
  const service = new LocalTransferService({ store: f.store, sessions: f.sessions, environments, owner: 'operator', snapshot, modelsFetch });
  return { service, snapshot, modelsFetch, put, store: f.store };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('discovers only the fixed destination model route without a Session, snapshot or saved plan', async () => {
  const transport = vi.fn<typeof fetch>(async () => Response.json(catalog));
  const f = await fixture(transport);
  expect(await f.service.models(target)).toEqual({ destination: { baseURL: 'https://fixture.example/v1', region: 'us-west-2' }, models: catalog });
  expect(f.modelsFetch).toHaveBeenCalledExactlyOnceWith({ baseURL: 'https://fixture.example/v1', region: 'us-west-2' });
  expect(transport).toHaveBeenCalledExactlyOnceWith('https://fixture.example/v1/models', {
    method: 'GET', redirect: 'error', signal: expect.any(AbortSignal),
  });
  expect(f.snapshot).not.toHaveBeenCalled();
  expect(f.put).not.toHaveBeenCalled();
  for (const input of [null, [], {}, { ...target, endpoint: 'malformed' }, { ...target, endpoint: 'http://fixture.example' },
    { ...target, endpoint: 'https://user:password@fixture.example' }, { ...target, endpoint: 'https://fixture.example/v1?x=1' },
    { ...target, endpoint: 'https://fixture.example/v1#fragment' }, { ...target, endpoint: 'https://fixture.example/other' },
    { ...target, region: 'invalid' }, { ...target, session_id: 'unexpected' }]) {
    await expect(f.service.models(input)).rejects.toMatchObject({ status: 400 });
  }
  expect(transport).toHaveBeenCalledOnce();
});

it.each([undefined, '1', String(2 * 1024 * 1024)])('bounds catalog bytes even with content-length %s', async length => {
  let reads = 0;
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { reads++; controller.enqueue(new Uint8Array(600 * 1024)); }, cancel,
  }, { highWaterMark: 0 });
  const f = await fixture(async () => new Response(stream, { headers: length === undefined ? {} : { 'content-length': length } }));
  await expect(f.service.models(target)).rejects.toMatchObject({ status: 502, code: 'destination_catalog_unavailable' });
  expect(reads).toBe(length === String(2 * 1024 * 1024) ? 0 : 2);
  expect(cancel).toHaveBeenCalledOnce();
});

it('cancels error bodies and sanitizes invalid JSON, UTF-8, catalogs and transport errors', async () => {
  const cancel = vi.fn();
  const error = new Response(new ReadableStream({ pull() { throw new Error('must not consume'); }, cancel }, { highWaterMark: 0 }), { status: 403 });
  for (const transport of [async () => error, async () => new Response('{private malformed'),
    async () => new Response(new Uint8Array([0xff])), async () => Response.json({ ...catalog, default_model: 'absent' }),
    async () => { throw new Error('private AWS credential diagnostic'); }]) {
    const f = await fixture(transport);
    await expect(f.service.models(target)).rejects.toMatchObject({ status: 502, code: 'destination_catalog_unavailable',
      message: 'The destination model catalog is unavailable. Check the endpoint, region and AWS identity, then try again.' });
  }
  expect(cancel).toHaveBeenCalledOnce();
});

it('bounds the whole lookup, including an authentication step that ignores its signal', async () => {
  const f = await fixture(async () => new Promise<Response>(() => {}));
  vi.useFakeTimers();
  const operation = f.service.models(target);
  const failure = expect(operation).rejects.toMatchObject({ status: 502, code: 'destination_catalog_unavailable' });
  await vi.advanceTimersByTimeAsync(20_000);
  await failure;
});

it('aborts a stalled response body at the same lookup deadline', async () => {
  let signal: AbortSignal | undefined;
  const f = await fixture(async (_input, init) => {
    signal = init?.signal ?? undefined;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { signal?.addEventListener('abort', () => controller.error(new Error('Aborted body')), { once: true }); },
    }));
  });
  vi.useFakeTimers();
  const operation = f.service.models(target);
  const failure = expect(operation).rejects.toMatchObject({ status: 502, code: 'destination_catalog_unavailable' });
  await vi.advanceTimersByTimeAsync(20_000);
  await failure;
  expect(signal?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it('rediscovers bounded owner-specific saved copies with the same interrupted view and no execution', async () => {
  const transport = vi.fn<typeof fetch>(async () => { throw new Error('Listing cannot contact the destination'); });
  const f = await fixture(transport);
  const ids = [1, 2, 3].map(value => `${String(value).padStart(8, '0')}-0000-4000-8000-000000000000`);
  for (const [index, id] of ids.entries()) {
    await f.store.put({ ownerId: 'operator', collection: 'local_transfers', id, createdAt: index, revision: 1, value: {
      plan: { id, source_session_id: 'sess_source', destination: { baseURL: 'https://fixture.example/v1', region: 'us-west-2' },
        status: index === 0 ? 'ready' : index === 1 ? 'importing' : 'complete', files: 1, bytes: 42,
        history_items: 2, uploaded_parts: index === 0 ? 0 : 1, total_parts: 1,
        destination_session_id: index === 2 ? 'sess_cloud' : null, error: null, source_model: 'local-model', model: 'cloud-model', private: 'discard' },
      snapshot: { private: 'snapshot' }, fileIds: ['private-file'], importRequest: { private: 'import' },
    } }, 0);
  }
  await f.store.put({ ownerId: 'another-owner', collection: 'local_transfers', id: 'private', createdAt: 100, revision: 1, value: { private: true } }, 0);
  f.put.mockClear();
  const first = await f.service.list({ limit: 2 });
  expect(first).toMatchObject({ object: 'list', has_more: true, last_id: ids[1], data: [{ id: ids[2], status: 'complete' },
    { id: ids[1], status: 'failed', destination_session_id: null, model: 'cloud-model',
      error: 'Transfer interrupted. Retry to resume from the saved snapshot.' }] });
  expect(first.data[1]).toEqual(await f.service.retrieve(ids[1]!));
  expect(JSON.stringify(first)).not.toMatch(/private|snapshot"|fileIds|importRequest/);
  const next = await f.service.list({ after: first.last_id, limit: 2 });
  expect(next).toMatchObject({ has_more: false, last_id: ids[0], data: [{ id: ids[0], status: 'ready' }] });
  for (const query of [null, [], { limit: 0 }, { limit: 21 }, { limit: 1.5 }, { limit: '2' }, { after: 'invalid' }, { owner: 'another-owner' }]) {
    await expect(f.service.list(query)).rejects.toMatchObject({ status: 400 });
  }
  expect(f.put).not.toHaveBeenCalled();
  expect(f.snapshot).not.toHaveBeenCalled();
  expect(transport).not.toHaveBeenCalled();
});
