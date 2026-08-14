import { createHash } from 'node:crypto';
import {
  mkdir,
  link,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ArtifactReference } from '../../src/domain/contracts.js';
import {
  assertArtifactCatalogScope,
  emptyArtifactCatalog,
  publishArtifactCatalog,
  restoreArtifactCatalog,
} from '../../src/runner/artifacts.js';

class MemoryArtifacts {
  public readonly values = new Map<string, Uint8Array>();
  public readonly puts: string[] = [];

  public async putBytes(
    key: string,
    value: Uint8Array,
    _contentType: string,
  ): Promise<ArtifactReference> {
    const bytes = Uint8Array.from(value);
    this.values.set(key, bytes);
    this.puts.push(key);
    return {
      bucket: 'artifacts',
      key,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  }

  public async getBytes(reference: Pick<ArtifactReference, 'key'>): Promise<Uint8Array> {
    const value = this.values.get(reference.key);
    if (!value) throw new Error(`missing ${reference.key}`);
    return Uint8Array.from(value);
  }
}

describe('agent artifact catalog', () => {
  it('publishes, reuses, restores, and deletes durable files by relative path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rat-artifacts-'));
    const replacement = await mkdtemp(join(tmpdir(), 'rat-artifacts-replacement-'));
    const store = new MemoryArtifacts();
    const png = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.from('test-image'),
    ]);
    try {
      await restoreArtifactCatalog(root, emptyArtifactCatalog(), store);
      await mkdir(join(root, '.rat-things/artifacts/screens'), { recursive: true });
      await writeFile(join(root, '.rat-things/artifacts/screens/home.png'), png);

      const first = await publishArtifactCatalog({
        workspace: root,
        previous: emptyArtifactCatalog(),
        artifacts: store,
        ownerId: 'owner-1',
        runId: 'run-1',
        createdAt: '2026-08-14T12:00:00.000Z',
      });
      expect(first).toEqual([
        expect.objectContaining({
          id: expect.stringMatching(/^[a-f0-9]{24}$/),
          path: 'screens/home.png',
          mediaType: 'image/png',
          bytes: png.length,
          sourceRunId: 'run-1',
        }),
      ]);
      expect(store.puts).toHaveLength(1);

      const unchanged = await publishArtifactCatalog({
        workspace: root,
        previous: { version: '1', files: first },
        artifacts: store,
        ownerId: 'owner-1',
        runId: 'run-2',
      });
      expect(unchanged).toEqual([
        expect.objectContaining({
          path: 'screens/home.png',
          sourceRunId: 'run-1',
          file: expect.objectContaining({ key: expect.stringContaining('/runs/run-2/') }),
        }),
      ]);
      expect(store.puts).toHaveLength(2);

      await restoreArtifactCatalog(replacement, { version: '1', files: unchanged }, store);
      expect(await readFile(
        join(replacement, '.rat-things/artifacts/screens/home.png'),
      )).toEqual(png);

      await rm(join(replacement, '.rat-things/artifacts/screens/home.png'));
      await expect(publishArtifactCatalog({
        workspace: replacement,
        previous: { version: '1', files: first },
        artifacts: store,
        ownerId: 'owner-1',
        runId: 'run-3',
      })).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(replacement, { recursive: true, force: true });
    }
  });

  it('rejects symbolic links instead of reading outside the artifact directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rat-artifact-link-'));
    const outside = join(root, 'outside.txt');
    const store = new MemoryArtifacts();
    try {
      await restoreArtifactCatalog(root, emptyArtifactCatalog(), store);
      await writeFile(outside, 'secret');
      await symlink(outside, join(root, '.rat-things/artifacts/leak.txt'));
      await expect(publishArtifactCatalog({
        workspace: root,
        previous: emptyArtifactCatalog(),
        artifacts: store,
        ownerId: 'owner-1',
        runId: 'run-1',
      })).rejects.toThrow('cannot be a symbolic link');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects hard links instead of treating aliased bytes as an artifact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rat-artifact-hard-link-'));
    const outside = join(root, 'outside.txt');
    const store = new MemoryArtifacts();
    try {
      await restoreArtifactCatalog(root, emptyArtifactCatalog(), store);
      await writeFile(outside, 'secret');
      await link(outside, join(root, '.rat-things/artifacts/leak.txt'));
      await expect(publishArtifactCatalog({
        workspace: root,
        previous: emptyArtifactCatalog(),
        artifacts: store,
        ownerId: 'owner-1',
        runId: 'run-1',
      })).rejects.toThrow('cannot be a hard link');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects catalog objects from another owner scope', () => {
    expect(() => assertArtifactCatalogScope({
      version: '1',
      files: [{
        id: createHash('sha256').update('file.txt').digest('hex').slice(0, 24),
        path: 'file.txt',
        mediaType: 'text/plain; charset=utf-8',
        bytes: 4,
        createdAt: '2026-08-14T12:00:00.000Z',
        sourceRunId: 'run-1',
        file: {
          bucket: 'artifacts',
          key: 'owners/not-the-owner/runs/run-1/artifacts/file.txt',
          sha256: 'a'.repeat(64),
        },
      }],
    }, 'artifacts', 'owner-1')).toThrow('outside its owner scope');
  });
});
