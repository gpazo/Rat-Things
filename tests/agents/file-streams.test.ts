import { describe, expect, it, vi } from 'vitest';
import { FileService } from '../../src/core/file-service.js';
import { MemoryAgentsStore } from './fixtures.js';
import { MemoryArtifacts } from '../runner/artifact-fixtures.js';

describe('streamed file uploads', () => {
  it('persists the same bytes and metadata across chunk boundaries', async () => {
    const artifacts = new MemoryArtifacts();
    const service = new FileService({ store: new MemoryAgentsStore(), artifacts });
    const file = await service.create('alice', { filename: 'binary.bin', purpose: 'user_data', data: {
      byteLength: 4, chunks: chunks([0, 255], [], [128, 1]),
    } });
    expect(file.bytes).toBe(4);
    expect(await service.bytes('alice', file.id)).toEqual(Uint8Array.from([0, 255, 128, 1]));
    await expect(service.retrieve('bob', file.id)).rejects.toMatchObject({ status: 404 });
  });

  it.each([1, 3])('does not publish a file whose stream differs from its declared %i bytes', async byteLength => {
    const store = new MemoryAgentsStore();
    const artifacts = new MemoryArtifacts();
    const service = new FileService({ store, artifacts });
    await expect(service.create('alice', { filename: 'binary.bin', purpose: 'user_data', data: {
      byteLength, chunks: chunks([0, 255]),
    } })).rejects.toMatchObject({ status: 400 });
    expect(store.resources.size).toBe(0);
    expect(artifacts.values.size).toBe(0);
  });

  it('does not persist file metadata when the upload signal aborts during S3 streaming', async () => {
    const store = new MemoryAgentsStore();
    const artifacts = new MemoryArtifacts();
    const service = new FileService({ store, artifacts });
    const controller = new AbortController();
    vi.spyOn(artifacts, 'putStream').mockImplementation(async (_key, value, _contentType, signal) => {
      for await (const _chunk of value) controller.abort(new Error('client disconnected'));
      signal?.throwIfAborted();
      throw new Error('unreachable');
    });

    await expect(service.create('alice', { filename: 'binary.bin', purpose: 'user_data', data: {
      byteLength: 4, chunks: chunks([0, 255], [128, 1]),
    } }, controller.signal)).rejects.toThrow('client disconnected');
    expect(store.resources.size).toBe(0);
  });
});

async function* chunks(...parts: number[][]) { for (const part of parts) yield Uint8Array.from(part); }
