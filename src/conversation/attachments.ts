import { artifactIdForPath, validateArtifactPath } from '../domain/artifacts.js';
import type { ArtifactCatalog, ArtifactReference, PublishedArtifact } from '../domain/contracts.js';
import { canonicalJson, sha256Hex as digest } from '../domain/json.js';
import { ConversationConflictError, ConversationStateError } from './types.js';
import { requiredId, validateConversationArtifactCatalog } from './validation.js';

export const MAX_CONVERSATION_UPLOAD_FILES = 6;
export const MAX_CONVERSATION_UPLOAD_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_CONVERSATION_UPLOAD_TOTAL_BYTES = 6 * 1024 * 1024;

export interface ConversationAttachmentUpload {
  name: string;
  mediaType: string;
  bytes: Uint8Array;
  sha256: string;
}

export interface ConversationAttachmentManifest {
  version: '1';
  files: PublishedArtifact[];
}

export interface PrepareAttachmentsInput {
  conversationId: string;
  ownerId: string;
  messageId: string;
  sourceRunId: string;
  uploads: ConversationAttachmentUpload[];
}

export function validateAttachmentInput(input: PrepareAttachmentsInput): void {
  requiredId(input.conversationId, 'conversationId', 512);
  requiredId(input.ownerId, 'ownerId', 1_024);
  requiredId(input.messageId, 'messageId', 512);
  requiredId(input.sourceRunId, 'sourceRunId', 128);
  if (!Array.isArray(input.uploads) || input.uploads.length < 1 || input.uploads.length > MAX_CONVERSATION_UPLOAD_FILES) {
    throw new ConversationStateError(`attachments must contain 1-${MAX_CONVERSATION_UPLOAD_FILES} files`);
  }
}

export interface AttachmentBatch {
  paths: readonly string[];
  totalBytes: number;
}

export interface AttachmentUploadPlan {
  path: string;
  mediaType: string;
  batch: AttachmentBatch;
}

/** Validate one file at a time so the service can preserve sequential writes and partial failure. */
export function planAttachmentUpload(
  upload: ConversationAttachmentUpload,
  messageHash: string,
  batch: AttachmentBatch,
): AttachmentUploadPlan {
  const name = safeUploadName(upload.name);
  const path = `uploads/${messageHash.slice(0, 12)}/${name}`;
  validateArtifactPath(path);
  if (batch.paths.includes(path)) throw new ConversationStateError(`attachment name ${name} is duplicated`);
  if (!(upload.bytes instanceof Uint8Array) || upload.bytes.byteLength > MAX_CONVERSATION_UPLOAD_FILE_BYTES) {
    throw new ConversationStateError(`attachment ${name} exceeds ${MAX_CONVERSATION_UPLOAD_FILE_BYTES} bytes`);
  }
  const totalBytes = batch.totalBytes + upload.bytes.byteLength;
  if (totalBytes > MAX_CONVERSATION_UPLOAD_TOTAL_BYTES) {
    throw new ConversationStateError(`attachments exceed ${MAX_CONVERSATION_UPLOAD_TOTAL_BYTES} bytes`);
  }
  if (!/^[a-f0-9]{64}$/.test(upload.sha256) || digest(upload.bytes) !== upload.sha256) {
    throw new ConversationStateError(`attachment ${name} checksum is invalid`);
  }
  const mediaType = safeMediaType(upload.mediaType);
  return { path, mediaType, batch: { paths: [...batch.paths, path], totalBytes } };
}

export function publishedAttachment(
  plan: AttachmentUploadPlan,
  bytes: number,
  createdAt: string,
  sourceRunId: string,
  file: ArtifactReference,
): PublishedArtifact {
  return { id: artifactIdForPath(plan.path), path: plan.path, mediaType: plan.mediaType, bytes, createdAt, sourceRunId, file };
}

export function attachmentManifestPlan(
  ownerHash: string,
  conversationHash: string,
  messageHash: string,
  files: PublishedArtifact[],
): { key: string; encoded: string } {
  const catalog: ArtifactCatalog = { version: '1', files };
  validateConversationArtifactCatalog(catalog, 'attachments are invalid');
  const encoded = canonicalJson(catalog);
  return {
    key: `owners/${ownerHash}/conversations/${conversationHash}/attachment-manifests/${messageHash}-${digest(encoded)}.json`,
    encoded,
  };
}

/** Merge validated catalogs without changing their records or silently replacing conflicting content. */
export function mergeAttachmentCatalog(previous: ArtifactCatalog, files: readonly PublishedArtifact[]): ArtifactCatalog {
  const byPath = new Map(previous.files.map((file) => [file.path, file]));
  for (const file of files) {
    const existing = byPath.get(file.path);
    if (existing && canonicalJson(existing) !== canonicalJson(file)) {
      throw new ConversationConflictError(`artifact path ${file.path} already has different content`);
    }
    byPath.set(file.path, file);
  }
  return { version: '1', files: [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path)) };
}

function safeUploadName(value: string): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > 255) {
    throw new ConversationStateError('attachment name must be 1-255 bytes');
  }
  const name = value.normalize('NFKC').trim();
  if (name === '.' || name === '..' || /[\\/\0-\x1f\x7f]/.test(name)) {
    throw new ConversationStateError(`attachment name ${JSON.stringify(value)} is invalid`);
  }
  return name;
}

function safeMediaType(value: string): string {
  const mediaType = typeof value === 'string' && value.trim()
    ? value.trim().toLowerCase()
    : 'application/octet-stream';
  if (mediaType.length > 128 || /[\r\n]/.test(mediaType) || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mediaType)) {
    throw new ConversationStateError('attachment media type is invalid');
  }
  return mediaType;
}
