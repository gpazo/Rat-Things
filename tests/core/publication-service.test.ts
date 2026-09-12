import { describe, expect, it, vi } from 'vitest';
import { blob, sourceFile } from './publication-fixtures.js';
import {
  defaultPublicationBuilders,
  PublicationBuilderRegistry,
  PublicationService,
} from '../../src/core/publication-service.js';
import type {
  PublicationBuilder,
  PublicationObjectStore,
  PublishInput,
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
    const viewer = Buffer.from(store.generated.get('index.html')!).toString('utf8');
    expect(viewer).toContain('<img data-publication-src="assets/demo.webp"');
    expect(viewer).toContain("const names=['Policy','Signature','Key-Pair-Id']");
    expect(result.manifest).toEqual(expect.objectContaining({
      kind: 'file',
      entrypoint: 'index.html',
      primaryPath: 'assets/demo.webp',
      provenance: expect.objectContaining({ builder: 'rat-things/file@2' }),
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
    const viewer = Buffer.from(store.generated.get('index.html')!).toString('utf8');
    expect(viewer).toContain('<video data-publication-src="assets/movie.mp4"');
    expect(viewer).toContain('data-publication-poster="assets/poster.webp"');
    expect(viewer).toContain("const names=['Policy','Signature','Key-Pair-Id']");

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

  it('validates every input blob before looking up a committed publication', async () => {
    const getCommitted = vi.fn(async () => undefined);
    const store = Object.assign(new MemoryPublicationStore(), { getCommitted });
    const input = fileInput();
    input.files = [...input.files, { path: 'unused.txt', blob: { ...input.files[0]!.blob, size: -1 } }];

    await expect(new PublicationService(store).publish(input)).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(getCommitted).not.toHaveBeenCalled();
    expect(store.operations).toEqual([]);
  });

  it('returns the committed object without planning or staging again', async () => {
    const store = new MemoryPublicationStore();
    const committed = await new PublicationService(store).publish(fileInput());
    const getCommitted = vi.fn(async () => committed);
    const builder = defaultPublicationBuilders().get('file');
    const plan = vi.spyOn(builder, 'plan');
    const now = vi.fn(() => new Date());
    const service = new PublicationService(
      Object.assign(store, { getCommitted }),
      new PublicationBuilderRegistry([builder]),
      { now },
    );
    store.operations.length = 0;

    const input = fileInput();
    delete input.createdAt;
    expect(await service.publish(input)).toBe(committed);
    expect(plan).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    expect(store.operations).toEqual([]);
  });

  it('wraps an invalid committed manifest as a storage read failure', async () => {
    const store = new MemoryPublicationStore();
    const committed = await new PublicationService(store).publish(fileInput());
    committed.manifest.provenance.runId = '';
    const getCommitted = async () => committed;
    store.operations.length = 0;

    await expect(new PublicationService(Object.assign(store, { getCommitted })).publish(fileInput()))
      .rejects.toMatchObject({
        code: 'storage',
        message: 'could not read committed publication',
        cause: expect.objectContaining({ code: 'invalid_request' }),
      });
    expect(store.operations).toEqual([]);
  });

  it('validates the entire plan before staging its first file', async () => {
    const store = new MemoryPublicationStore();
    const input = fileInput();
    const builder: PublicationBuilder = {
      kind: 'file',
      name: 'custom',
      plan: async () => ({
        ok: true,
        value: {
          kind: 'file',
          entrypoint: 'index.html',
          files: [
            { source: 'generated', path: 'index.html', bytes: Buffer.from('ready'), mediaType: 'text/html' },
            { source: 'blob', path: 'unknown.txt', blob: sourceFile('unknown.txt', 'text/plain').blob },
          ],
        },
      }),
    };

    await expect(new PublicationService(store, new PublicationBuilderRegistry([builder])).publish(input))
      .rejects.toMatchObject({ code: 'invalid_request', message: 'publication builder selected an unknown source blob' });
    expect(store.operations).toEqual([]);
  });

  it('keeps earlier staged files when a later write fails and preserves its cause', async () => {
    const store = new MemoryPublicationStore();
    const cause = new Error('copy failed');
    store.stageBlob = async ({ path }) => {
      store.operations.push(`copy:${path}`);
      throw cause;
    };

    await expect(new PublicationService(store).publish(fileInput())).rejects.toMatchObject({
      code: 'storage', message: 'could not stage publication path assets/demo.png', cause,
    });
    expect(store.operations).toEqual(['put:index.html', 'copy:assets/demo.png']);
    expect(store.generated.has('index.html')).toBe(true);
    expect(store.manifest).toBeUndefined();
  });

  it('validates provenance after staging and retains an explicitly empty timestamp', async () => {
    const store = new MemoryPublicationStore();

    await expect(new PublicationService(store).publish({ ...fileInput(), createdAt: '' }))
      .rejects.toMatchObject({ code: 'invalid_request', message: 'publication provenance is invalid' });
    expect(store.operations).toEqual(['put:index.html', 'copy:assets/demo.png']);
    expect(store.manifest).toBeUndefined();
  });

  it('preserves the diagnostic list and fallback error for an empty failed plan', async () => {
    const store = new MemoryPublicationStore();
    const builder: PublicationBuilder = {
      kind: 'file', name: 'custom', plan: async () => ({ ok: false, error: [] }),
    };

    await expect(new PublicationService(store, new PublicationBuilderRegistry([builder])).publish(fileInput()))
      .rejects.toMatchObject({
        code: 'invalid_request', message: 'publication could not be planned', diagnostics: [],
      });
    expect(store.operations).toEqual([]);
  });

  it('reads time once after staging, and skips the clock when createdAt is supplied', async () => {
    const store = new MemoryPublicationStore();
    const now = vi.fn(() => {
      store.operations.push('clock');
      return new Date('2026-08-16T00:00:00.000Z');
    });
    const service = new PublicationService(store, defaultPublicationBuilders(), { now });
    const input = fileInput();
    delete input.createdAt;

    const result = await service.publish(input);
    expect(store.operations).toEqual(['put:index.html', 'copy:assets/demo.png', 'clock', 'commit:_rat/manifest.json']);
    expect(result.manifest.provenance.createdAt).toBe('2026-08-16T00:00:00.000Z');
    await service.publish(fileInput());
    expect(now).toHaveBeenCalledTimes(1);
  });

  it('does not read time when staging fails before the manifest is constructed', async () => {
    const store = new MemoryPublicationStore();
    store.stageBlob = async () => { throw new Error('copy failed'); };
    const now = vi.fn(() => new Date());
    const input = fileInput();
    delete input.createdAt;

    await expect(new PublicationService(store, defaultPublicationBuilders(), { now }).publish(input))
      .rejects.toMatchObject({ code: 'storage' });
    expect(now).not.toHaveBeenCalled();
  });
});

function fileInput(): PublishInput {
  return {
    ownerId: 'owner-1',
    publicationId: 'a'.repeat(24),
    spec: { version: '1', kind: 'file', path: 'demo.png' },
    files: [sourceFile('demo.png', 'image/png')],
    runId: 'run-1',
    createdAt: '2026-08-15T00:00:00.000Z',
  };
}
