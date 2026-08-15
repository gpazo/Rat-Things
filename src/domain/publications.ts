import { MAX_ARTIFACT_FILES, validateArtifactPath } from './artifacts.js';

export type Result<TValue, TError> =
  | { ok: true; value: TValue }
  | { ok: false; error: TError };

export type PublicationKind = 'file' | 'site' | 'video';

export type PublicationSpec =
  | {
      version: '1';
      kind: 'file';
      path: string;
      title?: string;
    }
  | {
      version: '1';
      kind: 'site';
      root?: string;
      entrypoint?: string;
      title?: string;
    }
  | {
      version: '1';
      kind: 'video';
      path: string;
      poster?: string;
      title?: string;
    };

/** A provider-neutral reference to immutable bytes. Its id is opaque outside storage adapters. */
export interface BlobReference {
  id: string;
  digest: `sha256:${string}`;
  size: number;
  mediaType: string;
}

export interface PublicationFile {
  path: string;
  blob: BlobReference;
}

export interface PublicationProvenance {
  runId: string;
  conversationId?: string;
  builder: string;
  createdAt: string;
}

/** Committed last; its existence is the ready marker for an immutable publication. */
export interface PublicationManifest {
  version: '1';
  publicationId: string;
  kind: PublicationKind;
  entrypoint: 'index.html';
  primaryPath?: string;
  files: PublicationFile[];
  provenance: PublicationProvenance;
}

export type PublicationErrorCode =
  | 'invalid_request'
  | 'invalid_path'
  | 'not_found'
  | 'path_collision'
  | 'unsupported_media'
  | 'storage';

export interface PublicationDiagnostic {
  code: Exclude<PublicationErrorCode, 'storage'>;
  message: string;
  path?: string;
}

export class PublicationError extends Error {
  public constructor(
    public readonly code: PublicationErrorCode,
    message: string,
    options?: { cause?: Error; diagnostics?: PublicationDiagnostic[] },
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = 'PublicationError';
    this.diagnostics = options?.diagnostics;
  }

  public readonly diagnostics: PublicationDiagnostic[] | undefined;
}

export interface ShareGrant {
  version: '1';
  id: string;
  publicationId: string;
  ownerHash: string;
  access: 'bearer';
  expiresAt: string;
  revokedAt?: string;
}

const PUBLICATION_ID_PATTERN = /^[a-f0-9]{24}$/;
const OWNER_HASH_PATTERN = /^[a-f0-9]{32}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

export function validatePublicationId(value: string): void {
  if (!PUBLICATION_ID_PATTERN.test(value)) {
    throw new PublicationError('invalid_request', 'publication id must be 24 lowercase hexadecimal characters');
  }
}

export function parsePublicationSpec(value: unknown): PublicationSpec {
  if (!isRecord(value)) throw new PublicationError('invalid_request', 'publication request must be an object');
  rejectUnknown(value, ['version', 'kind', 'path', 'root', 'entrypoint', 'poster', 'title']);
  if (value.version !== '1') throw new PublicationError('invalid_request', 'publication version must be "1"');
  if (!['file', 'site', 'video'].includes(String(value.kind))) {
    throw new PublicationError('invalid_request', 'publication kind must be file, site, or video');
  }
  const title = optionalTitle(value.title);
  if (value.kind === 'site') {
    if (value.path !== undefined || value.poster !== undefined) {
      throw new PublicationError('invalid_request', 'site publications do not accept path or poster');
    }
    const root = optionalPath(value.root, 'root');
    const entrypoint = optionalPath(value.entrypoint, 'entrypoint');
    return {
      version: '1',
      kind: 'site',
      ...(root ? { root } : {}),
      ...(entrypoint ? { entrypoint } : {}),
      ...(title ? { title } : {}),
    };
  }
  if (value.root !== undefined || value.entrypoint !== undefined) {
    throw new PublicationError('invalid_request', `${value.kind} publications do not accept root or entrypoint`);
  }
  const path = requiredPath(value.path, 'path');
  if (value.kind === 'file') {
    if (value.poster !== undefined) {
      throw new PublicationError('invalid_request', 'file publications do not accept poster');
    }
    return { version: '1', kind: 'file', path, ...(title ? { title } : {}) };
  }
  const poster = optionalPath(value.poster, 'poster');
  return {
    version: '1',
    kind: 'video',
    path,
    ...(poster ? { poster } : {}),
    ...(title ? { title } : {}),
  };
}

export function validateBlobReference(value: BlobReference): void {
  if (
    typeof value.id !== 'string' ||
    !value.id ||
    value.id.length > 1_024 ||
    !DIGEST_PATTERN.test(value.digest) ||
    !Number.isSafeInteger(value.size) ||
    value.size < 0 ||
    typeof value.mediaType !== 'string' ||
    !value.mediaType ||
    value.mediaType.length > 128 ||
    /[\r\n]/.test(value.mediaType)
  ) throw new PublicationError('invalid_request', 'publication contains an invalid blob reference');
}

export function validatePublicationManifest(value: PublicationManifest): void {
  validatePublicationId(value.publicationId);
  if (
    value.version !== '1' ||
    !['file', 'site', 'video'].includes(value.kind) ||
    value.entrypoint !== 'index.html' ||
    !Array.isArray(value.files) ||
    value.files.length === 0 ||
    value.files.length > MAX_ARTIFACT_FILES
  ) throw new PublicationError('invalid_request', 'publication manifest is invalid');
  const paths = new Set<string>();
  for (const file of value.files) {
    try {
      validateArtifactPath(file.path);
    } catch (error) {
      throw new PublicationError(
        'invalid_path',
        `invalid publication path ${JSON.stringify(file.path)}`,
        error instanceof Error ? { cause: error } : undefined,
      );
    }
    if (paths.has(file.path)) {
      throw new PublicationError('path_collision', `duplicate publication path ${file.path}`);
    }
    validateBlobReference(file.blob);
    paths.add(file.path);
  }
  if (!paths.has(value.entrypoint)) {
    throw new PublicationError('invalid_request', 'publication entrypoint is missing from its manifest');
  }
  if (
    value.primaryPath !== undefined &&
    (typeof value.primaryPath !== 'string' || !paths.has(value.primaryPath))
  ) {
    throw new PublicationError('invalid_request', 'publication primary path is missing from its manifest');
  }
  if (
    !value.provenance ||
    typeof value.provenance.runId !== 'string' ||
    !value.provenance.runId ||
    typeof value.provenance.builder !== 'string' ||
    !value.provenance.builder ||
    !Number.isFinite(Date.parse(value.provenance.createdAt))
  ) throw new PublicationError('invalid_request', 'publication provenance is invalid');
}

export function validateShareGrant(value: ShareGrant): void {
  validatePublicationId(value.publicationId);
  if (
    value.version !== '1' ||
    typeof value.id !== 'string' ||
    !value.id ||
    value.id.length > 256 ||
    /[\0-\x1f\x7f]/.test(value.id) ||
    !OWNER_HASH_PATTERN.test(value.ownerHash) ||
    value.access !== 'bearer' ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    (value.revokedAt !== undefined && !Number.isFinite(Date.parse(value.revokedAt)))
  ) throw new PublicationError('invalid_request', 'share grant is invalid');
}

function requiredPath(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new PublicationError('invalid_request', `publication ${label} must be a string`);
  }
  try {
    validateArtifactPath(value);
  } catch (error) {
    throw new PublicationError(
      'invalid_path',
      `publication ${label} is invalid`,
      error instanceof Error ? { cause: error } : undefined,
    );
  }
  return value;
}

function optionalPath(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : requiredPath(value, label);
}

function optionalTitle(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > 500) {
    throw new PublicationError('invalid_request', 'publication title must be 1-500 UTF-8 bytes');
  }
  return value.trim();
}

function rejectUnknown(value: Record<string, unknown>, allowed: string[]): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new PublicationError('invalid_request', `publication request contains unknown field ${unknown}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
