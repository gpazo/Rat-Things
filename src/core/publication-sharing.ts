import { createHash } from 'node:crypto';
import { validateArtifactCatalog } from '../domain/artifacts.js';
import type { ArtifactCatalog } from '../domain/contracts.js';
import type {
  PublicationDescriptor,
  PublicationManifest,
  PublicationSpec,
  ShareGrant,
} from '../domain/publications.js';
import { validatePublicationId } from '../domain/publications.js';
import type { PublicationSourceFile } from './publication-planning.js';

export interface PublicationCatalogPlan {
  ownerHash: string;
  publicationId: string;
  files: PublicationSourceFile[];
  createdAt: string;
}

/** Validates every catalog entry before selecting the content that determines the identity. */
export function publicationCatalogPlan(input: {
  ownerId: string;
  catalog: ArtifactCatalog;
  spec: PublicationSpec;
  artifactBucket: string;
}): PublicationCatalogPlan {
  validateArtifactCatalog(input.catalog);
  const ownerHash = createHash('sha256').update(input.ownerId).digest('hex').slice(0, 32);
  const files = publicationSourceFiles(
    input.catalog,
    input.artifactBucket,
    ownerHash,
  );
  const relevant = relevantPublicationFiles(input.spec, files);
  const publicationId = createHash('sha256').update(JSON.stringify({
    format: 'rat-things-publication-v3',
    spec: canonicalPublicationSpec(input.spec),
    files: relevant
      .map((file) => ({
        path: file.path,
        digest: file.blob.digest,
        mediaType: file.blob.mediaType,
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  })).digest('hex').slice(0, 24);
  return { ownerHash, publicationId, files, createdAt: publicationCreatedAt(input.catalog, relevant) };
}

export function validatePublicationTokenSuffix(tokenSuffix: string): void {
  if (!/^[a-f0-9]{64}$/.test(tokenSuffix)) {
    throw new Error('publication token generator returned an invalid token');
  }
}

export function publicationGrant(input: {
  publicationId: string;
  ownerHash: string;
  tokenSuffix: string;
  now: Date;
  ttlSeconds: number;
}): ShareGrant {
  return {
    version: '1',
    id: `${input.ownerHash}-${input.tokenSuffix}`,
    publicationId: input.publicationId,
    ownerHash: input.ownerHash,
    access: 'bearer',
    expiresAt: new Date(input.now.getTime() + input.ttlSeconds * 1_000).toISOString(),
  };
}

export function publicationDescriptor(
  manifest: PublicationManifest,
  grant: ShareGrant,
  domain: string,
): PublicationDescriptor {
  return {
    publicationId: grant.publicationId,
    kind: manifest.kind,
    url: `https://${publicationHost(grant.publicationId, grant.ownerHash, domain)}/__share/${grant.id}`,
    expiresAt: grant.expiresAt,
    entrypoint: manifest.entrypoint,
    ...(manifest.primaryPath ? { primaryPath: manifest.primaryPath } : {}),
    paths: manifest.files.map((file) => file.path),
  };
}

export function publicationTtlSeconds(configured: string | number | undefined): number {
  const seconds = Number(configured ?? 86_400);
  if (!Number.isFinite(seconds)) return 86_400;
  return Math.max(60, Math.min(86_400, Math.floor(seconds)));
}

export function relevantPublicationFiles<T extends { path: string }>(
  spec: PublicationSpec,
  files: readonly T[],
): T[] {
  if (spec.kind === 'file') return files.filter((file) => file.path === spec.path);
  if (spec.kind === 'video') {
    return files.filter((file) => file.path === spec.path || file.path === spec.poster);
  }
  const prefix = spec.root ? `${spec.root}/` : '';
  return files.filter((file) => !prefix || file.path.startsWith(prefix));
}

export function latestPublicationSourceRunId(
  catalog: ArtifactCatalog,
  spec: PublicationSpec,
): string {
  return relevantPublicationFiles(spec, catalog.files)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]?.sourceRunId ??
      'conversation-publication';
}

function publicationSourceFiles(
  catalog: ArtifactCatalog,
  bucket: string,
  ownerHash: string,
): PublicationSourceFile[] {
  return catalog.files.map((file) => {
    const ownerPrefix = `owners/${ownerHash}/`;
    const ownerScoped = file.file.key.startsWith(`${ownerPrefix}runs/`) ||
      new RegExp(`^${ownerPrefix}blobs/sha256/[a-f0-9]{64}$`).test(file.file.key);
    if (file.file.bucket !== bucket || !ownerScoped) {
      throw new Error(`artifact ${file.id} is outside its owner scope`);
    }
    return {
      path: file.path,
      blob: {
        id: file.file.key,
        digest: `sha256:${file.file.sha256}`,
        size: file.bytes,
        mediaType: file.mediaType,
      },
    };
  });
}

function canonicalPublicationSpec(spec: PublicationSpec): Record<string, string> {
  if (spec.kind === 'site') {
    return {
      version: spec.version,
      kind: spec.kind,
      root: spec.root ?? '',
      entrypoint: spec.entrypoint ?? 'index.html',
      title: spec.title ?? '',
    };
  }
  if (spec.kind === 'video') {
    return {
      version: spec.version,
      kind: spec.kind,
      path: spec.path,
      poster: spec.poster ?? '',
      title: spec.title ?? '',
    };
  }
  return {
    version: spec.version,
    kind: spec.kind,
    path: spec.path,
    title: spec.title ?? '',
  };
}

function publicationCreatedAt(
  catalog: ArtifactCatalog,
  files: readonly PublicationSourceFile[],
): string {
  const paths = new Set(files.map((file) => file.path));
  return catalog.files
    .filter((file) => paths.has(file.path))
    .map((file) => file.createdAt)
    .sort((left, right) => right.localeCompare(left))[0] ?? new Date(0).toISOString();
}

function publicationHost(publicationId: string, ownerHash: string, domain: string): string {
  validatePublicationId(publicationId);
  if (!/^[a-f0-9]{32}$/.test(ownerHash)) throw new Error('publication owner hash is invalid');
  return `${publicationId}-${ownerHash}.${domain}`;
}

export function publicationDomain(value: string): string {
  const domain = value.toLowerCase().replace(/^\.+|\.+$/g, '');
  if (
    domain.length > 253 ||
    !domain.includes('.') ||
    domain.split('.').some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) throw new Error('publication base domain is invalid');
  return domain;
}
