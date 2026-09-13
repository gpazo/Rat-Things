import { createHash } from 'node:crypto';
import {
  artifactIdForPath,
  MAX_ARTIFACT_FILE_BYTES,
  MAX_ARTIFACT_TOTAL_BYTES,
  validateArtifactCatalog,
} from '../domain/artifacts.js';
import type { ArtifactCatalog, ArtifactReference, PublishedArtifact } from '../domain/contracts.js';

export const AGENT_ARTIFACT_DIRECTORY = '.rat-things/artifacts';

interface ArtifactPublicationValues {
  id: string;
  path: string;
  bytes: number;
  digest: string;
  mediaType: string;
  key: string;
}

export type ArtifactPublicationPlan = ArtifactPublicationValues & (
  | { kind: 'unchanged'; source: ArtifactReference; previous: PublishedArtifact }
  | { kind: 'copy'; source: ArtifactReference }
  | { kind: 'upload' }
);

/** Validates one filesystem observation before its bytes are read or stored. */
export function artifactByteTotal(
  path: string,
  observed: { regular: boolean; links: number; size: number },
  previousTotal: number,
): number {
  if (!observed.regular) throw new Error(`artifact ${path} is not a regular file`);
  if (observed.links !== 1) throw new Error(`artifact ${path} cannot be a hard link`);
  if (observed.size > MAX_ARTIFACT_FILE_BYTES) {
    throw new Error(`artifact ${path} exceeds ${MAX_ARTIFACT_FILE_BYTES} bytes`);
  }
  const total = previousTotal + observed.size;
  if (total > MAX_ARTIFACT_TOTAL_BYTES) {
    throw new Error(`artifact directory exceeds ${MAX_ARTIFACT_TOTAL_BYTES} bytes`);
  }
  return total;
}

export function planArtifactPublication(input: {
  ownerHash: string;
  path: string;
  bytes: number;
  digest: string;
  mediaType: string;
  previous?: PublishedArtifact;
  reusable?: ArtifactReference;
}): ArtifactPublicationPlan {
  const values: ArtifactPublicationValues = {
    id: artifactIdForPath(input.path),
    path: input.path,
    bytes: input.bytes,
    digest: input.digest,
    mediaType: input.mediaType,
    key: `owners/${input.ownerHash}/blobs/sha256/${input.digest}`,
  };
  if (input.previous?.bytes === input.bytes && input.previous.file.sha256 === input.digest) {
    return { ...values, kind: 'unchanged', source: input.previous.file, previous: input.previous };
  }
  return input.reusable
    ? { ...values, kind: 'copy', source: input.reusable }
    : { ...values, kind: 'upload' };
}

/** Verifies the stored bytes before projecting a catalog entry with retained or new provenance. */
export function completeArtifactPublication(
  plan: ArtifactPublicationPlan,
  file: ArtifactReference,
  runId: string,
  createdAt: string,
): PublishedArtifact {
  if (file.sha256 !== plan.digest) {
    throw new Error(`artifact ${plan.path} changed while it was being published`);
  }
  return plan.kind === 'unchanged'
    ? { ...plan.previous, file }
    : {
        id: plan.id,
        path: plan.path,
        mediaType: plan.mediaType,
        bytes: plan.bytes,
        createdAt,
        sourceRunId: runId,
        file,
      };
}

export function artifactOwnerHash(ownerId: string): string {
  return createHash('sha256').update(Buffer.from(ownerId)).digest('hex').slice(0, 32);
}

export function artifactPromptText(prompt: string): string {
  const instructions = [
    'Rat Things files:',
    `- Files available to this session are under ${AGENT_ARTIFACT_DIRECTORY}/.`,
    `- When write access is enabled, return or preserve a file by writing it under ${AGENT_ARTIFACT_DIRECTORY}/ using a clear relative filename.`,
    '- Private runs catalog available files during finalization, including after a stopped or failed turn. Abrupt termination can lose uncommitted files.',
    '- Mention the relative filename in your response. Do not create credentials or secrets there.',
  ];
  return [...instructions, 'User request:', prompt].join('\n\n');
}

export function emptyArtifactCatalog(): ArtifactCatalog {
  return { version: '1', files: [] };
}

export function assertArtifactCatalogScope(
  catalog: ArtifactCatalog,
  bucket: string,
  ownerId: string,
): void {
  validateArtifactCatalog(catalog);
  const ownerPrefix = `owners/${artifactOwnerHash(ownerId)}/`;
  for (const artifact of catalog.files) {
    const ownerScoped = artifact.file.key.startsWith(`${ownerPrefix}runs/`) ||
      new RegExp(`^${ownerPrefix}blobs/sha256/[a-f0-9]{64}$`).test(artifact.file.key);
    if (artifact.file.bucket !== bucket || !ownerScoped) {
      throw new Error(`artifact ${artifact.id} is outside its owner scope`);
    }
  }
}

export { detectMediaType } from '../domain/media-type.js';

export { agentProcessIdentity as artifactFileIdentity } from './agent-identity.js';
