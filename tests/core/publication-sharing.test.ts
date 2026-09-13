import { describe, expect, it } from 'vitest';
import {
  publicationDescriptor,
  publicationDomain,
  publicationGrant,
  publicationTtlSeconds,
  validatePublicationTokenSuffix,
} from '../../src/core/publication-sharing.js';
import type { PublicationManifest } from '../../src/domain/publications.js';
import { sourceFile } from './publication-fixtures.js';

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
