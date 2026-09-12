import { describe, expect, it } from 'vitest';
import {
  latestPublicationSourceRunId,
  publicationCatalogPlan,
  publicationDescriptor,
  publicationDomain,
  publicationGrant,
  publicationTtlSeconds,
  relevantPublicationFiles,
  validatePublicationTokenSuffix,
} from '../../src/core/publication-sharing.js';
import type { PublicationManifest } from '../../src/domain/publications.js';
import { siteCatalog, sourceFile } from './publication-fixtures.js';

function catalogInput() {
  return {
    ownerId: 'owner-1', catalog: siteCatalog('owner-1', 'artifacts'), artifactBucket: 'artifacts',
    spec: { version: '1', kind: 'site', root: 'site' } as const,
  };
}

describe('publication catalog planning', () => {
  it('keeps identity independent of file order, unrelated files, storage location, and provenance', () => {
    const input = catalogInput();
    const first = publicationCatalogPlan(input);
    // Preserve the v3 identity of an existing publication, including canonical field order.
    expect(first.publicationId).toBe('aa91e41cf8c174bab77787fe');
    const catalog = siteCatalog('another-owner', 'artifacts');
    for (const file of catalog.files) {
      file.createdAt = '2026-08-16T00:00:00.000Z';
      file.sourceRunId = 'new-run';
      file.bytes = 0;
    }
    catalog.files[2]!.file.sha256 = 'a'.repeat(64);
    catalog.files.reverse();
    Object.freeze(catalog.files);
    const second = publicationCatalogPlan({
      ...input, ownerId: 'another-owner', catalog,
      spec: { ...input.spec, entrypoint: 'index.html', title: '' },
    });

    expect(second.publicationId).toBe(first.publicationId);
    expect(second.ownerHash).not.toBe(first.ownerHash);
    expect(second.createdAt).toBe('2026-08-16T00:00:00.000Z');
    expect(second.files.map((file) => file.path)).toEqual(['notes.txt', 'site/app.js', 'site/index.html']);
    expect(second.files[0]!.blob.size).toBe(0);
    expect(catalog.files[0]!.path).toBe('notes.txt');
  });

  it('changes identity when selected content, media type, or presentation changes', () => {
    const input = catalogInput();
    const original = publicationCatalogPlan(input).publicationId;
    const content = structuredClone(input);
    content.catalog.files[0]!.file.sha256 = 'a'.repeat(64);
    const media = structuredClone(input);
    media.catalog.files[0]!.mediaType = 'text/html';

    expect(publicationCatalogPlan(content).publicationId).not.toBe(original);
    expect(publicationCatalogPlan(media).publicationId).not.toBe(original);
    expect(publicationCatalogPlan({ ...input, spec: { ...input.spec, title: 'New title' } }).publicationId)
      .not.toBe(original);
  });

  it('accepts exact owner blob keys and rejects malformed blob keys or a different bucket', () => {
    const input = catalogInput();
    const { ownerHash } = publicationCatalogPlan(input);
    const file = input.catalog.files[0]!;
    file.file.key = `owners/${ownerHash}/blobs/sha256/${file.file.sha256}`;
    expect(publicationCatalogPlan(input).files[0]!.blob.id).toBe(file.file.key);
    file.file.key += '/extra';
    expect(() => publicationCatalogPlan(input)).toThrow('outside its owner scope');
    file.file.key = `owners/${ownerHash}/runs/run-1/content`;
    file.file.bucket = 'other-artifacts';
    expect(() => publicationCatalogPlan(input)).toThrow('outside its owner scope');
  });

  it('validates the whole catalog before checking owner scope', () => {
    const input = catalogInput();
    input.catalog.files[0]!.file.key = 'foreign/key';
    input.catalog.files[2]!.bytes = -1;
    expect(() => publicationCatalogPlan(input)).toThrow('invalid size');
  });

  it('preserves timestamp ordering and falls back to the epoch for no selected files', () => {
    const input = catalogInput();
    input.catalog.files[0]!.createdAt = '2026-08-15T13:00:00+02:00';
    input.catalog.files[1]!.createdAt = '2026-08-15T12:00:00Z';
    const before = structuredClone(input.catalog);

    expect(publicationCatalogPlan(input).createdAt).toBe('2026-08-15T13:00:00+02:00');
    expect(latestPublicationSourceRunId(input.catalog, input.spec)).toBe('run-1');
    const missing = { version: '1', kind: 'file', path: 'missing' } as const;
    expect(publicationCatalogPlan({ ...input, spec: missing }).createdAt).toBe('1970-01-01T00:00:00.000Z');
    expect(latestPublicationSourceRunId(input.catalog, missing)).toBe('conversation-publication');
    expect(input.catalog).toEqual(before);
  });

  it('selects paths into a new array with the original values and order', () => {
    const files = Object.freeze([{ path: 'poster.png' }, { path: 'siteish/index.html' }, { path: 'site/index.html' }, { path: 'movie.mp4' }]);
    const video = relevantPublicationFiles({ version: '1', kind: 'video', path: 'movie.mp4', poster: 'poster.png' }, files);
    expect(video).toEqual([files[0], files[3]]);
    expect(video[0]).toBe(files[0]);
    expect(relevantPublicationFiles({ version: '1', kind: 'site', root: 'site' }, files)).toEqual([files[2]]);
    const all = relevantPublicationFiles({ version: '1', kind: 'site', root: '' }, files);
    expect(all).toEqual(files);
    expect(all).not.toBe(files);
  });
});

describe('publication sharing values', () => {
  it.each([
    [undefined, 86_400], ['invalid', 86_400], [Infinity, 86_400],
    [0, 60], ['', 60], [-100, 60], [90.9, 90], [100_000, 86_400],
  ])('bounds TTL %s to %s seconds', (configured, expected) => {
    expect(publicationTtlSeconds(configured)).toBe(expected);
  });

  it('normalizes domain case and surrounding dots while rejecting invalid labels', () => {
    expect(publicationDomain('.Agent-Content.Example.')).toBe('agent-content.example');
    for (const value of ['localhost', 'bad..example', '-bad.example', ' example.com ']) {
      expect(() => publicationDomain(value)).toThrow('base domain is invalid');
    }
  });

  it('validates token format separately from time-dependent grant construction', () => {
    expect(() => validatePublicationTokenSuffix('a'.repeat(64))).not.toThrow();
    for (const token of ['', 'a'.repeat(63), 'A'.repeat(64), `${'a'.repeat(64)}\n`]) {
      expect(() => validatePublicationTokenSuffix(token)).toThrow('invalid token');
    }
  });

  it('constructs the grant and descriptor from explicit values without modifying the date or manifest', () => {
    const now = new Date('2026-08-15T12:00:00.000Z');
    const grant = publicationGrant({
      publicationId: 'a'.repeat(24), ownerHash: 'b'.repeat(32), tokenSuffix: 'c'.repeat(64), now, ttlSeconds: 60,
    });
    const manifest: PublicationManifest = {
      version: '1', publicationId: 'd'.repeat(24), kind: 'file', entrypoint: 'index.html', primaryPath: 'file.txt',
      files: [sourceFile('index.html', 'text/html'), sourceFile('file.txt', 'text/plain')],
      provenance: { runId: 'run-1', builder: 'custom', createdAt: '2026-08-14T12:00:00.000Z' },
    };
    Object.freeze(manifest.files);
    const result = publicationDescriptor(Object.freeze(manifest), Object.freeze(grant), 'content.example');

    expect(result).toEqual({
      publicationId: grant.publicationId, kind: 'file',
      url: `https://${grant.publicationId}-${grant.ownerHash}.content.example/__share/${grant.id}`,
      expiresAt: '2026-08-15T12:01:00.000Z', entrypoint: 'index.html', primaryPath: 'file.txt',
      paths: ['index.html', 'file.txt'],
    });
    expect(now.toISOString()).toBe('2026-08-15T12:00:00.000Z');
    expect(manifest.publicationId).toBe('d'.repeat(24));
  });
});
