import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PublicationPublisher } from '../../src/core/publication-publisher.js';
import type { PublicationObjectStore } from '../../src/core/publication-service.js';
import type { ArtifactReference } from '../../src/domain/contracts.js';
import type {
  BlobReference,
  PublicationManifest,
  PublicationShare,
} from '../../src/domain/publications.js';
import {
  emptyArtifactCatalog,
  prepareArtifactDirectory,
  publishArtifactCatalog,
} from '../../src/runner/artifacts.js';
import {
  BrowserToolSession,
  type BrowserBackend,
  type BrowserBackendResult,
  type BrowserCommand,
} from '../../src/runner/browser.js';
import {
  appendSharedPublications,
  readAgentShareRequests,
} from '../../src/runner/publications.js';

describe('simulated browser capture publication workflow', () => {
  it('turns browser screenshot and recording artifacts into separate share URLs', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'rat-browser-publication-'));
    const artifactRoot = await prepareArtifactDirectory(workspace);
    const browser = new BrowserToolSession(new SimulatedCaptureBackend(artifactRoot));
    try {
      await browser.call({
        namespace: 'rat_browser',
        tool: 'record_start',
        arguments: { path: 'browser/navigation.webm', fps: 5 },
      });
      await browser.call({
        namespace: 'rat_browser',
        tool: 'screenshot',
        arguments: { path: 'browser/final.jpg' },
      });
      await browser.call({
        namespace: 'rat_browser',
        tool: 'record_stop',
        arguments: {},
      });
      await writeFile(join(workspace, '.rat-things/share.json'), JSON.stringify({
        version: '1',
        publications: [
          {
            version: '1',
            kind: 'file',
            path: 'browser/final.jpg',
            title: 'Browser screenshot',
          },
          {
            version: '1',
            kind: 'video',
            path: 'browser/navigation.webm',
            poster: 'browser/final.jpg',
            title: 'Browser navigation recording',
          },
        ],
      }));

      const ownerId = 'api:browser-demo-owner';
      const runId = 'run-browser-demo';
      const artifacts = new MemoryArtifacts('artifacts-bucket');
      const files = await publishArtifactCatalog({
        workspace,
        previous: emptyArtifactCatalog(),
        artifacts,
        ownerId,
        runId,
        createdAt: '2026-08-21T12:00:00.000Z',
      });
      expect(files).toEqual([
        expect.objectContaining({
          path: 'browser/final.jpg',
          mediaType: 'image/jpeg',
        }),
        expect.objectContaining({
          path: 'browser/navigation.webm',
          mediaType: 'video/webm',
        }),
      ]);

      const objects = new MemoryPublicationObjects();
      const grants = new MemoryPublicationGrants();
      const publisher = new PublicationPublisher(objects, grants, {
        artifactBucket: artifacts.bucket,
        baseDomain: 'shares.example.test',
        ttlSeconds: 3_600,
        now: () => new Date('2026-08-21T12:00:00.000Z'),
        randomToken: () => 'a'.repeat(64),
      });
      const requests = await readAgentShareRequests(workspace);
      const catalog = { version: '1' as const, files };
      const shared = [];
      for (const request of requests) {
        shared.push({
          ...request,
          descriptor: await publisher.publish({
            ownerId,
            spec: request.spec,
            catalog,
            runId,
          }),
        });
      }

      const result = appendSharedPublications('Navigation complete.', shared);
      const urls = [...result.matchAll(/\]\((https:\/\/[^)]+)\)/g)]
        .flatMap((match) => match[1] ? [match[1]] : []);
      expect(urls).toHaveLength(2);
      expect(new Set(urls).size).toBe(2);
      expect(urls.every((url) => url?.includes('.shares.example.test/__share/'))).toBe(true);
      expect(objects.manifests.map((manifest) => ({
        kind: manifest.kind,
        paths: manifest.files.map((file) => file.path),
      }))).toEqual([
        {
          kind: 'file',
          paths: ['assets/final.jpg', 'index.html'],
        },
        {
          kind: 'video',
          paths: ['assets/final.jpg', 'assets/navigation.webm', 'index.html'],
        },
      ]);
      expect(grants.values).toHaveLength(2);
    } finally {
      await browser.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

class SimulatedCaptureBackend implements BrowserBackend {
  private recordingPath: string | undefined;

  public constructor(private readonly artifactRoot: string) {}

  public async execute(command: BrowserCommand): Promise<BrowserBackendResult> {
    if (command.type === 'record_start') {
      this.recordingPath = command.path;
      return { text: JSON.stringify({ recording: { path: command.path, fps: command.fps } }) };
    }
    if (command.type === 'screenshot') {
      await this.write(command.path, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x52, 0x41, 0x54, 0xff, 0xd9]));
      return {
        text: JSON.stringify({ artifact: { path: command.path, mediaType: 'image/jpeg' } }),
        imageDataUrl: 'data:image/jpeg;base64,/9j/4FJBVP/Z',
      };
    }
    if (command.type === 'record_stop') {
      if (!this.recordingPath) throw new Error('no simulated recording is active');
      const path = this.recordingPath;
      this.recordingPath = undefined;
      await this.write(path, Buffer.concat([
        Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
        Buffer.from('webm-simulated-navigation'),
      ]));
      return { text: JSON.stringify({ artifact: { path, mediaType: 'video/webm' } }) };
    }
    return { text: '{}' };
  }

  public async close(): Promise<void> {}

  private async write(path: string, bytes: Uint8Array): Promise<void> {
    const target = join(this.artifactRoot, ...path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes, { mode: 0o600 });
  }
}

class MemoryArtifacts {
  public readonly values = new Map<string, Uint8Array>();

  public constructor(public readonly bucket: string) {}

  public async putStream(
    key: string,
    value: AsyncIterable<Uint8Array>,
    _contentType: string,
  ): Promise<ArtifactReference> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of value) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    this.values.set(key, bytes);
    return {
      bucket: this.bucket,
      key,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  }

  public async copy(
    source: ArtifactReference,
    key: string,
    _contentType: string,
  ): Promise<ArtifactReference> {
    const bytes = this.values.get(source.key);
    if (!bytes) throw new Error('simulated artifact source is missing');
    this.values.set(key, bytes);
    return { ...source, key };
  }
}

class MemoryPublicationObjects implements PublicationObjectStore {
  public readonly manifests: PublicationManifest[] = [];

  public async stageBlob(input: {
    ownerId: string;
    publicationId: string;
    path: string;
    source: BlobReference;
  }): Promise<BlobReference> {
    return {
      ...input.source,
      id: `publications/${input.publicationId}/${input.path}`,
    };
  }

  public async stageBytes(input: {
    ownerId: string;
    publicationId: string;
    path: string;
    bytes: Uint8Array;
    mediaType: string;
  }): Promise<BlobReference> {
    return {
      id: `publications/${input.publicationId}/${input.path}`,
      digest: `sha256:${createHash('sha256').update(input.bytes).digest('hex')}`,
      size: input.bytes.byteLength,
      mediaType: input.mediaType,
    };
  }

  public async commit(input: {
    ownerId: string;
    manifest: PublicationManifest;
  }): Promise<BlobReference> {
    this.manifests.push(structuredClone(input.manifest));
    const bytes = Buffer.from(JSON.stringify(input.manifest));
    return {
      id: `publications/${input.manifest.publicationId}/_rat/manifest.json`,
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      size: bytes.byteLength,
      mediaType: 'application/json',
    };
  }
}

class MemoryPublicationGrants {
  public readonly values: PublicationShare[] = [];

  public async put(share: PublicationShare): Promise<void> {
    this.values.push(structuredClone(share));
  }
}
