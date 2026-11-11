import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createLocalServices, LOCAL_OWNER } from '../../src/app/local-composition.js';
import { LocalSessionExecution } from '../../src/runner/local-session-execution.js';
import { localWorkerNames } from '../../src/domain/local-runtime.js';
import { sharedBrowserTool } from '../../src/domain/shared-browser.js';
import type { SessionCaller } from '../../src/core/session-caller.js';

assert.equal(process.env.RAT_LOCAL_WORKSPACE_PROOF, 'true', 'This opt-in proof starts a local Linux worker.');
const directory = await mkdtemp(join(tmpdir(), 'rat-local-workspace-'));
const workspaceId = createHash('sha256').update(directory).digest('hex').slice(0, 16);
const output = 'artifacts/shared-workspace/live-local'; await mkdir(output, { recursive: true });
const caller: SessionCaller = { actor: { id: 'local', kind: 'local', label: 'Local collaborator' }, permissions: ['read', 'contribute'] };
const requests: unknown[] = [];
const model = createServer(async (request, response) => {
  const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
  requests.push(JSON.parse(Buffer.concat(chunks).toString()));
  assert(requests.length <= 4, 'Fixture request limit exceeded');
  const item = { type: 'message', id: `reply_${requests.length}`, role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Local feedback received.' }] };
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end([{ type: 'response.created', response: { id: `response_${requests.length}` } }, { type: 'response.output_item.done', item }, { type: 'response.completed', response: { id: `response_${requests.length}` } }].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
});
model.listen(0, '127.0.0.1'); await once(model, 'listening');
const address = model.address(); assert(address && typeof address !== 'string');
const launch = () => createLocalServices({ directory, execution: (store, managed) => new LocalSessionExecution({ store, managed, directory, maxSessions: 1,
  environment: { PATH: process.env.PATH, HOME: directory, CODEX_HOME: directory, CODEX_BINARY: resolve('node_modules/.bin/codex') },
  request: request => ({ ...request, modelProvider: 'fixture', sessionConfig: { ...request.sessionConfig, 'model_providers.fixture': { name: 'fixture', base_url: `http://127.0.0.1:${address.port}`, wire_api: 'responses', requires_openai_auth: false, supports_websockets: false } } }),
}) });
let services = launch(); let sessionId: string | undefined;
const checks: string[] = []; const timings: Record<string, number> = {};
try {
  const before = Date.now();
  const session = await services.sessions.create(LOCAL_OWNER, {
    agent: { model: 'gpt-5.4', multi_agent: { enabled: false }, tools: [sharedBrowserTool] },
    environment: { type: 'openai_hosted', network: { access: 'disabled' }, files: [{ type: 'inline', path: '/workspace/outputs/index.html', data: Buffer.from('<title>Local shared workspace</title><body style="margin:0"><button style="width:300px;height:200px" onclick="document.querySelector(\'p\').textContent=\'Shared change\'">Review</button><p>Ready</p></body>').toString('base64') }] },
  }, undefined, undefined, undefined, caller);
  sessionId = session.id; await services.sessions.dispatch(LOCAL_OWNER, session.id);
  await services.sessions.browserFrame(LOCAL_OWNER, session.id, caller);
  await services.sessions.events(LOCAL_OWNER, session.id, { events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: 'Initialize the local workspace.' }] }] }] }, 'initial');
  await services.sessions.dispatch(LOCAL_OWNER, session.id);
  await completed(1); timings.first_turn = Date.now() - before;
  const frame = await services.sessions.browserFrame(LOCAL_OWNER, session.id, caller);
  await services.sessions.browserAction(LOCAL_OWNER, session.id, { epoch: frame.epoch, revision: frame.revision, operation: { action: 'navigate', url: 'https://rat-artifacts.invalid/index.html' } }, caller, 'navigate');
  let page = await services.sessions.browserFrame(LOCAL_OWNER, session.id, caller);
  for (let i = 0; i < 30 && page.title !== 'Local shared workspace'; i++) { await delay(200); page = await services.sessions.browserFrame(LOCAL_OWNER, session.id, caller); }
  assert.equal(page.title, 'Local shared workspace');
  const clicked = await services.sessions.browserAction(LOCAL_OWNER, session.id, { epoch: page.epoch, revision: page.revision, operation: { action: 'click', x: .1, y: .1 } }, caller, 'click');
  assert(clicked.text.includes('Shared change'));
  checks.push('Real local Linux worker browser remains usable after a fixture-model Turn; local artifact navigation and click work');
  const capture = await services.sessions.captureBrowser(LOCAL_OWNER, session.id, { frame_id: clicked.frame_id }, caller);
  const feedback = { text: 'LOCAL-WORKSPACE-FEEDBACK', target: { kind: 'browser', id: capture.id, anchor: { type: 'point', x: .1, y: .1 } } };
  await services.sessions.workspaceFeedback(LOCAL_OWNER, session.id, feedback, caller, 'comment');
  await services.sessions.workspaceFeedback(LOCAL_OWNER, session.id, feedback, caller, 'comment');
  await services.sessions.dispatch(LOCAL_OWNER, session.id); await completed(2);
  const activity = await services.sessions.activity(LOCAL_OWNER, session.id, caller);
  assert.equal(activity.workspace_threads[0]?.comments.length, 1);
  assert.equal(activity.workspace_threads[0]?.comments[0]?.actor.id, 'local');
  const image = `data:image/jpeg;base64,${capture.frame.image}`;
  assert.equal(activity.workspace_threads[0]?.target.image, image);
  assert(requests.some(request => JSON.stringify(request).includes(image) && JSON.stringify(request).includes('LOCAL-WORKSPACE-FEEDBACK')));
  checks.push('Attributed annotation is idempotent and reaches the real Codex protocol with the exact captured image');
  await writeFile(`${output}/captured-browser.jpg`, Buffer.from(capture.frame.image, 'base64'));
  await services.close(); services = launch();
  const restored = await services.sessions.activity(LOCAL_OWNER, session.id, caller);
  assert.equal(restored.workspace_threads[0]?.target.image, image);
  assert.equal(restored.workspace_threads[0]?.comments.length, 1);
  await services.sessions.dispatch(LOCAL_OWNER, session.id);
  const replacement = await services.sessions.browserFrame(LOCAL_OWNER, session.id, caller);
  assert.notEqual(replacement.epoch, frame.epoch);
  assert.equal(replacement.url, 'about:blank');
  checks.push('Graceful service restart preserves SQLite feedback and captured image while the replacement browser gets a new generation');
  await writeFile(`${output}/evidence.json`, JSON.stringify({ status: 'passed', inference: 'Local Responses fixture; zero paid calls', checks, timings_ms: timings, fixture_requests: requests.length, limitations: ['Direct local service orchestration, not native UI windows', 'No local subscription inference', 'No local multi-user OIDC deployment', 'Graceful restart only'] }, null, 2)+'\n');
  console.log(JSON.stringify({ status: 'passed', checks, timings_ms: timings }));
} finally {
  await services.close(); model.closeAllConnections(); await new Promise<void>(done => model.close(() => done()));
  if (sessionId) { const volume = localWorkerNames(workspaceId, sessionId).volume; await promisify(execFile)('docker', ['volume', 'rm', volume, `${volume}-state`]); }
  await rm(directory, { recursive: true, force: true });
}
async function completed(count: number) {
  for (let i = 0; i < 900; i++) {
    const turns = (await services.sessions.turns(LOCAL_OWNER, sessionId!)).data;
    assert(!turns.some(turn => turn.status === 'failed' || turn.status === 'cancelled'), JSON.stringify(turns.map(turn => turn.error)));
    if (turns.length >= count && turns.every(turn => turn.status === 'completed')) return;
    await delay(100);
  }
  throw new Error('Local fixture Turn did not complete');
}
