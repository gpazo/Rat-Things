import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { SessionPublicationService } from '../../src/core/session-publication-service.js';
import { sessionPublicationRequest } from '../../src/core/session-publication-planning.js';
import type { PublicationManifest } from '../../src/domain/publications.js';
import { integrationFixture } from './integration-fixtures.js';
import type { SavedSessionArtifact, SessionState } from '../../src/core/session-ports.js';

const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
async function fixture() {
  const f = await integrationFixture();
  const session = await f.sessions.create('operator', { agent_id: f.agent.id, environment: { type: 'none' }, input: 'make a site' });
  const state = (await f.store.get<SessionState>('operator', 'sessions', session.id))!;
  const turnId = state.value.turns[0]!.turn.id;
  const saved: SavedSessionArtifact[] = ['index.html', 'app.js'].map((path, index) => ({ artifact: { id: `art_${index}`, object: 'agent.session.artifact', session_id: session.id, turn_id: turnId, environment_id: 'env_example', path: `/workspace/outputs/${path}`, size_bytes: 12, created_at: 100 }, content: { bucket: 'artifacts', key: `owners/${digest('operator').slice(0, 32)}/sessions/${session.id}/${turnId}/artifacts/art_${index}`, sha256: digest(path) } }));
  await f.store.put({ ...state, revision: state.revision + 1, value: { ...state.value, turns: state.value.turns.map((binding) => ({ ...binding, savedArtifacts: saved })) } }, state.revision);
  const manifests = new Map<string, PublicationManifest>();
  const manifestBlob = { id: 'manifest', digest: `sha256:${digest('manifest')}` as const, size: 8, mediaType: 'application/json' };
  const objects = {
    getCommitted: vi.fn(async ({ publicationId }: { publicationId: string }) => { const manifest = manifests.get(publicationId); return manifest ? { manifest, manifestBlob } : undefined; }),
    stageBlob: vi.fn(async ({ source }: { source: { id: string; digest: `sha256:${string}`; size: number; mediaType: string } }) => ({ ...source })),
    stageBytes: vi.fn(async ({ bytes, mediaType, path }: { bytes: Uint8Array; mediaType: string; path: string }) => ({ id: path, digest: `sha256:${digest(bytes)}` as const, size: bytes.byteLength, mediaType })),
    commit: vi.fn(async ({ manifest }: { manifest: PublicationManifest }) => { manifests.set(manifest.publicationId, manifest); return manifestBlob; }),
  };
  const grants = { put: vi.fn(async () => {}) };
  const readPrefix = vi.fn(async () => new Uint8Array());
  const publisher = new SessionPublicationService({ sessions: f.sessions, objects, grants, readPrefix, artifactBucket: 'artifacts', baseDomain: 'content.example.com', ttlSeconds: 3600, now: () => new Date('2026-09-12T12:00:00Z'), randomToken: () => 'a'.repeat(64) });
  const request = { publication: { version: '1', kind: 'site' }, files: [{ artifact_id: 'art_0', path: 'index.html' }, { artifact_id: 'art_1', path: 'app.js' }] };
  return { ...f, session, saved, publisher, request, objects, grants, readPrefix, manifests };
}

describe('Session artifact publications', () => {
  it('publishes exact immutable artifact selections with Session provenance and expiring access', async () => {
    const f = await fixture();
    const result = await f.publisher.publish('operator', f.session.id, f.request);
    expect(result).toMatchObject({ kind: 'site', paths: ['app.js', 'index.html'], expiresAt: '2026-09-12T13:00:00.000Z' });
    expect(f.manifests.get(result.publicationId)?.provenance).toEqual({ sessionId: f.session.id, artifactIds: ['art_0', 'art_1'], builder: 'rat-things/site@1', createdAt: new Date(100_000).toISOString() });
    expect(f.objects.stageBlob).toHaveBeenCalledWith(expect.objectContaining({ path: 'app.js', source: expect.objectContaining({ mediaType: 'text/javascript; charset=utf-8' }) }));
    await f.publisher.publish('operator', f.session.id, f.request);
    expect(f.objects.commit).toHaveBeenCalledTimes(1);
    expect(f.grants.put).toHaveBeenCalledTimes(2);
  });
  it('rejects wrong owners and deleted artifacts before reading or publishing content', async () => {
    const f = await fixture();
    await expect(f.publisher.publish('other', f.session.id, f.request)).rejects.toMatchObject({ status: 404 });
    await f.sessions.deleteArtifact('operator', f.session.id, 'art_0');
    await expect(f.publisher.publish('operator', f.session.id, f.request)).rejects.toMatchObject({ status: 404 });
    expect(f.readPrefix).not.toHaveBeenCalled();
    expect(f.objects.stageBlob).not.toHaveBeenCalled();
    expect(f.grants.put).not.toHaveBeenCalled();
  });
  it('validates every stored reference before reading any selected content', async () => {
    const f = await fixture();
    const stored = (await f.store.get<SessionState>('operator', 'sessions', f.session.id))!;
    const outside = f.saved.map((entry, index) => index === 0 ? entry : { ...entry, content: { ...entry.content, key: 'owners/other/sessions/private' } });
    await f.store.put({ ...stored, revision: stored.revision + 1, value: { ...stored.value, turns: stored.value.turns.map((turn) => ({ ...turn, savedArtifacts: outside })) } }, stored.revision);
    await expect(f.publisher.publish('operator', f.session.id, f.request)).rejects.toThrow('outside its owner scope');
    expect(f.readPrefix).not.toHaveBeenCalled();
    expect(f.objects.stageBlob).not.toHaveBeenCalled();
    expect(f.grants.put).not.toHaveBeenCalled();
  });
  it('rejects duplicate selections and traversal without changing supplied input', async () => {
    const f = await fixture();
    const before = structuredClone(f.request);
    expect(sessionPublicationRequest(f.request)).toEqual(f.request);
    expect(f.request).toEqual(before);
    expect(() => sessionPublicationRequest({ ...f.request, files: [f.request.files[0], f.request.files[0]] })).toThrow('Duplicate');
    expect(() => sessionPublicationRequest({ ...f.request, files: [{ artifact_id: 'art_0', path: '../index.html' }] })).toThrow('relative');
    expect(() => sessionPublicationRequest({ ...f.request, runId: 'legacy' })).toThrow('Select');
  });
});
