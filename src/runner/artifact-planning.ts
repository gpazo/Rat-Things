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

export function artifactPromptText(
  prompt: string,
  publicationEnabled: boolean,
): string {
  const instructions = [
    'Rat Things files:',
    `- Files available to this session are under ${AGENT_ARTIFACT_DIRECTORY}/.`,
    `- When write access is enabled, return or preserve a file by writing it under ${AGENT_ARTIFACT_DIRECTORY}/ using a clear relative filename.`,
    '- Managed runs catalog available files during finalization, including after a stopped or failed turn; durable conversations restore committed files when they resume, even in a replacement MicroVM. Abrupt termination can lose uncommitted files.',
    '- Mention the relative filename in your response. Do not create credentials or secrets there.',
  ];
  if (publicationEnabled) {
    instructions.push(
      'Rat Things sharing:',
      '- When the user asks you to share finished work, write .rat-things/share.json in addition to the files under .rat-things/artifacts/.',
      '- Use exactly {"version":"1","publications":[...]} where each publication is one of: {"version":"1","kind":"site","root":"site","entrypoint":"index.html","title":"Title"}, {"version":"1","kind":"file","path":"file.ext","title":"Title"}, or {"version":"1","kind":"video","path":"video.mp4","poster":"poster.jpg","title":"Title"}. Omit optional fields you do not need.',
      '- Publication paths are relative to .rat-things/artifacts/. The trusted runner publishes them and appends the real share links to your response. Never invent or guess a share URL.',
    );
  }
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

export function detectMediaType(bytes: Uint8Array, path: string): string {
  const value = Buffer.from(bytes);
  const extension = path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (value.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (value[0] === 0xff && value[1] === 0xd8 && value[2] === 0xff) return 'image/jpeg';
  if (value.subarray(0, 6).toString('ascii') === 'GIF87a' || value.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif';
  if (value.subarray(0, 4).toString('ascii') === 'RIFF' && value.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (value.subarray(0, 4).toString('ascii') === 'RIFF' && value.subarray(8, 12).toString('ascii') === 'WAVE') return 'audio/wav';
  if (value.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = value.subarray(8, 12).toString('ascii');
    if (['avif', 'avis'].includes(brand)) return 'image/avif';
    if (extension === 'm4a' || extension === 'm4b') return 'audio/mp4';
    if (extension === 'mov') return 'video/quicktime';
    return 'video/mp4';
  }
  if (value.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'video/webm';
  if (value.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  if (value.subarray(0, 3).toString('ascii') === 'ID3') return 'audio/mpeg';
  if (value.subarray(0, 4).toString('ascii') === 'OggS') {
    return extension === 'ogv' ? 'video/ogg' : 'audio/ogg';
  }
  const textual: Record<string, string> = {
    css: 'text/css; charset=utf-8',
    csv: 'text/csv; charset=utf-8',
    htm: 'text/html; charset=utf-8',
    html: 'text/html; charset=utf-8',
    js: 'text/javascript; charset=utf-8',
    json: 'application/json',
    m3u8: 'application/vnd.apple.mpegurl',
    md: 'text/markdown; charset=utf-8',
    mjs: 'text/javascript; charset=utf-8',
    svg: 'image/svg+xml',
    txt: 'text/plain; charset=utf-8',
    vtt: 'text/vtt; charset=utf-8',
    webmanifest: 'application/manifest+json',
    xml: 'application/xml',
  };
  if (extension && textual[extension] && !value.includes(0)) return textual[extension];
  const binary: Record<string, string> = {
    ico: 'image/x-icon',
    mp3: 'audio/mpeg',
    oga: 'audio/ogg',
    ogg: 'audio/ogg',
    ogv: 'video/ogg',
    opus: 'audio/ogg',
    wasm: 'application/wasm',
    wav: 'audio/wav',
    woff: 'font/woff',
    woff2: 'font/woff2',
  };
  if (extension && binary[extension]) return binary[extension];
  return 'application/octet-stream';
}

export { agentProcessIdentity as artifactFileIdentity } from './agent-identity.js';
