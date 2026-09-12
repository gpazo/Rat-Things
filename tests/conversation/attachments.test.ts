import { describe, expect, it } from 'vitest';
import {
  attachmentManifestPlan,
  MAX_CONVERSATION_UPLOAD_FILE_BYTES,
  MAX_CONVERSATION_UPLOAD_FILES,
  MAX_CONVERSATION_UPLOAD_TOTAL_BYTES,
  mergeAttachmentCatalog,
  planAttachmentUpload,
  publishedAttachment,
  validateAttachmentInput,
  type ConversationAttachmentUpload,
} from '../../src/conversation/attachments.js';
import * as serviceExports from '../../src/conversation/service.js';
import { ConversationConflictError, ConversationStateError } from '../../src/conversation/types.js';
import { artifactIdForPath, validateArtifactCatalog } from '../../src/domain/artifacts.js';
import type { PublishedArtifact } from '../../src/domain/contracts.js';
import { canonicalJson, sha256Hex } from '../../src/domain/json.js';
import { artifact, freeze, timestamp } from './fixtures.js';

const messageHash = sha256Hex('message-1').slice(0, 32);
const emptyBatch = freeze({ paths: [] as string[], totalBytes: 0 });

function upload(overrides: Partial<ConversationAttachmentUpload> = {}): ConversationAttachmentUpload {
  const bytes = overrides.bytes ?? Buffer.from('saved content');
  return { name: 'notes.txt', mediaType: 'text/plain', bytes, sha256: sha256Hex(bytes), ...overrides };
}

function published(path: string): PublishedArtifact {
  return { id: artifactIdForPath(path), path, bytes: 0, mediaType: 'text/plain', createdAt: timestamp,
    sourceRunId: 'run-1', file: artifact(path) };
}

describe('attachment upload planning', () => {
  it('normalizes names and media types while returning fresh batch state', () => {
    const first = Object.freeze(upload({ name: '  ｎｏｔｅｓ.txt  ', mediaType: ' Text/Plain ' }));
    const bytes = Buffer.from(first.bytes);
    const plan = planAttachmentUpload(first, messageHash, emptyBatch);
    const path = `uploads/${messageHash.slice(0, 12)}/notes.txt`;
    expect(plan).toEqual({ path, mediaType: 'text/plain', batch: { paths: [path], totalBytes: bytes.length } });
    const next = planAttachmentUpload(upload({ name: 'second.txt', bytes: Buffer.alloc(0), mediaType: '' }), messageHash, freeze(plan.batch));
    expect(next.mediaType).toBe('application/octet-stream');
    expect(next.batch).toEqual({ paths: [path, `uploads/${messageHash.slice(0, 12)}/second.txt`], totalBytes: bytes.length });
    expect(next.batch.paths).not.toBe(plan.batch.paths);
    expect(plan.batch.paths).toEqual([path]);
    expect(emptyBatch).toEqual({ paths: [], totalBytes: 0 });
    expect(first.bytes).toEqual(bytes);
    expect(first.name).toBe('  ｎｏｔｅｓ.txt  ');
  });

  it('rejects a normalized duplicate before inspecting size, checksum, or media type', () => {
    const first = planAttachmentUpload(upload(), messageHash, emptyBatch);
    const batch = freeze(first.batch);
    expect(() => planAttachmentUpload(upload({
      name: 'ｎｏｔｅｓ.txt', bytes: Buffer.alloc(MAX_CONVERSATION_UPLOAD_FILE_BYTES + 1), sha256: 'invalid', mediaType: 'invalid',
    }), messageHash, batch)).toThrow('attachment name notes.txt is duplicated');
    expect(batch).toEqual(first.batch);
  });

  it.each(['../notes.txt', 'folder/notes.txt', 'folder\\notes.txt', '..', 'bad\nname'])('rejects unsafe filename %j', (name) => {
    expect(() => planAttachmentUpload(upload({ name }), messageHash, emptyBatch)).toThrow(ConversationStateError);
  });

  it('accepts exact file and batch limits and rejects excess before checking the digest', () => {
    const first = planAttachmentUpload(upload({ bytes: Buffer.alloc(MAX_CONVERSATION_UPLOAD_FILE_BYTES) }), messageHash, emptyBatch);
    const second = planAttachmentUpload(upload({
      name: 'second.txt', bytes: Buffer.alloc(MAX_CONVERSATION_UPLOAD_TOTAL_BYTES - MAX_CONVERSATION_UPLOAD_FILE_BYTES),
    }), messageHash, freeze(first.batch));
    expect(second.batch.totalBytes).toBe(MAX_CONVERSATION_UPLOAD_TOTAL_BYTES);
    expect(() => planAttachmentUpload(upload({
      name: 'third.txt', bytes: Buffer.alloc(1), sha256: 'invalid',
    }), messageHash, freeze(second.batch))).toThrow('attachments exceed 6291456 bytes');
    expect(() => planAttachmentUpload(upload({
      bytes: Buffer.alloc(MAX_CONVERSATION_UPLOAD_FILE_BYTES + 1), sha256: 'invalid',
    }), messageHash, emptyBatch)).toThrow('attachment notes.txt exceeds 4194304 bytes');
  });

  it('checks the digest before the media type and rejects media type parameters', () => {
    expect(() => planAttachmentUpload(upload({ sha256: 'a'.repeat(64), mediaType: 'invalid' }), messageHash, emptyBatch))
      .toThrow('attachment notes.txt checksum is invalid');
    expect(() => planAttachmentUpload(upload({ mediaType: 'text/plain; charset=utf-8' }), messageHash, emptyBatch))
      .toThrow('attachment media type is invalid');
  });

  it('checks batch size and required identities without inspecting file contents', () => {
    const input = { conversationId: 'conversation-1', ownerId: 'owner-1', messageId: 'message-1', sourceRunId: 'invalid:run',
      uploads: [upload({ name: '..', sha256: 'invalid' })] };
    expect(() => validateAttachmentInput(input)).not.toThrow();
    expect(() => validateAttachmentInput({ ...input, ownerId: '' })).toThrow('ownerId is required');
    expect(() => validateAttachmentInput({ ...input, uploads: [] })).toThrow('attachments must contain 1-6 files');
    expect(() => validateAttachmentInput({ ...input, uploads: Array.from({ length: 7 }, () => upload()) }))
      .toThrow('attachments must contain 1-6 files');
    expect(serviceExports.MAX_CONVERSATION_UPLOAD_FILES).toBe(MAX_CONVERSATION_UPLOAD_FILES);
    expect(serviceExports.MAX_CONVERSATION_UPLOAD_FILE_BYTES).toBe(MAX_CONVERSATION_UPLOAD_FILE_BYTES);
    expect(serviceExports.MAX_CONVERSATION_UPLOAD_TOTAL_BYTES).toBe(MAX_CONVERSATION_UPLOAD_TOTAL_BYTES);
  });
});

describe('attachment manifests and catalog merging', () => {
  it('constructs a canonical manifest from published references, preserving zero-byte files', () => {
    const plan = freeze(planAttachmentUpload(upload({ bytes: Buffer.alloc(0) }), messageHash, emptyBatch));
    const reference = freeze(artifact('empty-file'));
    const file = publishedAttachment(plan, 0, timestamp, 'run-1', reference);
    expect(file).toEqual({ id: artifactIdForPath(plan.path), path: plan.path, mediaType: 'text/plain',
      bytes: 0, createdAt: timestamp, sourceRunId: 'run-1', file: reference });
    expect(file.file).toBe(reference);
    const files = freeze([file]);
    const manifest = attachmentManifestPlan('owner-hash', 'conversation-hash', messageHash, files);
    const catalog = { version: '1', files };
    expect(manifest.encoded).toBe(canonicalJson(catalog));
    expect(manifest.key).toBe(`owners/owner-hash/conversations/conversation-hash/attachment-manifests/${messageHash}-${sha256Hex(manifest.encoded)}.json`);
    expect(() => validateArtifactCatalog(JSON.parse(manifest.encoded))).not.toThrow();
    expect(() => attachmentManifestPlan('owner', 'conversation', messageHash, [{ ...file, sourceRunId: 'invalid:run' }]))
      .toThrow(ConversationStateError);
  });

  it('merges sorted records without mutating inputs and accepts identical retried records', () => {
    const previous = freeze({ version: '1' as const, files: [published('z.txt')] });
    const incoming = freeze([published('a.txt'), structuredClone(previous.files[0]!)]);
    const before = structuredClone({ previous, incoming });
    const merged = mergeAttachmentCatalog(previous, incoming);
    expect(merged.files.map(({ path }) => path)).toEqual(['a.txt', 'z.txt']);
    expect(merged.files).not.toBe(previous.files);
    expect(mergeAttachmentCatalog(freeze(merged), incoming)).toEqual(merged);
    expect({ previous, incoming }).toEqual(before);
    expect(mergeAttachmentCatalog({ version: '1', files: [] }, [])).toEqual({ version: '1', files: [] });
  });

  it.each([
    { createdAt: '2026-08-04T12:00:00.000Z' },
    { sourceRunId: 'run-2' },
    { file: artifact('different-blob') },
  ])('rejects changed metadata or content at an existing path: %j', (change) => {
    const previous = freeze({ version: '1' as const, files: [published('notes.txt')] });
    const files = freeze([{ ...previous.files[0]!, ...change }]);
    expect(() => mergeAttachmentCatalog(previous, files)).toThrow(ConversationConflictError);
    expect(previous.files).toEqual([published('notes.txt')]);
  });
});
