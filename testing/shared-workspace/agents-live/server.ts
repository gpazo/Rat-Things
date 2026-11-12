import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createLocalServices, LOCAL_OWNER } from '../../../src/app/local-composition.js';
import { localWorkerNames } from '../../../src/domain/local-runtime.js';
import { sharedBrowserTool } from '../../../src/domain/shared-browser.js';
import { iamApiPrincipal, rolePermissions } from '../../../src/domain/api-permissions.js';
import { routeAgentsRequest } from '../../../src/lambdas/agents-router.js';
import { activityStream } from '../../../src/lambdas/activity-stream.js';
import { classifyDemoRoute } from '../demo-policy.js';
import { cleanupAgentsLive, type LiveTurnUsage } from './cleanup.js';

// Two AI participants share one local Session. Only participant authentication is
// demo-only (loopback bearer tokens); services, SQLite, Codex, the Linux worker,
// browser, attribution, activity streams and subscription inference are production code.
assert.equal(process.env.RAT_AGENTS_LIVE, 'true');
const directory = resolve(process.env.RAT_THINGS_LOCAL_DIR ?? join(homedir(), '.rat-things', 'multiplayer-demo'));
const workspaceId = createHash('sha256').update(directory).digest('hex').slice(0, 16);
const output = resolve('artifacts/shared-workspace/agents-live'); await mkdir(output, { recursive: true });
const maxTurns = Number(process.env.RAT_AGENTS_LIVE_MAX_TURNS ?? 6);
const maxMinutes = Number(process.env.RAT_AGENTS_LIVE_MAX_MINUTES ?? 45);
const participants = [
  { name: 'claude', label: 'Claude · Claude Code' },
  { name: 'codex', label: 'Codex · Codex CLI' },
].map(({ name, label }) => ({ name, token: randomUUID(), actor: { id: `agent-${name}`, kind: 'workload' as const, label, issuer: 'local-demo-fixture', subject: name }, permissions: rolePermissions('collaborator') }));

const services = createLocalServices({ directory });
const account = await services.subscription.status();
assert(account.signed_in, `Sign in first: RAT_THINGS_LOCAL_DIR=${directory} npm run rat-things -- login`);
const catalog = await services.models();
assert(catalog, 'The subscription returned no model catalog.');
const model = process.env.RAT_AGENTS_LIVE_MODEL;
assert(model, `Set RAT_AGENTS_LIVE_MODEL to one of: ${catalog.data.map(entry => entry.id).join(', ')}`);
assert(catalog.data.some(entry => entry.id === model), `Model ${model} is not in this subscription's catalog; no fallback is used.`);

const instructions = [
  'You are the shared agent in a multiplayer Rat Things Session on this computer.',
  'Two AI participants contribute: Claude (Claude Code) and Codex (Codex CLI). Each message names its sender.',
  'Address participants by name, weigh both views and make one concrete decision per reply. Keep replies under 120 words.',
  'Write deliverables to /workspace/outputs. /workspace/outputs/index.html is shown to everyone in the shared browser.',
].join(' ');
const title = process.env.RAT_AGENTS_LIVE_TITLE ?? 'Claude + Codex make a demo';
const placeholder = '<!doctype html><meta charset="utf-8"><title>Demo plan</title><body style="margin:0;background:#181819;color:#f7f8f8;font:22px system-ui;padding:64px"><h1 style="font-weight:600">Demo plan</h1><p style="color:#8a8f98">Waiting for Claude and Codex.</p>';

let sessionId: string | undefined;
const server = createServer((incoming, outgoing) => void (async () => {
  const abort = new AbortController(); outgoing.once('close', () => abort.abort());
  const person = participants.find(entry => incoming.headers.authorization === `Bearer ${entry.token}`);
  if (!person) { outgoing.writeHead(401); outgoing.end(); return; }
  const url = new URL(incoming.url ?? '/', 'http://127.0.0.1');
  const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
  const path = url.pathname.replace(/^\/api/, '');
  const headers = new Headers(); for (const [key, value] of Object.entries(incoming.headers)) if (typeof value === 'string') headers.set(key, value);
  const request = new Request(`http://127.0.0.1${path}${url.search}`, { method: incoming.method ?? 'GET', headers, signal: abort.signal, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
  const after = request.headers.get('last-event-id') ?? url.searchParams.get('after');
  const space = { id: 'space_agents', name: 'Claude + Codex', role: 'collaborator', permissions: person.permissions };
  const route = classifyDemoRoute(request.method, path, sessionId ?? '');
  let response: Response;
  if (route.kind === 'deny') response = Response.json({ error: { message: 'Route is not available through this demo.', code: 'resource_not_found' } }, { status: 404 });
  else if (route.kind === 'inference' && (await services.sessions.turns(LOCAL_OWNER, sessionId!)).data.length >= maxTurns) {
    response = Response.json({ error: { message: `Demo Turn limit (${maxTurns}) reached.`, code: 'demo_budget' } }, { status: 429 });
  } else if (path === '/v1/workspace') response = Response.json({ ...space, kind: 'team', connection_id: 'agents', space_id: space.id });
  else if (path === '/v1/rat/spaces') response = Response.json({ object: 'list', data: [space] });
  else if (path === '/v1/team/connections') response = Response.json({ data: [{ id: 'agents', identity: person.actor }] });
  else if (path === `/v1/rat/sessions/${sessionId}/typing`) { await services.sessions.collaboration.typing(LOCAL_OWNER, sessionId!, await request.json(), person); response = new Response(null, { status: 204 }); }
  else if (path === `/v1/rat/sessions/${sessionId}/activity`) response = Response.json({ ...await services.sessions.activity(LOCAL_OWNER, sessionId!, person), role: space.role });
  else if (path === `/v1/rat/sessions/${sessionId}/activity/events`) {
    response = activityStream(signal => services.sessions.activityEvents(LOCAL_OWNER, sessionId!, signal, after ? { after } : {}), abort.signal, undefined, async () => space);
  } else response = await routeAgentsRequest(request, { ...iamApiPrincipal(LOCAL_OWNER), authentication: 'local', actor: person.actor }, { ...services, models: catalog });
  const responseHeaders: Record<string, string> = {}; response.headers.forEach((value, key) => { responseHeaders[key] = value; });
  outgoing.writeHead(response.status, responseHeaders);
  if (response.body) await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), outgoing); else outgoing.end();
})().catch(error => { if (!outgoing.headersSent) { outgoing.writeHead(500); outgoing.end(JSON.stringify({ error: { message: String(error) } })); } else outgoing.destroy(); }));

const connection = join(directory, 'agents-live.json');
let closing: Promise<number> | undefined;
const close = () => closing ??= (async () => {
  const workerVolume = sessionId ? localWorkerNames(workspaceId, sessionId).volume : undefined;
  const stateVolume = workerVolume ? `${workerVolume}-state` : undefined;
  const result = await cleanupAgentsLive({
    stopServer: async () => {
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolveClose, rejectClose) => server.close(error => error ? rejectClose(error) : resolveClose()));
    },
    readTurns: async (): Promise<LiveTurnUsage[]> => sessionId ? (await services.sessions.turns(LOCAL_OWNER, sessionId)).data : [],
    closeServices: () => services.close(),
    removeConnectionFile: () => rm(connection, { force: true }),
    removeVolume: async name => { await promisify(execFile)('docker', ['volume', 'rm', name], { timeout: 30_000 }); },
    volumeExists: async name => {
      const { stdout } = await promisify(execFile)('docker', ['volume', 'ls', '--filter', `name=${name}`, '--format', '{{.Name}}'], { timeout: 30_000 });
      return stdout.split(/\r?\n/).some(volume => volume.trim() === name);
    },
    ...(workerVolume && stateVolume ? { volumes: [workerVolume, stateVolume] as const } : {}),
    writeEvidence: cleanup => writeFile(join(output, 'cleanup.json'), JSON.stringify({
      status: cleanup.status,
      resources: cleanup.resources,
      usage_status: cleanup.usage.status,
      ...(cleanup.usage.status === 'failed' ? { usage_error: cleanup.usage.error } : {}),
      model,
      inference: 'ChatGPT subscription through Codex (not API-billed)',
      turns: cleanup.usage.status === 'read' ? cleanup.usage.turns.length : null,
      usage: cleanup.usage.status === 'read' ? cleanup.usage.turns.map(({ id, status, usage }) => ({ id, status, usage: usage ?? null })) : [],
    }, null, 2) + '\n'),
  });
  if (result.evidenceError) console.error(`Could not write cleanup evidence: ${result.evidenceError}`);
  if (result.exitCode !== 0) console.error(`Demo cleanup incomplete: ${JSON.stringify(result.result.resources)}`);
  return result.exitCode;
})();
process.stdin.resume(); process.stdin.on('end', () => { void close().then(code => process.exit(code)); });
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { void close().then(code => process.exit(code)); });
setTimeout(() => { console.error(`Demo time limit (${maxMinutes} min) reached.`); void close().then(code => process.exit(code)); }, maxMinutes * 60_000).unref();

try {
  const session = await services.sessions.create(LOCAL_OWNER, {
    metadata: { name: title },
    agent: { model, instructions, multi_agent: { enabled: false }, tools: [sharedBrowserTool] },
    environment: { type: 'openai_hosted', network: { access: 'disabled' }, files: [{ type: 'inline', path: '/workspace/outputs/index.html', data: Buffer.from(placeholder).toString('base64') }] },
  }, undefined, undefined, undefined, participants[0]);
  sessionId = session.id;
  await services.sessions.dispatch(LOCAL_OWNER, session.id);
  let frame: Awaited<ReturnType<typeof services.sessions.browserFrame>> | undefined;
  for (let attempt = 0; attempt < 600 && !frame; attempt++) {
    frame = await services.sessions.browserFrame(LOCAL_OWNER, session.id, participants[0]).catch(() => undefined);
    if (!frame) await delay(500);
  }
  assert(frame, 'Shared browser did not become ready.');
  await services.sessions.browserAction(LOCAL_OWNER, session.id, { epoch: frame.epoch, revision: frame.revision, operation: { action: 'navigate', url: 'https://rat-artifacts.invalid/index.html' } }, participants[0]!, 'open-plan');
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string');
  const details = { url: `http://127.0.0.1:${address.port}`, sessionId, title, model, participants: Object.fromEntries(participants.map(entry => [entry.name, { token: entry.token, label: entry.actor.label }])) };
  await writeFile(`${connection}.tmp`, JSON.stringify(details), { mode: 0o600 }); await rename(`${connection}.tmp`, connection);
  console.log(JSON.stringify({ url: details.url, sessionId, model, connection }));
} catch (error) { console.error(error); await close(); process.exit(1); }
