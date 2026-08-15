import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  defaultPublicationBuilders,
  PublicationBuilderRegistry,
  PublicationService,
} from '../../src/core/publication-service.js';
import type {
  PublicationBuilder,
  PublicationObjectStore,
  PublicationSourceFile,
} from '../../src/core/publication-service.js';
import type { BlobReference, PublicationManifest } from '../../src/domain/publications.js';

class MemoryPublicationStore implements PublicationObjectStore {
  public readonly operations: string[] = [];
  public readonly generated = new Map<string, Uint8Array>();
  public manifest?: PublicationManifest;

  public async stageBlob(input: {
    ownerId: string;
    publicationId: string;
    path: string;
    source: BlobReference;
  }): Promise<BlobReference> {
    this.operations.push(`copy:${input.path}`);
    return { ...input.source, id: `publication/${input.publicationId}/${input.path}` };
  }

  public async stageBytes(input: {
    ownerId: string;
    publicationId: string;
    path: string;
    bytes: Uint8Array;
    mediaType: string;
  }): Promise<BlobReference> {
    this.operations.push(`put:${input.path}`);
    this.generated.set(input.path, Uint8Array.from(input.bytes));
    return blob(`publication/${input.publicationId}/${input.path}`, input.bytes, input.mediaType);
  }

  public async commit(input: {
    ownerId: string;
    manifest: PublicationManifest;
  }): Promise<BlobReference> {
    this.operations.push('commit:_rat/manifest.json');
    this.manifest = input.manifest;
    return blob(
      `publication/${input.manifest.publicationId}/_rat/manifest.json`,
      Buffer.from(JSON.stringify(input.manifest)),
      'application/json',
    );
  }
}

describe('publication service', () => {
  it('turns a file into an immutable viewer bundle and commits the manifest last', async () => {
    const store = new MemoryPublicationStore();
    const service = new PublicationService(store);
    const source = sourceFile('images/demo.webp', 'image/webp');
    const result = await service.publish({
      ownerId: 'owner-1',
      publicationId: 'a'.repeat(24),
      spec: { version: '1', kind: 'file', path: source.path, title: 'Demo image' },
      files: [source],
      runId: 'run-1',
      createdAt: '2026-08-15T00:00:00.000Z',
    });

    expect(store.operations).toEqual([
      'put:index.html',
      'copy:assets/demo.webp',
      'commit:_rat/manifest.json',
    ]);
    expect(Buffer.from(store.generated.get('index.html')!).toString('utf8')).toContain('<img');
    expect(result.manifest).toEqual(expect.objectContaining({
      kind: 'file',
      entrypoint: 'index.html',
      primaryPath: 'assets/demo.webp',
      provenance: expect.objectContaining({ builder: 'rat-things/file@1' }),
    }));
  });

  it('preserves a static site tree relative to its declared root', async () => {
    const store = new MemoryPublicationStore();
    const service = new PublicationService(store);
    const result = await service.publish({
      ownerId: 'owner-1',
      publicationId: 'b'.repeat(24),
      spec: { version: '1', kind: 'site', root: 'dist' },
      files: [
        sourceFile('dist/index.html', 'text/html; charset=utf-8'),
        sourceFile('dist/assets/app.js', 'text/javascript; charset=utf-8'),
        sourceFile('notes/private.txt', 'text/plain; charset=utf-8'),
      ],
      runId: 'run-1',
    });

    expect(result.manifest.files.map((file) => file.path)).toEqual(['assets/app.js', 'index.html']);
    expect(store.operations.at(-1)).toBe('commit:_rat/manifest.json');
  });

  it('builds a video player and rejects missing or incorrectly typed inputs', async () => {
    const store = new MemoryPublicationStore();
    const service = new PublicationService(store);
    await expect(service.publish({
      ownerId: 'owner-1',
      publicationId: 'c'.repeat(24),
      spec: { version: '1', kind: 'video', path: 'movie.mp4', poster: 'poster.webp' },
      files: [sourceFile('movie.mp4', 'video/mp4'), sourceFile('poster.webp', 'image/webp')],
      runId: 'run-1',
    })).resolves.toEqual(expect.objectContaining({
      manifest: expect.objectContaining({ kind: 'video', primaryPath: 'assets/movie.mp4' }),
    }));
    expect(Buffer.from(store.generated.get('index.html')!).toString('utf8')).toContain('<video');

    await expect(service.publish({
      ownerId: 'owner-1',
      publicationId: 'd'.repeat(24),
      spec: { version: '1', kind: 'video', path: 'notes.txt' },
      files: [sourceFile('notes.txt', 'text/plain')],
      runId: 'run-1',
    })).rejects.toMatchObject({ code: 'unsupported_media' });
  });

  it('rejects duplicate builder kinds', () => {
    const builder = defaultPublicationBuilders().get('file');
    expect(() => new PublicationBuilderRegistry([
      builder,
      { ...builder } as PublicationBuilder,
    ])).toThrow('duplicate publication builder');
  });

  it('returns a stable storage error without committing a partial publication', async () => {
    const store = new MemoryPublicationStore();
    store.stageBlob = async () => { throw new Error('S3 unavailable'); };
    await expect(new PublicationService(store).publish({
      ownerId: 'owner-1',
      publicationId: 'e'.repeat(24),
      spec: { version: '1', kind: 'file', path: 'demo.png' },
      files: [sourceFile('demo.png', 'image/png')],
      runId: 'run-1',
    })).rejects.toMatchObject({ code: 'storage' });
    expect(store.manifest).toBeUndefined();
  });

  it('keeps the internal manifest namespace out of published site content', async () => {
    await expect(new PublicationService(new MemoryPublicationStore()).publish({
      ownerId: 'owner-1',
      publicationId: 'f'.repeat(24),
      spec: { version: '1', kind: 'site' },
      files: [
        sourceFile('index.html', 'text/html; charset=utf-8'),
        sourceFile('_rat/manifest.json', 'application/json'),
      ],
      runId: 'run-1',
    })).rejects.toMatchObject({ code: 'invalid_path' });
  });
});

function sourceFile(path: string, mediaType: string): PublicationSourceFile {
  return {
    path,
    blob: blob(`owners/owner/runs/run-1/${path}`, Buffer.from(path), mediaType),
  };
}

function blob(id: string, bytes: Uint8Array, mediaType: string): BlobReference {
  return {
    id,
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    size: bytes.byteLength,
    mediaType,
  };
}
