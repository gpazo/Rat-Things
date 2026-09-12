import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { siteCatalog } from './publication-fixtures.js';
import {
  latestPublicationSourceRunId,
  PublicationPublisher,
} from '../../src/core/publication-publisher.js';
import type { PublicationObjectStore } from '../../src/core/publication-service.js';
import type {
  BlobReference,
  PublicationManifest,
  PublicationShare,
} from '../../src/domain/publications.js';

class MemoryPublicationObjects implements PublicationObjectStore {
  public readonly staged: string[] = [];
  public manifest: PublicationManifest | undefined;

  public async getCommitted(input: {
    publicationId: string;
  }): Promise<{ manifest: PublicationManifest; manifestBlob: BlobReference } | undefined> {
    if (!this.manifest || this.manifest.publicationId !== input.publicationId) return undefined;
    return {
      manifest: this.manifest,
      manifestBlob: {
        id: `publications/${input.publicationId}/_rat/manifest.json`,
        digest: `sha256:${'f'.repeat(64)}`,
        size: 1,
        mediaType: 'application/json',
      },
    };
  }

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

  it('reuses the publication identity when the spec and bytes are unchanged across runs', async () => {
    const ownerId = 'owner-1';
    const catalog = siteCatalog(ownerId, 'artifacts');
    const objects = new MemoryPublicationObjects();
    const publisher = new PublicationPublisher(
      objects,
      new MemoryGrants(),
      {
        artifactBucket: 'artifacts',
        baseDomain: 'agent-content.example',
        ttlSeconds: 60,
        randomToken: () => 'c'.repeat(64),
      },
    );
    const spec = { version: '1', kind: 'site', root: 'site', title: 'Demo' } as const;

    const first = await publisher.publish({
      ownerId,
      spec,
      catalog,
      runId: 'run-1',
      conversationId: 'conversation-1',
    });
    const second = await publisher.publish({
      ownerId,
      spec,
      catalog,
      runId: 'run-99',
      conversationId: 'conversation-99',
    });

    expect(second.publicationId).toBe(first.publicationId);
    expect(objects.staged).toEqual(['index.html', 'app.js']);
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

  it('commits before generating the token, reading time, and writing the grant', async () => {
    const objects = new MemoryPublicationObjects();
    const grants = new MemoryGrants();
    const events: string[] = [];
    const commit = objects.commit.bind(objects);
    objects.commit = async (input) => {
      events.push('commit');
      return commit(input);
    };
    const put = grants.put.bind(grants);
    grants.put = async (share) => {
      events.push('grant');
      return put(share);
    };
    const publisher = new PublicationPublisher(objects, grants, {
      artifactBucket: 'artifacts', baseDomain: 'agent-content.example', ttlSeconds: 60,
      randomToken: () => { events.push('token'); return 'a'.repeat(64); },
      now: () => { events.push('clock'); return new Date('2026-08-15T12:00:00.000Z'); },
    });

    await publisher.publish(siteInput());
    expect(events).toEqual(['commit', 'token', 'clock', 'grant']);
  });

  it('rejects an invalid token after committing and before reading time or writing a grant', async () => {
    const objects = new MemoryPublicationObjects();
    const grants = new MemoryGrants();
    const now = vi.fn(() => new Date());
    const publisher = new PublicationPublisher(objects, grants, {
      artifactBucket: 'artifacts', baseDomain: 'agent-content.example', ttlSeconds: 60,
      randomToken: () => 'INVALID', now,
    });

    await expect(publisher.publish(siteInput())).rejects.toThrow('invalid token');
    expect(objects.manifest).toBeDefined();
    expect(now).not.toHaveBeenCalled();
    expect(grants.values).toEqual([]);
  });

  it('retries a failed grant without restaging the committed publication', async () => {
    const objects = new MemoryPublicationObjects();
    const cause = new Error('grant storage unavailable');
    const put = vi.fn().mockRejectedValueOnce(cause).mockResolvedValueOnce(undefined);
    const randomToken = vi.fn().mockReturnValueOnce('a'.repeat(64)).mockReturnValueOnce('b'.repeat(64));
    const now = vi.fn(() => new Date('2026-08-15T12:00:00.000Z'));
    const publisher = new PublicationPublisher(objects, { put }, {
      artifactBucket: 'artifacts', baseDomain: 'agent-content.example', ttlSeconds: 60,
      randomToken, now,
    });

    await expect(publisher.publish(siteInput())).rejects.toBe(cause);
    const manifest = objects.manifest;
    const result = await publisher.publish({ ...siteInput(), runId: 'retry-run' });

    expect(objects.staged).toEqual(['index.html', 'app.js']);
    expect(objects.manifest).toBe(manifest);
    expect(objects.manifest?.provenance.runId).toBe('run-1');
    expect(result.url).toContain('b'.repeat(64));
    expect(randomToken).toHaveBeenCalledTimes(2);
    expect(now).toHaveBeenCalledTimes(2);
  });

  it('rejects a foreign unrelated file before selecting the requested site', async () => {
    const objects = new MemoryPublicationObjects();
    const grants = new MemoryGrants();
    const randomToken = vi.fn(() => 'a'.repeat(64));
    const publisher = new PublicationPublisher(objects, grants, {
      artifactBucket: 'artifacts', baseDomain: 'agent-content.example', ttlSeconds: 60, randomToken,
    });
    const input = siteInput();
    input.catalog.files[2]!.file.key = siteCatalog('another-owner', 'artifacts').files[2]!.file.key;

    await expect(publisher.publish(input)).rejects.toThrow('outside its owner scope');
    expect(objects.staged).toEqual([]);
    expect(randomToken).not.toHaveBeenCalled();
    expect(grants.values).toEqual([]);
  });

  it('does not create a token or read grant time when committing fails', async () => {
    const objects = new MemoryPublicationObjects();
    objects.commit = async () => { throw new Error('commit failed'); };
    const grants = new MemoryGrants();
    const randomToken = vi.fn(() => 'a'.repeat(64));
    const now = vi.fn(() => new Date());
    const publisher = new PublicationPublisher(objects, grants, {
      artifactBucket: 'artifacts', baseDomain: 'agent-content.example', ttlSeconds: 60, randomToken, now,
    });

    await expect(publisher.publish(siteInput())).rejects.toMatchObject({
      code: 'storage', message: 'could not commit publication manifest',
    });
    expect(objects.staged).toEqual(['index.html', 'app.js']);
    expect(randomToken).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    expect(grants.values).toEqual([]);
  });

  it('keeps the returned link values independent of grant-store input mutation', async () => {
    const objects = new MemoryPublicationObjects();
    const grants = {
      put: async (share: PublicationShare) => {
        share.grant.id = 'storage-key';
        share.grant.ownerHash = 'storage-owner';
        share.grant.publicationId = 'storage-publication';
        share.grant.expiresAt = 'storage-expiry';
      },
    };
    const publisher = new PublicationPublisher(objects, grants, {
      artifactBucket: 'artifacts', baseDomain: 'agent-content.example', ttlSeconds: 60,
      randomToken: () => 'a'.repeat(64), now: () => new Date('2026-08-15T12:00:00.000Z'),
    });
    const ownerHash = createHash('sha256').update('owner-1').digest('hex').slice(0, 32);

    const result = await publisher.publish(siteInput());
    expect(result.publicationId).toBe(objects.manifest?.publicationId);
    expect(result.url).toBe(`https://${result.publicationId}-${ownerHash}.agent-content.example/__share/${ownerHash}-${'a'.repeat(64)}`);
    expect(result.expiresAt).toBe('2026-08-15T12:01:00.000Z');
  });
});

function siteInput() {
  return {
    ownerId: 'owner-1',
    spec: { version: '1', kind: 'site', root: 'site' } as const,
    catalog: siteCatalog('owner-1', 'artifacts'),
    runId: 'run-1',
  };
}
