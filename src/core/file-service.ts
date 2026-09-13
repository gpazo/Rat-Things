import { createHash, randomUUID } from 'node:crypto';
import type { FileObject, FileListParams, FileDeleted, FileCreateParams } from 'openai/resources/files';
import type { AgentsStore, AgentsClock } from './agents-ports.js';
import type { ArtifactStore } from './ports.js';
import type { ArtifactReference } from '../domain/contracts.js';
import { invalid, resourceNotFound } from '../domain/agents-api-validation.js';

interface StoredFile { file: FileObject; content: ArtifactReference }

export class FileService {
  public constructor(private readonly options: { store: AgentsStore; artifacts: Pick<ArtifactStore, 'putBytes' | 'getBytes' | 'getStream'>; clock?: AgentsClock }) {}
  private now() { return this.options.clock?.now() ?? Math.floor(Date.now() / 1000); }

  public async create(ownerId: string, input: { filename: string; data: Uint8Array; purpose: FileCreateParams['purpose']; expires_after?: FileCreateParams['expires_after'] }): Promise<FileObject> {
    if (!['assistants', 'batch', 'fine-tune', 'vision', 'user_data', 'evals'].includes(input.purpose)) invalid('Invalid file purpose', 'purpose');
    if (!input.filename || input.filename.includes('\0') || Buffer.byteLength(input.filename) > 1024) invalid('Invalid filename', 'file');
    if (input.data.byteLength > 512 * 1024 * 1024) invalid('Files must not exceed 512 MiB', 'file');
    const expiry = input.expires_after ?? (input.purpose === 'batch' ? { anchor: 'created_at', seconds: 2_592_000 } : undefined);
    if (expiry && (expiry.anchor !== 'created_at' || !Number.isInteger(expiry.seconds) || expiry.seconds < 3600 || expiry.seconds > 2_592_000)) invalid('Invalid file expiration policy', 'expires_after');
    const id = `file-${randomUUID().replaceAll('-', '')}`;
    const now = this.now();
    const file: FileObject = { id, object: 'file', filename: input.filename, bytes: input.data.byteLength,
      created_at: now, purpose: input.purpose as FileObject['purpose'], status: 'processed', ...(expiry ? { expires_at: now + expiry.seconds } : {}) };
    const owner = createHash('sha256').update(ownerId).digest('hex');
    const content = await this.options.artifacts.putBytes(`owners/${owner}/files/${id}`, input.data, 'application/octet-stream');
    await this.options.store.put<StoredFile>({ id, ownerId, collection: 'files', createdAt: now, revision: 1, value: { file, content } }, 0);
    return file;
  }

  public async retrieve(ownerId: string, id: string) { return (await this.required(ownerId, id)).value.file; }
  public async reference(ownerId: string, id: string) { return (await this.required(ownerId, id)).value.content; }
  public async bytes(ownerId: string, id: string) { return this.options.artifacts.getBytes(await this.reference(ownerId, id)); }
  public async content(ownerId: string, id: string) { return this.options.artifacts.getStream(await this.reference(ownerId, id)); }
  public async delete(ownerId: string, id: string): Promise<FileDeleted> {
    await this.options.store.delete(await this.required(ownerId, id));
    return { id, object: 'file', deleted: true };
  }
  public async list(ownerId: string, query: FileListParams = {}) {
    const limit = query.limit ?? 10_000;
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) invalid('Invalid limit', 'limit');
    let after = query.after;
    const selected: FileObject[] = [];
    do {
      const page = await this.options.store.list<StoredFile>(ownerId, 'files', { limit: 100, ...(after ? { after } : {}), ...(query.order ? { order: query.order } : {}) });
      selected.push(...page.data.map(({ value }) => value.file).filter((file) => (!file.expires_at || file.expires_at > this.now()) && (!query.purpose || query.purpose === file.purpose)));
      if (!page.has_more || selected.length > limit) break;
      after = page.data.at(-1)?.id;
    } while (after);
    const data = selected.slice(0, limit);
    return { object: 'list' as const, data, has_more: selected.length > limit, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null };
  }
  private async required(ownerId: string, id: string) {
    const resource = await this.options.store.get<StoredFile>(ownerId, 'files', id) ?? resourceNotFound();
    if (resource.value.file.expires_at && resource.value.file.expires_at <= this.now()) resourceNotFound();
    return resource;
  }
}
