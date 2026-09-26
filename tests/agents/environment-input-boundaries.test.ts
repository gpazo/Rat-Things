import { expect, it, vi } from 'vitest';
import { EnvironmentService } from '../../src/core/environment-service.js';
import { EnvironmentTemplateService } from '../../src/core/environment-template-service.js';
import type { EnvironmentParam } from '../../src/domain/agents-api.js';
import { MemoryAgentsStore } from './fixtures.js';

const mib = 1024 * 1024;
const inline = (path: string, bytes: number) => ({ type: 'inline' as const, path, data: Buffer.alloc(bytes).toString('base64') });
function fixture(uploadBytes = 0) {
  const store = new MemoryAgentsStore();
  const put = vi.spyOn(store, 'put');
  const reference = vi.fn(async () => ({ bucket: 'private', key: 'owned-input', sha256: 'fixture', bytes: uploadBytes, contentType: 'application/octet-stream' }));
  const service = new EnvironmentService({ store, templates: new EnvironmentTemplateService({ store }),
    credentials: { create: async () => 'unused', read: async () => ({ harness: '', executor: '' }), revoke: async () => {} },
    managedFiles: async () => [], uploadedFiles: { reference, retrieve: async () => ({ id: 'file_input', object: 'file', purpose: 'user_data',
      filename: 'input.bin', bytes: uploadBytes, status: 'processed', created_at: 1 }) },
  });
  const prepare = (files: NonNullable<Extract<EnvironmentParam, { type: 'openai_hosted' }>['files']>) => service.prepare('alice', 'session', { type: 'openai_hosted', files });
  return { prepare, put, reference };
}

it('admits 50 files including two exact 5 MiB inline inputs without changing their bytes', async () => {
  const { prepare, put } = fixture();
  const files = [inline('/workspace/a', 5 * mib), inline('/workspace/b', 5 * mib),
    ...Array.from({ length: 48 }, (_, i) => inline(`/workspace/empty-${i}`, 0))];
  const environment = await prepare(files);
  if (environment.type !== 'openai_hosted') throw new Error('Expected hosted environment');
  expect(environment.files).toHaveLength(50);
  expect(environment.files.slice(0, 2)).toEqual(files.slice(0, 2).map(file => expect.objectContaining({ path: file.path, size_bytes: 5 * mib })));
  expect(put).toHaveBeenCalledTimes(1);
  expect(put.mock.calls[0]?.[0].value).toMatchObject({ configuration: { files } });
});

it.each(['count', 'per-file', 'aggregate'] as const)('rejects an inline %s limit overflow before storing the environment', async mode => {
  const { prepare, put } = fixture();
  const files = mode === 'count' ? Array.from({ length: 51 }, (_, i) => inline(`/workspace/${i}`, 0))
    : mode === 'per-file' ? [inline('/workspace/a', 5 * mib + 1)]
    : [inline('/workspace/a', 5 * mib), inline('/workspace/b', 5 * mib), inline('/workspace/c', 1)];
  await expect(prepare(files)).rejects.toMatchObject({ status: 400 });
  expect(put).not.toHaveBeenCalled();
});

it.each([50 * mib, 50 * mib + 1])('enforces the Files API copy boundary at %i bytes', async bytes => {
  const { prepare, put, reference } = fixture(bytes);
  const result = prepare([{ type: 'file_id', file_id: 'file_input', path: '/workspace/input.bin' }]);
  if (bytes === 50 * mib) {
    await expect(result).resolves.toMatchObject({ files: [expect.objectContaining({ file_id: 'file_input', size_bytes: bytes })] });
    expect(reference).toHaveBeenCalledWith('alice', 'file_input');
    expect(put).toHaveBeenCalledTimes(1);
  } else {
    await expect(result).rejects.toMatchObject({ status: 400 });
    expect(reference).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  }
});

it.each(['A', 'AA', 'A===', '====', 'AA=A', 'AA==AA==', 'AA-_', 'AA==\n', 'AB==', 'AAB='])('rejects noncanonical base64 %j without storing an environment', async data => {
  const { prepare, put } = fixture();
  await expect(prepare([{ type: 'inline', path: '/workspace/input.bin', data }])).rejects.toMatchObject({ status: 400 });
  expect(put).not.toHaveBeenCalled();
});
