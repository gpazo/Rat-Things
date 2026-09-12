import type {
  BlobReference,
  PublicationDiagnostic,
  PublicationFile,
  PublicationKind,
  PublicationManifest,
  PublicationSpec,
  Result,
} from '../domain/publications.js';
import {
  PublicationError,
  validateBlobReference,
  validatePublicationId,
  validatePublicationManifest,
} from '../domain/publications.js';
import type { Clock } from './ports.js';
import { filePublicationPlan, sitePublicationPlan, videoPublicationPlan } from './publication-builders.js';
import { publicationManifest, validatePublicationPlan } from './publication-planning.js';
import type { PublicationPlan, PublicationSourceFile } from './publication-planning.js';

export type {
  PlannedPublicationFile,
  PublicationPlan,
  PublicationSourceFile,
} from './publication-planning.js';

export interface PublicationBuilder {
  readonly kind: PublicationKind;
  readonly name: string;
  plan(
    spec: PublicationSpec,
    files: readonly PublicationSourceFile[],
  ): Promise<Result<PublicationPlan, PublicationDiagnostic[]>>;
}

export interface PublicationObjectStore {
  /** Returns an already committed immutable publication, when this adapter supports reuse. */
  getCommitted?(input: {
    ownerId: string;
    publicationId: string;
  }): Promise<PublishedPublication | undefined>;
  stageBlob(input: {
    ownerId: string;
    publicationId: string;
    path: string;
    source: BlobReference;
  }): Promise<BlobReference>;
  stageBytes(input: {
    ownerId: string;
    publicationId: string;
    path: string;
    bytes: Uint8Array;
    mediaType: string;
  }): Promise<BlobReference>;
  commit(input: {
    ownerId: string;
    manifest: PublicationManifest;
  }): Promise<BlobReference>;
}

export interface PublishInput {
  ownerId: string;
  publicationId: string;
  spec: PublicationSpec;
  files: readonly PublicationSourceFile[];
  runId: string;
  conversationId?: string;
  createdAt?: string;
}

export interface PublishedPublication {
  manifest: PublicationManifest;
  manifestBlob: BlobReference;
}

export class PublicationBuilderRegistry {
  private readonly builders = new Map<PublicationKind, PublicationBuilder>();

  public constructor(builders: readonly PublicationBuilder[]) {
    for (const builder of builders) {
      if (this.builders.has(builder.kind)) {
        throw new Error(`duplicate publication builder for ${builder.kind}`);
      }
      this.builders.set(builder.kind, builder);
    }
  }

  public get(kind: PublicationKind): PublicationBuilder {
    const builder = this.builders.get(kind);
    if (!builder) throw new PublicationError('unsupported_media', `no publication builder for ${kind}`);
    return builder;
  }
}

export class PublicationService {
  public constructor(
    private readonly store: PublicationObjectStore,
    private readonly builders = defaultPublicationBuilders(),
    private readonly clock: Clock = { now: () => new Date() },
  ) {}

  public async publish(input: PublishInput): Promise<PublishedPublication> {
    validatePublicationId(input.publicationId);
    for (const file of input.files) validateBlobReference(file.blob);
    try {
      const committed = await this.store.getCommitted?.({
        ownerId: input.ownerId,
        publicationId: input.publicationId,
      });
      if (committed) {
        validatePublicationManifest(committed.manifest);
        return committed;
      }
    } catch (error) {
      throw storageError('could not read committed publication', error);
    }
    const builder = this.builders.get(input.spec.kind);
    const planned = await builder.plan(input.spec, input.files);
    if (!planned.ok) {
      throw new PublicationError(
        planned.error[0]?.code ?? 'invalid_request',
        planned.error[0]?.message ?? 'publication could not be planned',
        { diagnostics: planned.error },
      );
    }

    validatePublicationPlan(planned.value, input.spec, input.files);

    const materialized: PublicationFile[] = [];
    for (const file of planned.value.files) {
      let blob: BlobReference;
      try {
        blob = file.source === 'blob'
          ? await this.store.stageBlob({
              ownerId: input.ownerId,
              publicationId: input.publicationId,
              path: file.path,
              source: file.blob,
            })
          : await this.store.stageBytes({
              ownerId: input.ownerId,
              publicationId: input.publicationId,
              path: file.path,
              bytes: file.bytes,
              mediaType: file.mediaType,
            });
      } catch (error) {
        throw storageError(`could not stage publication path ${file.path}`, error);
      }
      materialized.push({ path: file.path, blob });
    }

    const manifest = publicationManifest({
      publicationId: input.publicationId,
      plan: planned.value,
      files: materialized,
      runId: input.runId,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      builder: builder.name,
      createdAt: input.createdAt ?? this.clock.now().toISOString(),
    });
    // The manifest is the ready marker and must be committed after every referenced object.
    let manifestBlob: BlobReference;
    try {
      manifestBlob = await this.store.commit({ ownerId: input.ownerId, manifest });
    } catch (error) {
      throw storageError('could not commit publication manifest', error);
    }
    return { manifest, manifestBlob };
  }
}

function storageError(message: string, cause: unknown): PublicationError {
  return new PublicationError(
    'storage',
    message,
    cause instanceof Error ? { cause } : undefined,
  );
}

export function defaultPublicationBuilders(): PublicationBuilderRegistry {
  return new PublicationBuilderRegistry([
    {
      kind: 'file',
      name: 'rat-things/file@2',
      plan: async (spec, files) => filePublicationPlan(spec, files),
    },
    {
      kind: 'site',
      name: 'rat-things/site@1',
      plan: async (spec, files) => sitePublicationPlan(spec, files),
    },
    {
      kind: 'video',
      name: 'rat-things/video@2',
      plan: async (spec, files) => videoPublicationPlan(spec, files),
    },
  ]);
}
