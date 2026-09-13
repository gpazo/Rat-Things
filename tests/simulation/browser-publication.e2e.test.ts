import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionPublicationService } from '../../src/core/session-publication-service.js';
import type { SavedSessionArtifact } from '../../src/core/session-ports.js';
import type { PublicationObjectStore } from '../../src/core/publication-service.js';
import type {
  BlobReference,
  PublicationManifest,
  PublicationShare,
} from '../../src/domain/publications.js';
import { prepareArtifactDirectory } from '../../src/runner/artifacts.js';
import {
  BrowserToolSession,
  type BrowserBackend,
  type BrowserBackendResult,
  type BrowserCommand,
} from '../../src/runner/browser.js';
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
      const ownerId = 'api:browser-demo-owner';
      const sessionId = 'sess_browser_demo';
      const ownerHash = createHash('sha256').update(ownerId).digest('hex').slice(0, 32);
      const values = new Map<string, Buffer>();
      const saved: SavedSessionArtifact[] = [];
      for (const [index, path] of ['browser/final.jpg', 'browser/navigation.webm'].entries()) {
        const bytes = await readFile(join(artifactRoot, path));
        const id = `art_${index}`;
        const key = `owners/${ownerHash}/sessions/${sessionId}/turn_demo/artifacts/${id}`;
        values.set(key, bytes);
        saved.push({
          artifact: { id, object: 'agent.session.artifact', session_id: sessionId, turn_id: 'turn_demo', environment_id: 'env_demo', path: `/workspace/${path}`, size_bytes: bytes.length, created_at: 100 },
          content: { bucket: 'artifacts', key, sha256: createHash('sha256').update(bytes).digest('hex') },
        });
      }
      const objects = new MemoryPublicationObjects();
      const grants = new MemoryPublicationGrants();
      const publisher = new SessionPublicationService({
        sessions: { publicationArtifacts: async (owner, session, ids) => {
          if (owner !== ownerId || session !== sessionId) throw new Error('Session not found');
          return ids.map((id) => saved.find((entry) => entry.artifact.id === id)!);
        } },
        objects, grants, artifactBucket: 'artifacts', readPrefix: async (reference) => values.get(reference.key)!,
        baseDomain: 'shares.example.test', ttlSeconds: 3_600,
        now: () => new Date('2026-08-21T12:00:00.000Z'), randomToken: () => 'a'.repeat(64),
      });
      const screenshot = { artifact_id: 'art_0', path: 'browser/final.jpg' };
      const recording = { artifact_id: 'art_1', path: 'browser/navigation.webm' };
      const image = await publisher.publish(ownerId, sessionId, {
        publication: { version: '1', kind: 'file', path: screenshot.path, title: 'Browser screenshot' }, files: [screenshot],
      });
      const video = await publisher.publish(ownerId, sessionId, {
        publication: { version: '1', kind: 'video', path: recording.path, poster: screenshot.path, title: 'Browser navigation recording' }, files: [recording, screenshot],
      });
      const urls = [image.url, video.url];
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
