import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createLocalServices, LOCAL_OWNER } from '../../src/app/local-composition.js';
import { LocalSessionExecution } from '../../src/runner/local-session-execution.js';
import { localWorkerNames } from '../../src/domain/local-runtime.js';
import { sharedBrowserTool } from '../../src/domain/shared-browser.js';
import { iamApiPrincipal, rolePermissions } from '../../src/domain/api-permissions.js';
import { routeAgentsRequest } from '../../src/lambdas/agents-router.js';
import { activityStream } from '../../src/lambdas/activity-stream.js';
import { createModelCatalog } from '../../src/core/model-catalog.js';
import type { SessionPlanUpdateInput } from '../../src/domain/session-plan.js';

// Demo-only authentication and model fixture. Services, SQLite, Codex, Linux
// worker, browser, feedback, attribution and activity streams are production code.
assert.equal(process.env.RAT_SHARED_WORKSPACE_DEMO, 'true');
const directory = await mkdtemp(join(tmpdir(), 'rat-workspace-demo-'));
const workspaceId = createHash('sha256').update(directory).digest('hex').slice(0, 16);
const output = resolve(process.env.RAT_DEMO_OUTPUT ?? 'artifacts/shared-workspace/feedback-demo'); await mkdir(output, { recursive: true });
await rm(join(output, 'cleanup.json'), { force: true });
const labels = ['Maya · Designer', 'Eli · Engineer', 'Sam · QA'];
const people = labels.map((label, index) => ({ token: randomUUID(), actor: { id: `demo-person-${index}`, kind: 'human' as const, label, issuer: 'local-demo-fixture', subject: `person-${index}` }, permissions: rolePermissions('collaborator') }));
const requests: unknown[] = [];
const streamClients = new Set<string>();
const browserCommands: unknown[] = [];
const plannedInputs = new Set<string>();
type DemoInput = { actor: { id: string }; message_ids: string[] };
function demoPlan(revision: number, inputs: readonly DemoInput[]): SessionPlanUpdateInput {
  const sources = (person: number) => inputs.slice(1).filter(input => input.actor.id === `demo-person-${person}`).flatMap(input => input.message_ids);
  return { expected_revision: revision, items: [
    { id: 'direction', text: 'Lead with shared evidence', state: sources(0).length ? 'addressed' : 'next',
      ...(sources(0).length ? { reason: 'The direction now focuses on comparing environments, with no blame assigned.' } : {}),
      source_message_ids: sources(0), result_links: sources(0).length ? [{ kind: 'output', path: '/workspace/outputs/direction.md' }] : [] },
    { id: 'scope', text: 'Keep the first release small', state: sources(1).length ? 'addressed' : 'next',
      ...(sources(1).length ? { reason: 'Start with runtime versions and the failing command. Defer automatic repair.' } : {}),
      source_message_ids: sources(1), result_links: sources(1).length ? [{ kind: 'output', path: '/workspace/outputs/direction.md' }] : [] },
    { id: 'offline', text: 'Decide what works offline', state: sources(2).length ? 'deferred' : 'next',
      ...(sources(2).length ? { reason: 'Keep saved evidence readable offline. Queueing new feedback needs a separate sync design; it is outside this first release.' } : {}),
      source_message_ids: sources(2), result_links: [] },
  ] };
}
const model = createServer(async (request, response) => {
  const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const input = JSON.parse(Buffer.concat(chunks).toString()); requests.push(input);
  if (requests.length > 16) { response.writeHead(429); response.end(); return; }
  const activity = await services.sessions.activity(LOCAL_OWNER, sessionId!);
  const inputKey = activity.inputs.flatMap(input => input.message_ids).join('|');
  const updatePlan = !plannedInputs.has(inputKey);
  plannedInputs.add(inputKey);
  const contributors = new Set(activity.inputs.slice(1).map(input => input.actor.id));
  const text = contributors.has('demo-person-2')
    ? 'The Plan now reflects all three perspectives. Shared evidence and a smaller first release are addressed. Sam’s offline feedback stays visible: saved evidence should remain readable, while offline editing is deferred. Open direction.md for the agreed first slice.'
    : contributors.has('demo-person-1')
      ? 'Agreed. First release: runtime versions and the failing command. Automatic repair can wait. I’ve linked your feedback and the saved direction in the Plan.'
      : contributors.has('demo-person-0')
        ? 'Let’s lead with shared evidence. I’ve updated the Plan and linked your annotation to the saved direction.'
        : '“It works on my machine” is our starting point. Let’s turn it into “we can reproduce it together.” Review the shared page: design can question the framing, engineering can constrain the first release, and QA can challenge the edge cases.';
  await delay(1200);
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const item = updatePlan
    ? { type: 'function_call', id: `plan_${requests.length}`, call_id: `call_plan_${requests.length}`, name: 'rat_things_plan_update', arguments: JSON.stringify(demoPlan(activity.plan?.revision ?? 0, activity.inputs)) }
    : { type: 'message', id: `reply_${requests.length}`, role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text }] };
  response.end([{ type: 'response.created', response: { id: `response_${requests.length}` } }, { type: 'response.output_item.done', item }, { type: 'response.completed', response: { id: `response_${requests.length}` } }].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
});
model.listen(0, '127.0.0.1'); await once(model, 'listening');
const modelAddress = model.address(); assert(modelAddress && typeof modelAddress !== 'string');
const services = createLocalServices({ directory, execution: (store, managed) => new LocalSessionExecution({ store, managed, directory, maxSessions: 1,
  environment: { PATH: process.env.PATH, HOME: directory, CODEX_HOME: directory, CODEX_BINARY: resolve('node_modules/.bin/codex') },
  request: request => ({ ...request, modelProvider: 'fixture', sessionConfig: { ...request.sessionConfig, 'model_providers.fixture': { name: 'fixture', base_url: `http://127.0.0.1:${modelAddress.port}`, wire_api: 'responses', requires_openai_auth: false, supports_websockets: false } } }),
}) });
const html = process.env.RAT_DEMO_DOCUMENT ? await readFile(process.env.RAT_DEMO_DOCUMENT, 'utf8') : `<!doctype html><meta charset="utf-8"><title>Works on our machines</title><style>
body{margin:0;background:#181819;color:#f7f8f8;font:20px system-ui;padding:64px}p{color:#d0d6e0;line-height:1.55}small{color:#8a8f98}h1{font-size:48px;font-weight:600;letter-spacing:-2px;max-width:800px}section{display:flex;gap:20px;margin:40px 0}article{background:#252527;border:1px solid #3e3e44;border-radius:12px;padding:24px;flex:1}button{background:#e5e5e6;color:#181819;border:0;border-radius:8px;padding:18px 24px;font:inherit}h2{font-size:23px;font-weight:500}</style>
<small>Product direction · review together</small><h1>It works on my machine.</h1><p>What if the next step was shared evidence, instead of another screenshot?</p><section><article><h2>Capture the difference</h2><p>Runtime, command, result.</p></article><article><h2>Discuss one version</h2><p>Design, engineering and QA.</p></article><article><h2>Choose the next step</h2><p>One agent keeps the context.</p></article></section><button onclick="document.querySelector('h1').textContent='Works on our machines.'">Review together</button>`;
let sessionId: string | undefined;
const direction = '# Works on our machines\n\n## A shared evidence room\nCompare environments together, without assigning blame.\n\n## First release\n- Capture runtime versions and the failing command.\n- Discuss one saved version with design, engineering and QA.\n- Keep saved evidence readable offline.\n\n## Later\nAutomatic repair and offline editing need more design.\n';
const server = createServer((incoming, outgoing) => void (async () => {
  const abort = new AbortController(); outgoing.once('close', () => abort.abort());
  const person = people.find(person => incoming.headers.authorization === `Bearer ${person.token}`);
  const url = new URL(incoming.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/demo/config' && incoming.headers['x-demo-control'] === process.env.RAT_DEMO_CONTROL) { outgoing.setHeader('content-type', 'application/json'); outgoing.end(JSON.stringify({ sessionId, people })); return; }
  if (!person) { outgoing.writeHead(401); outgoing.end(); return; }
  const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
  const path = url.pathname.replace(/^\/api/, '');
  const headers = new Headers(); for (const [key, value] of Object.entries(incoming.headers)) if (typeof value === 'string') headers.set(key, value);
  const request = new Request(`http://127.0.0.1${path}${url.search}`, { method: incoming.method ?? 'GET', headers, signal: abort.signal, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
  const after = request.headers.get('last-event-id') ?? new URL(request.url).searchParams.get('after');
  if (path === `/v1/rat/sessions/${sessionId}/workspace/browser` && request.method === 'POST') browserCommands.push(await request.clone().json());
  const space = { id: 'space_demo', name: 'Product team', role: 'collaborator', permissions: person.permissions };
  let response: Response;
  if (path === '/v1/workspace') response = Response.json({ ...space, kind: 'team', connection_id: 'demo', space_id: space.id });
  else if (path === '/v1/rat/spaces') response = Response.json({ object: 'list', data: [space] });
  else if (path === '/v1/team/connections') response = Response.json({ data: [{ id: 'demo', identity: person.actor }] });
  else if (path === `/v1/rat/sessions/${sessionId}/typing`) { await services.sessions.collaboration.typing(LOCAL_OWNER, sessionId!, await request.json(), person); response = new Response(null, { status: 204 }); }
  else if (path === `/v1/rat/sessions/${sessionId}/activity`) response = Response.json({ ...await services.sessions.activity(LOCAL_OWNER, sessionId!, person), role: space.role });
  else if (path === `/v1/rat/sessions/${sessionId}/activity/events`) {
    streamClients.add(person.actor.id);
    response = activityStream(signal => services.sessions.activityEvents(LOCAL_OWNER, sessionId!, signal, after ? { after } : {}), abort.signal, undefined, async () => space);
  }
  else if (path === '/v1/demo/evidence') {
    const activity = await services.sessions.activity(LOCAL_OWNER, sessionId!);
    const frame = await services.sessions.browserFrame(LOCAL_OWNER, sessionId!, person);
    response = Response.json({ ...activity, stream_clients: [...streamClients], browser_commands: browserCommands, browser_text: frame.text, fixture_requests: requests.length, image_delivered: requests.some(value => JSON.stringify(value).includes('data:image/jpeg;base64,')) });
  } else response = await routeAgentsRequest(request, { ...iamApiPrincipal(LOCAL_OWNER), authentication: 'local', actor: person.actor }, { ...services, models: createModelCatalog({ modelIds: ['gpt-5.4'], defaultModel: 'gpt-5.4' }) });
  const responseHeaders: Record<string, string> = {}; response.headers.forEach((value, key) => { responseHeaders[key] = value; });
  outgoing.writeHead(response.status, responseHeaders);
  if (response.body) await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), outgoing); else outgoing.end();
})().catch(error => { if (!outgoing.headersSent) { outgoing.writeHead(500); outgoing.end(JSON.stringify({ error: { message: String(error) } })); } else outgoing.destroy(); }));
let closing: Promise<void> | undefined;
const close = () => closing ??= (async () => {
  server.closeAllConnections(); server.close(); await services.close();
  model.closeAllConnections(); model.close();
  if (sessionId) { const volume = localWorkerNames(workspaceId, sessionId).volume; await promisify(execFile)('docker', ['volume', 'rm', volume, `${volume}-state`]); }
  await rm(directory, { recursive: true, force: true });
  await writeFile(join(output, 'cleanup.json'), JSON.stringify({ status: 'removed', resources: 'Demo container, paired volumes and temporary profile', paid_inference_calls: 0 })+'\n');
})();
process.stdin.resume(); process.stdin.on('end', () => { void close().then(() => process.exit()); });
process.once('SIGTERM', () => { void close().then(() => process.exit()); });
try {
  const session = await services.sessions.create(LOCAL_OWNER, { metadata: { name: 'Works on our machines' }, agent: { model: 'gpt-5.4', multi_agent: { enabled: false }, tools: [sharedBrowserTool] }, environment: { type: 'openai_hosted', network: { access: 'disabled' }, files: [{ type: 'inline', path: '/workspace/outputs/index.html', data: Buffer.from(html).toString('base64') }, { type: 'inline', path: '/workspace/outputs/direction.md', data: Buffer.from(direction).toString('base64') }] }, input: 'Plan and critique our product direction together.' }, undefined, undefined, undefined, people[0]);
  sessionId = session.id;
  await services.sessions.dispatch(LOCAL_OWNER, session.id);
  for (let index = 0; index < 150; index++) {
    const turns = (await services.sessions.turns(LOCAL_OWNER, session.id)).data;
    assert(!turns.some(turn => turn.status === 'failed'), JSON.stringify(turns));
    if (turns[0]?.status === 'completed') break;
    await delay(100);
  }
  const frame = await services.sessions.browserFrame(LOCAL_OWNER, session.id, people[0]);
  await services.sessions.browserAction(LOCAL_OWNER, session.id, { epoch: frame.epoch, revision: frame.revision, operation: { action: 'navigate', url: 'https://rat-artifacts.invalid/index.html' } }, people[0]!, 'demo-page');
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string'); console.log(JSON.stringify({ port: address.port }));
} catch (error) { console.error(error); await close(); process.exit(1); }
