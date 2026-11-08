import { describe, expect, it } from 'vitest';
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
});

async function* chunks(...parts: number[][]) { for (const part of parts) yield Uint8Array.from(part); }
