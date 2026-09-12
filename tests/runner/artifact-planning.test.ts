import { describe, expect, it } from 'vitest';
import { artifactIdForPath, MAX_ARTIFACT_FILE_BYTES, MAX_ARTIFACT_TOTAL_BYTES } from '../../src/domain/artifacts.js';
import type { ArtifactCatalog, PublishedArtifact } from '../../src/domain/contracts.js';
import {
  artifactByteTotal, artifactFileIdentity, artifactOwnerHash, artifactPromptText,
  assertArtifactCatalogScope, completeArtifactPublication, detectMediaType,
  emptyArtifactCatalog, planArtifactPublication,
} from '../../src/runner/artifact-planning.js';

function previousFile(): PublishedArtifact {
  return {
    id: artifactIdForPath('report.txt'), path: 'report.txt', bytes: 12, mediaType: 'application/custom',
    createdAt: '2026-08-14T12:00:00.000Z', sourceRunId: 'old-run',
    file: { bucket: 'artifacts', key: 'previous/report.txt', sha256: 'a'.repeat(64) },
  };
}

function observation() {
  return { ownerHash: 'b'.repeat(32), path: 'report.txt', bytes: 12, digest: 'a'.repeat(64), mediaType: 'text/plain' };
}

describe('artifact publication planning', () => {
  it('prioritizes the unchanged file over another reusable blob and preserves its metadata', () => {
    const previous = previousFile();
    Object.freeze(previous.file);
    Object.freeze(previous);
    const reusable = { ...previous.file, key: 'other-copy' };
    const plan = planArtifactPublication({ ...observation(), previous, reusable });
    const stored = { ...previous.file, key: plan.key };
    const result = completeArtifactPublication(plan, stored, 'new-run', '2026-08-15T12:00:00.000Z');

    expect(plan).toMatchObject({ kind: 'unchanged', source: previous.file });
    expect(result).toEqual({ ...previous, file: stored });
    expect(result).not.toBe(previous);
    expect(result.file).toBe(stored);
    expect(previous.file.key).toBe('previous/report.txt');
  });

  it('reuses matching bytes at a changed path but assigns current metadata', () => {
    const previous = previousFile();
    const plan = planArtifactPublication({ ...observation(), path: 'new.json', mediaType: 'application/json', reusable: previous.file });
    const stored = { ...previous.file, key: plan.key };

    expect(plan.kind).toBe('copy');
    expect(completeArtifactPublication(plan, stored, 'new-run', '')).toEqual({
      id: artifactIdForPath('new.json'), path: 'new.json', bytes: 12, mediaType: 'application/json',
      sourceRunId: 'new-run', createdAt: '', file: stored,
    });
  });

  it('requires both size and checksum equality before retaining provenance', () => {
    const previous = previousFile();
    expect(planArtifactPublication({ ...observation(), bytes: 11, previous, reusable: previous.file }).kind).toBe('copy');
    expect(planArtifactPublication({ ...observation(), digest: 'c'.repeat(64), previous }).kind).toBe('upload');
    expect(planArtifactPublication({ ...observation(), previous }).kind).toBe('unchanged');
  });

  it('plans an upload with a content-based key and retains an empty file size', () => {
    const plan = planArtifactPublication({ ...observation(), bytes: 0 });
    expect(plan).toEqual({
      path: 'report.txt', bytes: 0, digest: 'a'.repeat(64), mediaType: 'text/plain',
      id: artifactIdForPath('report.txt'), kind: 'upload',
      key: `owners/${'b'.repeat(32)}/blobs/sha256/${'a'.repeat(64)}`,
    });
    const result = completeArtifactPublication(plan, { bucket: 'artifacts', key: plan.key, sha256: plan.digest }, 'run-1', '');
    expect(result.bytes).toBe(0);
  });

  it('verifies the persisted checksum for every storage decision before building its entry', () => {
    const previous = previousFile();
    for (const plan of [
      planArtifactPublication(observation()),
      planArtifactPublication({ ...observation(), reusable: previous.file }),
      planArtifactPublication({ ...observation(), previous }),
    ]) {
      expect(() => completeArtifactPublication(plan, { ...previous.file, sha256: 'f'.repeat(64) }, 'run-1', ''))
        .toThrow('artifact report.txt changed while it was being published');
    }
  });
});

describe('artifact observations and scope', () => {
  it('validates regular files and link counts before size or cumulative limits', () => {
    const oversized = { regular: false, links: 2, size: MAX_ARTIFACT_FILE_BYTES + 1 };
    expect(() => artifactByteTotal('file.txt', oversized, MAX_ARTIFACT_TOTAL_BYTES)).toThrow('not a regular file');
    expect(() => artifactByteTotal('file.txt', { ...oversized, regular: true }, MAX_ARTIFACT_TOTAL_BYTES)).toThrow('cannot be a hard link');
    expect(() => artifactByteTotal('file.txt', { ...oversized, regular: true, links: 1 }, MAX_ARTIFACT_TOTAL_BYTES))
      .toThrow(`artifact file.txt exceeds ${MAX_ARTIFACT_FILE_BYTES} bytes`);
  });

  it('accepts exact size limits and calculates a new total without mutating observations', () => {
    const file = Object.freeze({ regular: true, links: 1, size: MAX_ARTIFACT_FILE_BYTES });
    expect(artifactByteTotal('file.txt', file, MAX_ARTIFACT_TOTAL_BYTES - file.size)).toBe(MAX_ARTIFACT_TOTAL_BYTES);
    expect(artifactByteTotal('empty.txt', { ...file, size: 0 }, 0)).toBe(0);
    expect(() => artifactByteTotal('file.txt', file, MAX_ARTIFACT_TOTAL_BYTES - file.size + 1))
      .toThrow(`artifact directory exceeds ${MAX_ARTIFACT_TOTAL_BYTES} bytes`);
  });

  it('validates the catalog before owner scope and accepts only the configured bucket and owner prefix', () => {
    const previous = previousFile();
    const ownerHash = artifactOwnerHash('owner-1');
    previous.file.key = `owners/${ownerHash}/blobs/sha256/${previous.file.sha256}`;
    const catalog: ArtifactCatalog = { version: '1', files: [previous] };
    expect(() => assertArtifactCatalogScope(catalog, 'artifacts', 'owner-1')).not.toThrow();
    expect(() => assertArtifactCatalogScope(catalog, 'other-bucket', 'owner-1')).toThrow('outside its owner scope');
    previous.bytes = -1;
    expect(() => assertArtifactCatalogScope(catalog, 'artifacts', 'other-owner')).toThrow('invalid size');
  });
});

describe('artifact content values', () => {
  it('prioritizes content signatures over misleading extensions without changing the sample', () => {
    const sample = Buffer.from('%PDF-sample');
    const before = Buffer.from(sample);
    expect(detectMediaType(sample, 'misleading.png')).toBe('application/pdf');
    expect(sample).toEqual(before);
    expect(detectMediaType(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), 'image.txt')).toBe('image/png');
  });

  it.each([
    ['asset.avif', 'avif', 'image/avif'],
    ['asset.M4A', 'isom', 'audio/mp4'],
    ['asset.mov', 'isom', 'video/quicktime'],
    ['asset.bin', 'isom', 'video/mp4'],
  ])('uses the container brand and extension for %s', (path, brand, expected) => {
    expect(detectMediaType(Buffer.concat([Buffer.alloc(4), Buffer.from(`ftyp${brand}`)]), path)).toBe(expected);
  });

  it('rejects text classification for NUL samples and preserves empty-file extension detection', () => {
    expect(detectMediaType(Buffer.from([0]), 'index.html')).toBe('application/octet-stream');
    expect(detectMediaType(new Uint8Array(), 'index.HTML')).toBe('text/html; charset=utf-8');
    expect(detectMediaType(Buffer.from([0]), 'module.wasm')).toBe('application/wasm');
    expect(detectMediaType(Buffer.from('OggS'), 'movie.ogv')).toBe('video/ogg');
    expect(detectMediaType(Buffer.from('OggS'), 'audio.bin')).toBe('audio/ogg');
    expect(detectMediaType(Buffer.from('unknown'), 'unknown.bin')).toBe('application/octet-stream');
  });

  it('builds prompts from the supplied sharing flag while preserving empty and whitespace requests', () => {
    expect(artifactPromptText('', false)).toMatch(/User request:\n\n$/);
    expect(artifactPromptText('  request\n', true)).toMatch(/User request:\n\n  request\n$/);
    expect(artifactPromptText('request', false)).not.toContain('share.json');
    expect(artifactPromptText('request', true)).toContain('Never invent or guess a share URL');
    const first = emptyArtifactCatalog();
    first.files.push(previousFile());
    expect(emptyArtifactCatalog().files).toEqual([]);
  });

  it('parses explicit file-ownership settings with the existing numeric coercion rules', () => {
    expect(artifactFileIdentity(undefined, undefined)).toBeUndefined();
    expect(artifactFileIdentity('', '')).toBeUndefined();
    expect(artifactFileIdentity('0x64', ' 101 ')).toEqual({ uid: 100, gid: 101 });
    for (const [uid, gid] of [['0', '1'], ['1', ''], ['1.5', '2'], ['invalid', '2'], ['1', undefined]]) {
      expect(() => artifactFileIdentity(uid, gid)).toThrow('must both be positive integers');
    }
  });
});
