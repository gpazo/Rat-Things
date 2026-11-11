import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
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

// Demo-only authentication and model fixture. Services, SQLite, Codex, Linux
// worker, browser, feedback, attribution and activity streams are production code.
assert.equal(process.env.RAT_SHARED_WORKSPACE_DEMO, 'true');
const directory = await mkdtemp(join(tmpdir(), 'rat-workspace-demo-'));
const workspaceId = createHash('sha256').update(directory).digest('hex').slice(0, 16);
const output = resolve('artifacts/shared-workspace/demo'); await mkdir(output, { recursive: true });
await rm(join(output, 'cleanup.json'), { force: true });
const labels = ['Maya · Designer', 'Eli · Engineer', 'Sam · QA'];
const people = labels.map((label, index) => ({ token: randomUUID(), actor: { id: `demo-person-${index}`, kind: 'human' as const, label, issuer: 'local-demo-fixture', subject: `person-${index}` }, permissions: rolePermissions('collaborator') }));
const requests: unknown[] = [];
const streamClients = new Set<string>();
const browserCommands: unknown[] = [];
const model = createServer(async (request, response) => {
  const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const input = JSON.parse(Buffer.concat(chunks).toString()); requests.push(input);
  if (requests.length > 12) { response.writeHead(429); response.end(); return; }
  const body = JSON.stringify(Array.isArray(input.input) ? input.input.filter((item: { role?: string }) => item.role === 'user') : input.input);
  const text = body.includes('offline')
    ? 'Our direction: a shared evidence room. Maya: lead with the difference, not blame. Eli: capture runtime versions before adding automation. Sam: keep evidence readable offline and reconnect without duplicate feedback. First slice: compare two environments, annotate one capture, and agree on a reproducible next step.'
    : body.includes('runtime versions')
      ? 'Eli’s constraint keeps the first release small: capture runtime versions and the failing command. I will preserve Maya’s design feedback beside the exact page everyone reviewed.'
      : body.includes('blame')
        ? 'Maya’s feedback changes the direction: show what differs between environments instead of assigning blame. The annotation is attached to this captured page, so everyone can discuss the same evidence.'
        : '“It works on my machine” is our starting point. Let’s turn it into “we can reproduce it together.” Review the shared page: design can question the framing, engineering can constrain the first release, and QA can challenge the edge cases.';
  await delay(1200);
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const item = { type: 'message', id: `reply_${requests.length}`, role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text }] };
  response.end([{ type: 'response.created', response: { id: `response_${requests.length}` } }, { type: 'response.output_item.done', item }, { type: 'response.completed', response: { id: `response_${requests.length}` } }].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
});
model.listen(0, '127.0.0.1'); await once(model, 'listening');
const modelAddress = model.address(); assert(modelAddress && typeof modelAddress !== 'string');
const services = createLocalServices({ directory, execution: (store, managed) => new LocalSessionExecution({ store, managed, directory, maxSessions: 1,
  environment: { PATH: process.env.PATH, HOME: directory, CODEX_HOME: directory, CODEX_BINARY: resolve('node_modules/.bin/codex') },
  request: request => ({ ...request, modelProvider: 'fixture', sessionConfig: { ...request.sessionConfig, 'model_providers.fixture': { name: 'fixture', base_url: `http://127.0.0.1:${modelAddress.port}`, wire_api: 'responses', requires_openai_auth: false, supports_websockets: false } } }),
}) });
const html = `<!doctype html><meta charset="utf-8"><title>Works on our machines</title><style>
body{margin:0;background:#181819;color:#f7f8f8;font:20px system-ui;padding:64px}p{color:#d0d6e0;line-height:1.55}small{color:#8a8f98}h1{font-size:48px;font-weight:600;letter-spacing:-2px;max-width:800px}section{display:flex;gap:20px;margin:40px 0}article{background:#252527;border:1px solid #3e3e44;border-radius:12px;padding:24px;flex:1}button{background:#e5e5e6;color:#181819;border:0;border-radius:8px;padding:18px 24px;font:inherit}h2{font-size:23px;font-weight:500}</style>
<small>Product direction · review together</small><h1>It works on my machine.</h1><p>What if the next step was shared evidence, instead of another screenshot?</p><section><article><h2>Capture the difference</h2><p>Runtime, command, result.</p></article><article><h2>Discuss one version</h2><p>Design, engineering and QA.</p></article><article><h2>Choose the next step</h2><p>One agent keeps the context.</p></article></section><button onclick="document.querySelector('h1').textContent='Works on our machines.'">Review together</button>`;
let sessionId: string | undefined;
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
  const session = await services.sessions.create(LOCAL_OWNER, { metadata: { name: 'Works on our machines' }, agent: { model: 'gpt-5.4', multi_agent: { enabled: false }, tools: [sharedBrowserTool] }, environment: { type: 'openai_hosted', network: { access: 'disabled' }, files: [{ type: 'inline', path: '/workspace/outputs/index.html', data: Buffer.from(html).toString('base64') }] }, input: 'Plan and critique our product direction together.' }, undefined, undefined, undefined, people[0]);
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
