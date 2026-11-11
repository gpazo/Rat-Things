import { createHash } from 'node:crypto';
import { deflateSync, crc32 } from 'node:zlib';
import { expect, it, vi } from 'vitest';
import { integrationFixture } from './integration-fixtures.js';
import { SessionEventStore } from '../../src/core/session-event-store.js';
import { AgentService } from '../../src/core/agent-service.js';
import { EnvironmentService } from '../../src/core/environment-service.js';
import { EnvironmentTemplateService } from '../../src/core/environment-template-service.js';
import { SessionService } from '../../src/core/session-service.js';
import { sharedBrowserTool } from '../../src/domain/shared-browser.js';
import { iamApiPrincipal } from '../../src/domain/api-permissions.js';
import { routeAgentsRequest } from '../../src/lambdas/agents-router.js';
import type { SessionState } from '../../src/core/session-ports.js';
import { sessionInputs } from '../../src/core/session-activity.js';
import { importedSessionReceipts } from '../../src/core/session-attribution.js';

const author = { actor: { id: 'designer', kind: 'human' as const }, permissions: ['read', 'contribute'] };
const frame = { epoch: 'epoch', revision: 1, frame_id: 'a'.repeat(64), width: 1280, height: 800, image: 'aW1hZ2U=', title: 'Direction', url: 'https://example.test', text: 'Direction' };
async function fixture() {
  const f = await integrationFixture();
  let now = 1_800_000_000;
  const clock = { now: () => now };
  const store = new SessionEventStore(f.store, clock);
  const agents = new AgentService({ store, clock });
  const environments = new EnvironmentService({ store, clock, templates: new EnvironmentTemplateService({ store }), managedFiles: async () => [] });
  f.execution.prepare = (owner, id, environment) => environments.prepare(owner, id, environment);
  f.execution.browser = vi.fn(async () => frame);
  const sessions = new SessionService({ store, agents, execution: f.execution, clock, nowMs: () => now * 1000 });
  const session = await sessions.create('operator', { agent: { model: 'fixture', tools: [sharedBrowserTool] }, environment: { type: 'openai_hosted' }, input: 'Review this design.' });
  return { ...f, store, agents, sessions, session, advance: (seconds: number) => { now += seconds; } };
}

function largePng(): Buffer {
  const chunk = (kind: string, data: Buffer) => {
    const tag = Buffer.from(kind); const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([tag, data])));
    return Buffer.concat([length, tag, data, checksum]);
  };
  const width = 1024, height = 1024;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let seed = 1;
  for (let y = 0; y < height; y++) for (let x = 1; x <= width * 3; x++) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    raw[y * (width * 3 + 1) + x] = seed & 255;
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

it('keeps large image discussions readable before and after dispatch', async () => {
  const f = await fixture();
  const bytes = largePng();
  f.execution.artifacts = async (_owner, session, turnId) => [{ artifact: { id: 'artifact_image', object: 'agent.session.artifact', session_id: session.id, turn_id: turnId, created_at: 1, environment_id: 'fixture-env', path: '/workspace/outputs/design.png', size_bytes: bytes.length }, content: { bucket: 'fixture', key: 'design.png', sha256: createHash('sha256').update(bytes).digest('hex') } }];
  f.execution.artifactContent = async () => new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
  await f.sessions.workspaceFeedback('operator', f.session.id, { text: 'Review this region.', target: { kind: 'artifact', id: 'artifact_image', anchor: { type: 'point', x: .5, y: .5 } } }, author, 'first');
  const thread_id = (await f.sessions.activity('operator', f.session.id)).workspace_threads[0]!.id;
  await f.sessions.workspaceFeedback('operator', f.session.id, { thread_id, text: 'A second comment.' }, author, 'second');
  const response = await routeAgentsRequest(new Request(`https://fixture/v1/rat/sessions/${f.session.id}/activity`), iamApiPrincipal('operator'), f);
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(Buffer.byteLength(body)).toBeLessThan(100_000);
  expect(body).not.toContain('data:image');
  expect(JSON.parse(body).workspace_threads[0].comments).toHaveLength(2);
  const imagePath = `https://fixture/v1/rat/sessions/${f.session.id}/workspace/threads/${thread_id}/image`;
  const viewer = { ...iamApiPrincipal('operator'), scopes: ['api.agents.read' as const] };
  const preview = await routeAgentsRequest(new Request(imagePath), viewer, f);
  expect(preview.status).toBe(200);
  expect(preview.headers.get('content-type')).toBe('image/png');
  expect(preview.headers.get('cache-control')).toContain('no-store');
  expect(Buffer.from(await preview.arrayBuffer()).equals(bytes)).toBe(true);
  const outsider = await routeAgentsRequest(new Request(imagePath), iamApiPrincipal('another-owner'), f);
  expect(outsider.status).toBe(404);
  f.advance(2); await f.sessions.dispatch('operator', f.session.id); await f.sessions.dispatch('operator', f.session.id);
  await f.sessions.workspaceFeedback('operator', f.session.id, { thread_id, text: 'A third comment.' }, author, 'third');
  f.advance(2); await f.sessions.dispatch('operator', f.session.id);
  const final = await f.sessions.activity('operator', f.session.id);
  expect(final.pending_inputs).toHaveLength(0);
  expect(final.workspace_threads[0]!.comments).toHaveLength(3);
  const savedPreview = await routeAgentsRequest(new Request(imagePath), viewer, f);
  expect(Buffer.from(await savedPreview.arrayBuffer()).equals(bytes)).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(final))).toBeLessThan(100_000);
  expect(JSON.stringify(vi.mocked(f.execution.steer).mock.calls)).toContain(`data:image/png;base64,${bytes.toString('base64')}`);
});

it('replays accepted feedback after capture expiry without admitting a new request or bypassing authorization', async () => {
  const f = await fixture();
  const capture = await f.sessions.captureBrowser('operator', f.session.id, { frame_id: frame.frame_id }, author);
  const request = { text: 'Keep this feedback.', target: { kind: 'browser', id: capture.id, anchor: { type: 'item' } } };
  await f.sessions.workspaceFeedback('operator', f.session.id, request, author, 'same');
  f.advance(3601);
  const saved = await f.store.get('operator', `session_browser_frames:${f.session.id}`, capture.id);
  if (saved) await f.store.delete(saved);
  await expect(f.sessions.workspaceFeedback('operator', f.session.id, request, author, 'same')).resolves.toBeUndefined();
  await expect(f.sessions.workspaceFeedback('operator', f.session.id, { ...request, text: 'Changed.' }, author, 'same')).rejects.toMatchObject({ status: 409 });
  await expect(f.sessions.workspaceFeedback('operator', f.session.id, request, author, 'new')).rejects.toMatchObject({ status: 400 });
  await expect(f.sessions.workspaceFeedback('operator', f.session.id, request, { ...author, permissions: ['read'] }, 'same')).rejects.toMatchObject({ status: 403 });
  await expect(f.sessions.workspaceFeedback('operator', f.session.id, request, { ...author, expiresAt: 1 }, 'same')).rejects.toMatchObject({ status: 401 });
  await expect(f.sessions.workspaceFeedback('operator', f.session.id, request, { ...author, revalidate: async () => { throw new Error('Revoked'); } }, 'same')).rejects.toThrow('Revoked');
  f.advance(2); await f.sessions.dispatch('operator', f.session.id);
  await expect(f.sessions.workspaceFeedback('operator', f.session.id, request, author, 'same')).resolves.toBeUndefined();
  const activity = await f.sessions.activity('operator', f.session.id);
  expect(activity.workspace_threads[0]!.comments).toHaveLength(1);
  const thread = activity.workspace_threads[0]!;
  expect(thread.target).toMatchObject({ image_available: true });
  const preview = await routeAgentsRequest(new Request(`https://fixture/v1/rat/sessions/${f.session.id}/workspace/threads/${thread.id}/image`), iamApiPrincipal('operator'), f);
  expect(preview.status).toBe(200);
  expect(Buffer.from(await preview.arrayBuffer()).toString('base64')).toBe(frame.image);
  let reads = 0;
  await expect(f.sessions.workspaceThreadImage('operator', f.session.id, thread.id, { ...author, revalidate: async () => { if (++reads === 2) throw new Error('Revoked during read'); } })).rejects.toThrow('Revoked during read');
  const resource = (await f.store.get<SessionState>('operator', 'sessions', f.session.id))!;
  await f.store.put({ ...resource, revision: resource.revision + 1, value: { ...resource.value, closing: true } }, resource.revision);
  await expect(f.sessions.workspaceFeedback('operator', f.session.id, request, author, 'same')).rejects.toMatchObject({ status: 409 });
});

it('reads saved images from imported receipts without a source capture or browser worker', async () => {
  const f = await fixture();
  const capture = await f.sessions.captureBrowser('operator', f.session.id, { frame_id: frame.frame_id }, author);
  await f.sessions.workspaceFeedback('operator', f.session.id, { text: 'Keep this context.', target: { kind: 'browser', id: capture.id, anchor: { type: 'item' } } }, author, 'source');
  f.advance(2); await f.sessions.dispatch('operator', f.session.id);
  const source = (await f.store.get<SessionState>('operator', 'sessions', f.session.id))!;
  const imported = importedSessionReceipts(sessionInputs(source.value), 'transfer');
  const destination = await f.sessions.create('operator', { agent: { model: 'fixture' }, environment: { type: 'none' }, input: 'Continue from the shared history.' });
  const resource = (await f.store.get<SessionState>('operator', 'sessions', destination.id))!;
  await f.store.put({ ...resource, revision: resource.revision + 1, value: { ...resource.value, archivedInputs: imported, inputSequence: imported.length } }, resource.revision);
  const snapshot = await f.sessions.activity('operator', destination.id);
  expect(JSON.stringify(snapshot)).not.toContain('data:image');
  const thread = snapshot.workspace_threads[0]!;
  const saved = await f.sessions.workspaceThreadImage('operator', destination.id, thread.id, author);
  expect(Buffer.from(saved.bytes).toString('base64')).toBe(frame.image);
  expect(thread.comments[0]!.provenance?.kind).toBe('imported');
});

it.each([false, true])('rechecks concurrent acceptance when a capture disappears (changed payload: %s)', async changed => {
  const f = await fixture();
  const capture = await f.sessions.captureBrowser('operator', f.session.id, { frame_id: frame.frame_id }, author);
  const request = { text: 'Keep the original feedback.', target: { kind: 'browser', id: capture.id, anchor: { type: 'item' } } };
  let release!: () => void;
  let reached!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const waiting = new Promise<void>(resolve => { reached = resolve; });
  const get = f.store.get.bind(f.store);
  let captureReads = 0;
  f.store.get = async <T>(owner: string, collection: string, id: string) => {
    if (collection === `session_browser_frames:${f.session.id}` && ++captureReads === 1) {
      reached();
      await held;
    }
    return get<T>(owner, collection, id);
  };
  const delayed = f.sessions.workspaceFeedback('operator', f.session.id, changed ? { ...request, text: 'Different feedback.' } : request, author, 'concurrent');
  const outcome = delayed.then(() => undefined, (error: unknown) => error);
  await waiting;
  try {
    await f.sessions.workspaceFeedback('operator', f.session.id, request, author, 'concurrent');
    f.advance(3601);
    const saved = await get('operator', `session_browser_frames:${f.session.id}`, capture.id);
    if (saved) await f.store.delete(saved);
  } finally { release(); }
  if (changed) expect(await outcome).toMatchObject({ status: 409, code: 'idempotency_conflict' });
  else expect(await outcome).toBeUndefined();
  const activity = await f.sessions.activity('operator', f.session.id);
  expect(activity.workspace_threads[0]!.comments).toHaveLength(1);
});
