import { createHash } from 'node:crypto';
import type { ArtifactReference } from '../../src/domain/contracts.js';

export class MemoryArtifacts {
  public readonly values = new Map<string, Uint8Array>();
  public readonly puts: string[] = [];
  public readonly copies: string[] = [];

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

  public async putStream(
    key: string,
    value: AsyncIterable<Uint8Array>,
    contentType: string,
  ): Promise<ArtifactReference> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of value) chunks.push(Uint8Array.from(chunk));
    return this.putBytes(key, Buffer.concat(chunks), contentType);
  }

  public async getStream(
    reference: Pick<ArtifactReference, 'key'>,
  ): Promise<AsyncIterable<Uint8Array>> {
    const bytes = await this.getBytes(reference);
    return (async function* () { yield bytes; })();
  }

  public async copy(
    source: ArtifactReference,
    key: string,
    _contentType: string,
  ): Promise<ArtifactReference> {
    const bytes = await this.getBytes(source);
    this.values.set(key, bytes);
    this.copies.push(key);
    return { bucket: 'artifacts', key, sha256: source.sha256 };
  }
}
