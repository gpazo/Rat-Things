import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  latestPublicationSourceRunId,
  PublicationPublisher,
} from '../../src/core/publication-publisher.js';
import type { PublicationObjectStore } from '../../src/core/publication-service.js';
import type { ArtifactCatalog } from '../../src/domain/contracts.js';
import type {
  BlobReference,
  PublicationManifest,
  PublicationShare,
} from '../../src/domain/publications.js';

class MemoryPublicationObjects implements PublicationObjectStore {
  public readonly staged: string[] = [];
  public manifest: PublicationManifest | undefined;

  public async stageBlob(input: {
    publicationId: string;
    path: string;
    source: BlobReference;
  }): Promise<BlobReference> {
    this.staged.push(input.path);
    return { ...input.source, id: `publications/${input.publicationId}/${input.path}` };
  }

  public async stageBytes(input: {
    publicationId: string;
    path: string;
    bytes: Uint8Array;
    mediaType: string;
  }): Promise<BlobReference> {
    this.staged.push(input.path);
    return {
      id: `publications/${input.publicationId}/${input.path}`,
      digest: `sha256:${createHash('sha256').update(input.bytes).digest('hex')}`,
      size: input.bytes.byteLength,
      mediaType: input.mediaType,
    };
  }

  public async commit(input: { manifest: PublicationManifest }): Promise<BlobReference> {
    this.manifest = input.manifest;
    return {
      id: `publications/${input.manifest.publicationId}/_rat/manifest.json`,
      digest: `sha256:${'f'.repeat(64)}`,
      size: 1,
      mediaType: 'application/json',
    };
  }
}

class MemoryGrants {
  public readonly values: PublicationShare[] = [];
  public async put(share: PublicationShare): Promise<void> {
    this.values.push(share);
  }
}

describe('publication publisher', () => {
  it('publishes an owner-scoped catalog and returns a canonical expiring link', async () => {
    const ownerId = 'owner-1';
    const bucket = 'artifacts';
    const catalog = siteCatalog(ownerId, bucket);
    const objects = new MemoryPublicationObjects();
    const grants = new MemoryGrants();
    const publisher = new PublicationPublisher(objects, grants, {
      artifactBucket: bucket,
      baseDomain: '.Agent-Content.Example.',
      ttlSeconds: 7_200,
      now: () => new Date('2026-08-15T12:00:00.000Z'),
      randomToken: () => 'b'.repeat(64),
    });

    const result = await publisher.publish({
      ownerId,
      spec: { version: '1', kind: 'site', root: 'site', title: 'Demo' },
      catalog,
      runId: 'run-2',
      conversationId: 'conversation-1',
    });

    const ownerHash = createHash('sha256').update(ownerId).digest('hex').slice(0, 32);
    expect(result).toEqual({
      publicationId: expect.stringMatching(/^[a-f0-9]{24}$/),
      kind: 'site',
      url: `https://${result.publicationId}-${ownerHash}.agent-content.example/__share/${ownerHash}-${'b'.repeat(64)}`,
      expiresAt: '2026-08-15T14:00:00.000Z',
      entrypoint: 'index.html',
      paths: ['app.js', 'index.html'],
    });
    expect(objects.staged).toEqual(['index.html', 'app.js']);
    expect(objects.manifest?.provenance).toEqual({
      runId: 'run-2',
      conversationId: 'conversation-1',
      builder: 'rat-things/site@1',
      createdAt: '2026-08-15T11:30:00.000Z',
    });
    expect(grants.values).toEqual([{
      version: '2',
      kind: 'site',
      grant: {
        version: '1',
        id: `${ownerHash}-${'b'.repeat(64)}`,
        publicationId: result.publicationId,
        ownerHash,
        access: 'bearer',
        expiresAt: '2026-08-15T14:00:00.000Z',
      },
    }]);
  });

  it('rejects catalog entries outside the authenticated owner scope', async () => {
    const objects = new MemoryPublicationObjects();
    const publisher = new PublicationPublisher(objects, new MemoryGrants(), {
      artifactBucket: 'artifacts',
      baseDomain: 'agent-content.example',
      ttlSeconds: 60,
    });
    const catalog = siteCatalog('another-owner', 'artifacts');

    await expect(publisher.publish({
      ownerId: 'owner-1',
      spec: { version: '1', kind: 'site', root: 'site' },
      catalog,
      runId: 'run-1',
    })).rejects.toThrow('outside its owner scope');
    expect(objects.staged).toEqual([]);
  });

  it('finds the latest source run for just the requested publication paths', () => {
    const catalog = siteCatalog('owner-1', 'artifacts');
    expect(latestPublicationSourceRunId(
      catalog,
      { version: '1', kind: 'site', root: 'site' },
    )).toBe('run-2');
    expect(latestPublicationSourceRunId(
      catalog,
      { version: '1', kind: 'file', path: 'missing.txt' },
    )).toBe('conversation-publication');
  });
});

function siteCatalog(ownerId: string, bucket: string): ArtifactCatalog {
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
