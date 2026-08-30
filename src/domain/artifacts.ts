import { createHash } from 'node:crypto';
import type { ArtifactCatalog } from './contracts.js';

export const MAX_ARTIFACT_FILES = 5_000;
// Keep the domain limit aligned with the S3 CopyObject backend constraint.
export const MAX_ARTIFACT_FILE_BYTES = 5 * 1024 * 1024 * 1024;
export const MAX_ARTIFACT_TOTAL_BYTES = 20 * 1024 * 1024 * 1024;
export const MAX_ARTIFACT_PATH_BYTES = 512;
export const MAX_ARTIFACT_CATALOG_BYTES = 8 * 1024 * 1024;

export function artifactIdForPath(path: string): string {
  return createHash('sha256').update(path).digest('hex').slice(0, 24);
}

export function validateArtifactPath(path: string): void {
  if (
    typeof path !== 'string' ||
    !path ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.split('/').some((part) => (
      !part || part === '.' || part === '..' || Buffer.byteLength(part, 'utf8') > 255
    )) ||
    Buffer.byteLength(path, 'utf8') > MAX_ARTIFACT_PATH_BYTES ||
    /[\0-\x1f\x7f]/.test(path)
  ) throw new Error(`invalid artifact path ${JSON.stringify(path)}`);
}

export function validateArtifactCatalog(value: unknown): asserts value is ArtifactCatalog {
  if (!isRecord(value) || value.version !== '1' || !Array.isArray(value.files)) {
    throw new Error('artifact catalog must be a version 1 file array');
  }
  if (value.files.length > MAX_ARTIFACT_FILES) {
    throw new Error(`artifact catalog exceeds ${MAX_ARTIFACT_FILES} files`);
  }
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_ARTIFACT_CATALOG_BYTES) {
    throw new Error(`artifact catalog exceeds ${MAX_ARTIFACT_CATALOG_BYTES} bytes`);
  }
  const ids = new Set<string>();
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const candidate of value.files) {
    if (!isRecord(candidate)) throw new Error('artifact catalog contains a non-object entry');
    validateArtifactPath(candidate.path as string);
    const path = candidate.path as string;
    if (
      candidate.id !== artifactIdForPath(path) ||
      ids.has(candidate.id as string) ||
      paths.has(path)
    ) throw new Error(`artifact catalog contains an invalid or duplicate entry for ${path}`);
    if (
      !Number.isInteger(candidate.bytes) ||
      (candidate.bytes as number) < 0 ||
      (candidate.bytes as number) > MAX_ARTIFACT_FILE_BYTES
    ) throw new Error(`artifact ${path} has an invalid size`);
    totalBytes += candidate.bytes as number;
    if (totalBytes > MAX_ARTIFACT_TOTAL_BYTES) {
      throw new Error(`artifact catalog exceeds ${MAX_ARTIFACT_TOTAL_BYTES} bytes`);
    }
    if (
      typeof candidate.mediaType !== 'string' ||
      !candidate.mediaType ||
      candidate.mediaType.length > 128 ||
      /[\r\n]/.test(candidate.mediaType)
    ) throw new Error(`artifact ${path} has an invalid media type`);
    if (typeof candidate.createdAt !== 'string' || !Number.isFinite(Date.parse(candidate.createdAt))) {
      throw new Error(`artifact ${path} has an invalid creation time`);
    }
    if (
      typeof candidate.sourceRunId !== 'string' ||
      !/^[A-Za-z0-9-]{1,128}$/.test(candidate.sourceRunId)
    ) throw new Error(`artifact ${path} has an invalid source run`);
    if (
      !isRecord(candidate.file) ||
      typeof candidate.file.bucket !== 'string' ||
      !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(candidate.file.bucket) ||
      typeof candidate.file.key !== 'string' ||
      !candidate.file.key ||
      Buffer.byteLength(candidate.file.key, 'utf8') > 1_024 ||
      typeof candidate.file.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(candidate.file.sha256)
    ) throw new Error(`artifact ${path} has an invalid storage reference`);
    ids.add(candidate.id as string);
    paths.add(path);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
