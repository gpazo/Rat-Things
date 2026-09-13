import { createHash } from 'node:crypto';
import { MAX_ARTIFACT_FILES, validateArtifactPath } from '../domain/artifacts.js';
import { canonicalJson } from '../domain/json.js';
import { detectMediaType } from '../domain/media-type.js';
import { parsePublicationSpec, PublicationError, type PublicationSpec } from '../domain/publications.js';
import type { SavedSessionArtifact } from './session-ports.js';
import type { PublicationSourceFile } from './publication-planning.js';

export interface SessionPublicationRequest { publication: PublicationSpec; files: Array<{ artifact_id: string; path: string }> }

export function sessionPublicationRequest(raw: unknown): SessionPublicationRequest {
  if (!record(raw) || Object.keys(raw).some((key) => key !== 'publication' && key !== 'files') || !Array.isArray(raw.files) || !raw.files.length || raw.files.length > MAX_ARTIFACT_FILES) invalid('Select one or more Session artifacts');
  const publication = parsePublicationSpec(raw.publication);
  const paths = new Set<string>();
  const ids = new Set<string>();
  const files = raw.files.map((file) => {
    if (!record(file) || Object.keys(file).some((key) => key !== 'artifact_id' && key !== 'path') || typeof file.artifact_id !== 'string' || !/^art_[A-Za-z0-9_-]+$/.test(file.artifact_id) || typeof file.path !== 'string') invalid('Invalid Session publication file');
    try { validateArtifactPath(file.path); } catch { invalid('Publication paths must be relative files'); }
    if (paths.has(file.path) || ids.has(file.artifact_id)) invalid('Duplicate publication path or artifact');
    paths.add(file.path); ids.add(file.artifact_id);
    return { artifact_id: file.artifact_id, path: file.path };
  });
  return { publication, files };
}

export function sessionPublicationPlan(input: {
  ownerId: string; sessionId: string; artifactBucket: string; request: SessionPublicationRequest;
  sources: Array<{ saved: SavedSessionArtifact; prefix: Uint8Array }>;
}) {
  const ownerHash = hash(input.ownerId).slice(0, 32);
  const files: PublicationSourceFile[] = input.request.files.map((selected) => {
    const source = input.sources.find(({ saved }) => saved.artifact.id === selected.artifact_id);
    if (!source || source.saved.artifact.session_id !== input.sessionId) invalid('Publication artifact belongs to another Session');
    const { artifact, content } = source.saved;
    const expectedKey = `owners/${ownerHash}/sessions/${input.sessionId}/${artifact.turn_id}/artifacts/${artifact.id}`;
    if (content.bucket !== input.artifactBucket || content.key !== expectedKey) invalid('Publication artifact is outside its owner scope');
    return { path: selected.path, blob: { id: content.key, digest: `sha256:${content.sha256}`, size: artifact.size_bytes, mediaType: detectMediaType(source.prefix, selected.path) } };
  });
  const publicationId = hash(canonicalJson({ format: 'session-publication-v1', sessionId: input.sessionId, spec: input.request.publication, files: [...files].sort((a, b) => a.path.localeCompare(b.path)) })).slice(0, 24);
  const createdAt = new Date(Math.max(...input.sources.map(({ saved }) => saved.artifact.created_at)) * 1000).toISOString();
  return { ownerHash, publicationId, files, createdAt, artifactIds: input.request.files.map((file) => file.artifact_id) };
}
function hash(value: string) { return createHash('sha256').update(value).digest('hex'); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function invalid(message: string): never { throw new PublicationError('invalid_request', message); }
