import { createHash } from 'node:crypto';
import type { PublicationSourceFile } from '../../src/core/publication-service.js';
import type { ArtifactCatalog } from '../../src/domain/contracts.js';
import type { BlobReference } from '../../src/domain/publications.js';

export function sourceFile(path: string, mediaType: string): PublicationSourceFile {
  return {
    path,
    blob: blob(`owners/owner/runs/run-1/${path}`, Buffer.from(path), mediaType),
  };
}

export function blob(id: string, bytes: Uint8Array, mediaType: string): BlobReference {
  return {
    id,
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    size: bytes.byteLength,
    mediaType,
  };
}

export function siteCatalog(ownerId: string, bucket: string): ArtifactCatalog {
  const ownerHash = createHash('sha256').update(ownerId).digest('hex').slice(0, 32);
  return {
    version: '1',
    files: [
      artifact('site/index.html', 'run-1', '2026-08-15T11:00:00.000Z'),
      artifact('site/app.js', 'run-2', '2026-08-15T11:30:00.000Z'),
      artifact('notes.txt', 'run-3', '2026-08-15T11:45:00.000Z'),
    ].map((value) => ({
      ...value,
      file: {
        ...value.file,
        bucket,
        key: `owners/${ownerHash}/runs/${value.sourceRunId}/artifacts/${value.id}`,
      },
    })),
  };
}

function artifact(path: string, sourceRunId: string, createdAt: string) {
  const id = createHash('sha256').update(path).digest('hex').slice(0, 24);
  return {
    id,
    path,
    mediaType: path.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8',
    bytes: 12,
    createdAt,
    sourceRunId,
    file: {
      bucket: '',
      key: '',
      sha256: createHash('sha256').update(path).digest('hex'),
    },
  };
}
