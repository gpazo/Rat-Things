import { randomBytes } from 'node:crypto';
import type { ArtifactCatalog } from '../domain/contracts.js';
import type {
  PublicationDescriptor,
  PublicationShare,
  PublicationSpec,
} from '../domain/publications.js';
import {
  PublicationService,
  type PublicationObjectStore,
} from './publication-service.js';
import {
  publicationCatalogPlan,
  publicationDescriptor,
  publicationDomain,
  publicationGrant,
  publicationTtlSeconds,
  validatePublicationTokenSuffix,
} from './publication-sharing.js';

export {
  latestPublicationSourceRunId,
  publicationTtlSeconds,
  relevantPublicationFiles,
} from './publication-sharing.js';

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
    const plan = publicationCatalogPlan({
      ownerId: input.ownerId,
      catalog: input.catalog,
      spec: input.spec,
      artifactBucket: this.options.artifactBucket,
    });
    const published = await this.service.publish({
      ownerId: input.ownerId,
      publicationId: plan.publicationId,
      spec: input.spec,
      files: plan.files,
      runId: input.runId,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      createdAt: plan.createdAt,
    });

    const tokenSuffix = this.randomToken();
    validatePublicationTokenSuffix(tokenSuffix);
    const grant = publicationGrant({
      publicationId: plan.publicationId,
      ownerHash: plan.ownerHash,
      tokenSuffix,
      now: this.now(),
      ttlSeconds: this.ttlSeconds,
    });
    // Retain the link values even if the adapter changes its storage input.
    await this.grants.put({ version: '2', kind: published.manifest.kind, grant: { ...grant } });

    return publicationDescriptor(published.manifest, grant, this.baseDomain);
  }
}
