import { randomBytes } from 'node:crypto';
import type { ArtifactReference } from '../domain/contracts.js';
import type { PublicationGrantStore } from './publication-service.js';
import { PublicationService, type PublicationObjectStore } from './publication-service.js';
import { publicationDescriptor, publicationDomain, publicationGrant, publicationTtlSeconds, validatePublicationTokenSuffix } from './publication-sharing.js';
import { sessionPublicationPlan, sessionPublicationRequest } from './session-publication-planning.js';
import type { SessionService } from './session-service.js';

export class SessionPublicationService {
  public constructor(private readonly options: {
    sessions: Pick<SessionService, 'publicationArtifacts'>;
    objects: PublicationObjectStore;
    grants: PublicationGrantStore;
    readPrefix(reference: ArtifactReference): Promise<Uint8Array>;
    artifactBucket: string;
    baseDomain: string;
    ttlSeconds: number;
    now?: () => Date;
    randomToken?: () => string;
  }) {}

  public async publish(ownerId: string, sessionId: string, raw: unknown) {
    const request = sessionPublicationRequest(raw);
    const domain = publicationDomain(this.options.baseDomain);
    const ttlSeconds = publicationTtlSeconds(this.options.ttlSeconds);
    const saved = await this.options.sessions.publicationArtifacts(ownerId, sessionId, request.files.map((file) => file.artifact_id));
    // Validate the entire reference set before any object read or external publication write.
    sessionPublicationPlan({ ownerId, sessionId, artifactBucket: this.options.artifactBucket, request, sources: saved.map((entry) => ({ saved: entry, prefix: new Uint8Array() })) });
    const sources = [];
    for (const entry of saved) sources.push({ saved: entry, prefix: entry.artifact.size_bytes === 0 ? new Uint8Array() : await this.options.readPrefix(entry.content) });
    const plan = sessionPublicationPlan({ ownerId, sessionId, artifactBucket: this.options.artifactBucket, request, sources });
    const published = await new PublicationService(this.options.objects).publish({ ownerId, publicationId: plan.publicationId, spec: request.publication,
      files: plan.files, sessionId, artifactIds: plan.artifactIds, createdAt: plan.createdAt,
    });
    const tokenSuffix = this.options.randomToken?.() ?? randomBytes(32).toString('hex');
    validatePublicationTokenSuffix(tokenSuffix);
    const grant = publicationGrant({ publicationId: plan.publicationId, ownerHash: plan.ownerHash, tokenSuffix, now: this.options.now?.() ?? new Date(), ttlSeconds });
    await this.options.grants.put({ version: '2', kind: published.manifest.kind, grant: { ...grant } });
    return publicationDescriptor(published.manifest, grant, domain);
  }
}
