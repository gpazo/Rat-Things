import { expect, it, vi } from 'vitest';
import { integrationFixture } from './integration-fixtures.js';
import { AgentService } from '../../src/core/agent-service.js';
import { EnvironmentService } from '../../src/core/environment-service.js';
import { EnvironmentTemplateService } from '../../src/core/environment-template-service.js';
import { SessionEventStore } from '../../src/core/session-event-store.js';
import { SessionService } from '../../src/core/session-service.js';
import { workspaceAnchor, workspaceThreads } from '../../src/core/session-workspace-planning.js';
import { SharedBrowserFrames } from '../../src/core/shared-browser-frames.js';
import { sharedBrowserTool, type BrowserFrame } from '../../src/domain/shared-browser.js';
import { routeActions, iamApiPrincipal } from '../../src/domain/api-permissions.js';
import { routeAgentsRequest } from '../../src/lambdas/agents-router.js';
import { importedSessionReceipts } from '../../src/core/session-attribution.js';
import type { SessionCaller } from '../../src/core/session-caller.js';
import { planSessionLaunch } from '../../src/runner/session-launch-planning.js';
import { planCodexLaunch } from '../../src/runner/agent-planning.js';

const caller = (id: string, permissions = ['read', 'contribute']): SessionCaller => ({ actor: { id, kind: 'human', label: id }, permissions });
const frame: BrowserFrame = { epoch: 'epoch', revision: 1, frame_id: 'a'.repeat(64), width: 1280, height: 800, image: 'aW1hZ2U=', title: 'Direction', url: 'https://rat-artifacts.invalid/index.html', text: 'Team direction' };
async function fixture() {
  const f = await integrationFixture();
  const store = new SessionEventStore(f.store);
  const agents = new AgentService({ store });
  const environments = new EnvironmentService({ store, templates: new EnvironmentTemplateService({ store }), managedFiles: async () => [] });
  f.execution.prepare = (owner, id, environment) => environments.prepare(owner, id, environment);
  f.execution.browser = vi.fn(async () => frame);
  const sessions = new SessionService({ store, agents, execution: f.execution });
  const session = await sessions.create('operator', { agent: { model: 'test', tools: [sharedBrowserTool] }, environment: { type: 'openai_hosted' }, input: 'Plan the product' }, undefined, undefined, undefined, caller('designer'));
  return { ...f, store, agents, sessions, session };
}

it('validates normalized anchors without accepting arbitrary target fields', () => {
  expect(workspaceAnchor({ type: 'point', x: 0, y: 1 })).toEqual({ type: 'point', x: 0, y: 1 });
  for (const anchor of [{ type: 'point', x: NaN, y: 0 }, { type: 'region', x: .8, y: .5, width: .4, height: .2 }, { type: 'text', start: 4, end: 2, quote: 'no' }, { type: 'item', image: 'forged' }]) expect(() => workspaceAnchor(anchor)).toThrow();
});

it('shares one durable annotated page with attributed feedback, agent input, resolve/reopen and idempotency', async () => {
  const f = await fixture();
  const capture = await f.sessions.captureBrowser('operator', f.session.id, { frame_id: frame.frame_id }, caller('designer'));
  const feedback = { text: 'Make the direction clearer.', target: { kind: 'browser', id: capture.id, anchor: { type: 'point', x: .3, y: .4 } } };
  await f.sessions.workspaceFeedback('operator', f.session.id, feedback, caller('designer'), 'design');
  await f.sessions.workspaceFeedback('operator', f.session.id, feedback, caller('designer'), 'design');
  const first = await f.sessions.activity('operator', f.session.id, caller('qa', ['read']));
  expect(first.workspace_threads).toHaveLength(1);
  expect(first.workspace_threads[0]!.comments).toHaveLength(1);
  const thread_id = first.workspace_threads[0]!.id;
  await Promise.all(['engineer', 'qa'].map(id => f.sessions.workspaceFeedback('operator', f.session.id, { thread_id, text: `${id} feedback` }, caller(id), 'same-key')));
  await f.sessions.workspaceFeedback('operator', f.session.id, { thread_id, action: 'resolve', text: 'Addressed.' }, caller('engineer'), 'resolved');
  await f.sessions.workspaceFeedback('operator', f.session.id, { thread_id, action: 'reopen', text: 'One edge case remains.' }, caller('qa'), 'reopen');
  const activity = await f.sessions.activity('operator', f.session.id);
  expect(activity.workspace_threads[0]).toMatchObject({ resolved: false, target: { version: 'epoch:1', image_available: true } });
  const authors = activity.workspace_threads[0]!.comments.map(c => c.actor.id);
  expect(authors[0]).toBe('designer'); expect(authors.slice(1, 3).sort()).toEqual(['engineer', 'qa']); expect(authors.slice(3)).toEqual(['engineer', 'qa']);
  expect(new Set(activity.workspace_threads[0]!.comments.map(c => c.participant!.color)).size).toBe(3);
  await f.sessions.dispatch('operator', f.session.id);
  const input = JSON.stringify(vi.mocked(f.execution.steer).mock.calls);
  expect(input).toContain('Shared artifact feedback'); expect(input).toContain('data:image/jpeg;base64,aW1hZ2U='); expect(input).toContain('qa');
  const imported = importedSessionReceipts(activity.inputs, 'transfer');
  expect(workspaceThreads(imported, new Map())[0]!.comments[0]!.provenance?.kind).toBe('imported');
});

it('keeps viewer and revoked access out of mutations and rechecks cached frame reads', async () => {
  const f = await fixture();
  const viewer = caller('viewer', ['read']);
  expect(await f.sessions.browserFrame('operator', f.session.id, viewer)).toEqual(frame);
  expect(await f.sessions.browserFrame('operator', f.session.id, viewer)).toEqual(frame);
  expect(f.execution.browser).toHaveBeenCalledTimes(1);
  await expect(f.sessions.browserAction('operator', f.session.id, {}, viewer, 'id')).rejects.toMatchObject({ status: 403 });
  await expect(f.sessions.captureBrowser('operator', f.session.id, { frame_id: frame.frame_id }, viewer)).rejects.toMatchObject({ status: 403 });
  await expect(f.sessions.workspaceFeedback('operator', f.session.id, {}, viewer, 'id')).rejects.toMatchObject({ status: 403 });
  await expect(f.sessions.browserFrame('operator', f.session.id, { ...viewer, revalidate: async () => { throw new Error('Revoked'); } })).rejects.toThrow('Revoked');
  await expect(f.sessions.workspaceFeedback('operator', f.session.id, { text: 'x', target: { kind: 'browser', id: 'other-session', anchor: { type: 'item' } } }, caller('designer'), 'x')).rejects.toMatchObject({ status: 400 });
});

it('retains actor-specific browser receipts and rejects key reuse with different actions', async () => {
  const f = await fixture(); const request = { epoch: frame.epoch, revision: frame.revision, operation: { action: 'click', x: .1, y: .1 } };
  await Promise.all([f.sessions.browserAction('operator', f.session.id, request, caller('designer'), 'click'), f.sessions.browserAction('operator', f.session.id, request, caller('designer'), 'click')]);
  await expect(f.sessions.browserAction('operator', f.session.id, { ...request, operation: { action: 'reload' } }, caller('designer'), 'click')).rejects.toMatchObject({ status: 409 });
  expect((await f.store.list('operator', `session_browser_actions:${f.session.id}`, {})).data).toHaveLength(1);
  const noWrite = { ...iamApiPrincipal('operator'), scopes: ['api.agents.read' as const] };
  const response = await routeAgentsRequest(new Request(`https://rat.invalid/v1/rat/sessions/${f.session.id}/workspace/browser`, { method: 'POST', body: JSON.stringify(request) }), noWrite, f);
  expect(response.status).toBe(403);
  expect(routeActions('GET', ['v1', 'rat', 'sessions', f.session.id, 'workspace', 'browser'])).toEqual(['read']);
  expect(routeActions('POST', ['v1', 'rat', 'sessions', f.session.id, 'workspace', 'feedback'])).toEqual(['contribute']);
});

it('admits the browser once as an isolated environment tool rather than a dynamic function', async () => {
  const f = await fixture();
  const base = planCodexLaunch({ version: '1', prompt: '', agent: { sandbox: 'read-only' } }, '/workspace', 1000, {});
  const planned = planSessionLaunch(base, { sessionId: f.session.id, turnId: 'turn', agent: f.session.agent, environment: f.session.environment, input: [] });
  expect(planned.dynamicTools).toEqual([]);
  expect(planned.sessionConfig?.mcp_servers).toMatchObject({ rat_shared_browser: { command: 'node', environment_id: 'local', required: true, enabled_tools: ['browser'] } });
  await expect(f.sessions.create('operator', { agent: { model: 'test', tools: [sharedBrowserTool] }, environment: { type: 'none' } })).rejects.toMatchObject({ status: 400 });
});

it('coalesces viewer frames, expires them, and does not cache failures', async () => {
  let now = 0; const cache = new SharedBrowserFrames(() => now); const capture = vi.fn(async () => frame);
  await Promise.all(Array.from({ length: 30 }, () => cache.read('session', capture))); expect(capture).toHaveBeenCalledTimes(1);
  now = 401; await cache.read('session', capture); expect(capture).toHaveBeenCalledTimes(2);
  cache.invalidate('session'); await cache.read('session', capture); expect(capture).toHaveBeenCalledTimes(3);
  const failed = vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValue(frame);
  await expect(cache.read('another', failed)).rejects.toThrow('Offline'); await cache.read('another', failed); expect(failed).toHaveBeenCalledTimes(2);
});
