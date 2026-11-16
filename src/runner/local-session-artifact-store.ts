import { createHash } from 'node:crypto';
import type { AgentResource, AgentsStore } from '../core/agents-ports.js';
import type { ArtifactReference } from '../domain/contracts.js';

const BUCKET = 'local-session-artifacts';
interface StoredArtifactBytes { key: string; sha256: string; data: string }

/** Immutable local blobs in AgentsStore, reusing the local profile's encrypted record storage. */
export class LocalSessionArtifactStore {
  private readonly collection: string;
  public constructor(private readonly store: AgentsStore, private readonly ownerId: string, sessionId: string) {
    this.collection = `local_session_artifact_bytes_${sha256(sessionId)}`;
  }

  public async putBytes(key: string, value: Uint8Array): Promise<ArtifactReference> {
    if (!key || key.includes('\0')) throw new Error('Invalid local artifact key');
    const id = sha256(key);
    const digest = sha256(value);
    const current = await this.store.get<StoredArtifactBytes>(this.ownerId, this.collection, id);
    if (current) {
      assertSameArtifact(current.value, key, digest, value);
      return reference(key, digest);
    }
    try {
      await this.store.put({ ownerId: this.ownerId, collection: this.collection, id, createdAt: 0, revision: 1,
        value: { key, sha256: digest, data: Buffer.from(value).toString('base64') } }, 0);
    } catch (error) {
      const raced = await this.store.get<StoredArtifactBytes>(this.ownerId, this.collection, id);
      if (!raced) throw error;
      assertSameArtifact(raced.value, key, digest, value);
    }
    return reference(key, digest);
  }

  public async getBytes(artifact: Pick<ArtifactReference, 'bucket' | 'key' | 'sha256'>): Promise<Uint8Array> {
    if (artifact.bucket !== BUCKET || !/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new Error('Invalid local artifact reference');
    const stored = await this.store.get<StoredArtifactBytes>(this.ownerId, this.collection, sha256(artifact.key));
    if (!stored || stored.value.key !== artifact.key || stored.value.sha256 !== artifact.sha256) throw new Error('Local artifact content is unavailable');
    const bytes = decode(stored.value.data);
    if (sha256(bytes) !== artifact.sha256) throw new Error('Local artifact content digest mismatch');
    return bytes;
  }

  public async deleteSession(): Promise<void> {
    for (;;) {
      const page = await this.store.list<StoredArtifactBytes>(this.ownerId, this.collection, { limit: 100, order: 'asc', orderBy: 'id' });
      if (!page.data.length) return;
      for (const resource of page.data) await this.store.delete(resource as AgentResource<unknown>);
    }
  }
}

function assertSameArtifact(stored: StoredArtifactBytes, key: string, digest: string, bytes: Uint8Array): void {
  if (stored.key !== key || stored.sha256 !== digest || !decode(stored.data).equals(Buffer.from(bytes))) {
    throw new Error('Local artifact key is already bound to different bytes');
  }
}

function decode(value: string): Buffer {
  if (typeof value !== 'string' || value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value)) throw new Error('Invalid local artifact bytes');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new Error('Invalid local artifact bytes');
  return bytes;
}

function reference(key: string, digest: string): ArtifactReference { return { bucket: BUCKET, key, sha256: digest }; }
function sha256(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
