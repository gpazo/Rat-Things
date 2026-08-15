import { describe, expect, it } from 'vitest';
import {
  parsePublicationSpec,
  validatePublicationManifest,
  validateShareGrant,
} from '../../src/domain/publications.js';

describe('publication contracts', () => {
  it('parses explicit file, site, and video requests', () => {
    expect(parsePublicationSpec({ version: '1', kind: 'file', path: 'images/demo.webp' })).toEqual({
      version: '1',
      kind: 'file',
      path: 'images/demo.webp',
    });
    expect(parsePublicationSpec({ version: '1', kind: 'site', root: 'site' })).toEqual({
      version: '1',
      kind: 'site',
      root: 'site',
    });
    expect(parsePublicationSpec({
      version: '1',
      kind: 'video',
      path: 'video/demo.mp4',
      poster: 'video/poster.webp',
      title: 'Demo',
    })).toEqual({
      version: '1',
      kind: 'video',
      path: 'video/demo.mp4',
      poster: 'video/poster.webp',
      title: 'Demo',
    });
  });

  it('rejects ambiguous fields and unsafe paths', () => {
    expect(() => parsePublicationSpec({
      version: '1',
      kind: 'site',
      root: 'site',
      path: 'index.html',
    })).toThrow('do not accept path');
    expect(() => parsePublicationSpec({
      version: '1',
      kind: 'file',
      path: '../secret',
    })).toThrow('path is invalid');
    expect(() => parsePublicationSpec({
      version: '1',
      kind: 'file',
      path: 'demo.png',
      extra: true,
    })).toThrow('unknown field extra');
  });

  it('validates immutable manifests and share grants', () => {
    const blob = {
      id: 'opaque-blob',
      digest: `sha256:${'a'.repeat(64)}` as const,
      size: 12,
      mediaType: 'text/html; charset=utf-8',
    };
    expect(() => validatePublicationManifest({
      version: '1',
      publicationId: 'a'.repeat(24),
      kind: 'site',
      entrypoint: 'index.html',
      files: [{ path: 'index.html', blob }],
      provenance: {
        runId: 'run-1',
        builder: 'test@1',
        createdAt: '2026-08-15T00:00:00.000Z',
      },
    })).not.toThrow();
    expect(() => validateShareGrant({
      version: '1',
      id: 'share-1',
      publicationId: 'a'.repeat(24),
      ownerHash: 'b'.repeat(32),
      access: 'bearer',
      expiresAt: '2026-08-16T00:00:00.000Z',
    })).not.toThrow();
  });
});
