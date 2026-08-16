import { createHash, randomBytes } from 'node:crypto';
import { validateArtifactCatalog } from '../domain/artifacts.js';
import type { ArtifactCatalog } from '../domain/contracts.js';
import type {
  PublicationDescriptor,
  PublicationShare,
  PublicationSpec,
  ShareGrant,
} from '../domain/publications.js';
import { validatePublicationId } from '../domain/publications.js';
import {
  PublicationService,
  type PublicationObjectStore,
  type PublicationSourceFile,
} from './publication-service.js';

export interface PublicationGrantStore {
  put(share: PublicationShare): Promise<void>;
}

export interface PublicationPublisherOptions {
  artifactBucket: string;
  baseDomain: string;
  ttlSeconds: number;
  now?: () => Date;
  randomToken?: () => string;
}

export interface PublishCatalogInput {
  ownerId: string;
  spec: PublicationSpec;
  catalog: ArtifactCatalog;
  runId: string;
  conversationId?: string;
}

/** Publishes trusted catalog entries and creates a time-bounded bearer grant. */
export class PublicationPublisher {
  private readonly service: PublicationService;
  private readonly baseDomain: string;
  private readonly ttlSeconds: number;
  private readonly now: () => Date;
  private readonly randomToken: () => string;

  public constructor(
    objects: PublicationObjectStore,
    private readonly grants: PublicationGrantStore,
    private readonly options: PublicationPublisherOptions,
  ) {
    this.service = new PublicationService(objects);
    this.baseDomain = publicationDomain(options.baseDomain);
    this.ttlSeconds = publicationTtlSeconds(options.ttlSeconds);
    this.now = options.now ?? (() => new Date());
    this.randomToken = options.randomToken ?? (() => randomBytes(32).toString('hex'));
  }

  public async publish(input: PublishCatalogInput): Promise<PublicationDescriptor> {
    validateArtifactCatalog(input.catalog);
    const ownerHash = createHash('sha256').update(input.ownerId).digest('hex').slice(0, 32);
    const files = publicationSourceFiles(
      input.catalog,
      this.options.artifactBucket,
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
    const published = await this.service.publish({
      ownerId: input.ownerId,
      publicationId,
      spec: input.spec,
      files,
      runId: input.runId,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      createdAt: publicationCreatedAt(input.catalog, relevant),
    });

    const tokenSuffix = this.randomToken();
    if (!/^[a-f0-9]{64}$/.test(tokenSuffix)) {
      throw new Error('publication token generator returned an invalid token');
    }
    const expiresAt = new Date(this.now().getTime() + this.ttlSeconds * 1_000).toISOString();
    const token = `${ownerHash}-${tokenSuffix}`;
    const grant: ShareGrant = {
      version: '1',
      id: token,
      publicationId,
      ownerHash,
      access: 'bearer',
      expiresAt,
    };
    await this.grants.put({ version: '2', kind: published.manifest.kind, grant });

    return {
      publicationId,
      kind: published.manifest.kind,
      url: `https://${publicationHost(publicationId, ownerHash, this.baseDomain)}/__share/${token}`,
      expiresAt,
      entrypoint: published.manifest.entrypoint,
      ...(published.manifest.primaryPath ? { primaryPath: published.manifest.primaryPath } : {}),
      paths: published.manifest.files.map((file) => file.path),
    };
  }
}

export function publicationTtlSeconds(configured: string | number | undefined): number {
  const seconds = Number(configured ?? 86_400);
  if (!Number.isFinite(seconds)) return 86_400;
  return Math.max(60, Math.min(86_400, Math.floor(seconds)));
}

export function relevantPublicationFiles(
  spec: PublicationSpec,
  files: readonly PublicationSourceFile[],
): PublicationSourceFile[] {
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
  const relevantPaths = new Set(relevantPublicationFiles(
    spec,
    catalog.files.map((file) => ({
      path: file.path,
      blob: {
        id: file.file.key,
        digest: `sha256:${file.file.sha256}`,
        size: file.bytes,
        mediaType: file.mediaType,
      },
    })),
  ).map((file) => file.path));
  return catalog.files
    .filter((file) => relevantPaths.has(file.path))
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

function publicationDomain(value: string): string {
  const domain = value.toLowerCase().replace(/^\.+|\.+$/g, '');
  if (
    domain.length > 253 ||
    !domain.includes('.') ||
    domain.split('.').some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) throw new Error('publication base domain is invalid');
  return domain;
}
