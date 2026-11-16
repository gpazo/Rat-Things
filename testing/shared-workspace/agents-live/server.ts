import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
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
import { budgetDecision, type BudgetLimits, type BudgetPhase } from './budget.js';

// Two AI participants share one local Session. Only participant authentication is
// demo-only (loopback bearer tokens); services, SQLite, Codex, the Linux worker,
// browser, attribution, activity streams and subscription inference are production code.
assert.equal(process.env.RAT_AGENTS_LIVE, 'true');
const directory = resolve(process.env.RAT_THINGS_LOCAL_DIR ?? join(homedir(), '.rat-things', 'multiplayer-demo'));
const workspaceId = createHash('sha256').update(directory).digest('hex').slice(0, 16);
const output = resolve(process.env.RAT_AGENTS_LIVE_OUTPUT ?? 'artifacts/shared-workspace/agents-live'); await mkdir(output, { recursive: true });
const scenario = process.env.RAT_AGENTS_LIVE_SCENARIO ? JSON.parse(await readFile(process.env.RAT_AGENTS_LIVE_SCENARIO, 'utf8')) as { participants: Array<{ name: string; label: string }>; instructions: string; maxObservedTokens: number; maxToolCalls: number; maxTurns?: number; maxActiveMinutes?: number; reviewMinutes?: number } : undefined;
if (scenario) {
  assert(scenario.participants.length >= 1 && scenario.participants.length <= 4);
  assert(new Set(scenario.participants.map(p => p.name)).size === scenario.participants.length);
  assert(scenario.participants.every(p => /^[a-z]+$/.test(p.name) && p.label.length <= 80));
  assert(scenario.instructions.length > 0 && scenario.instructions.length <= 10_000);
  assert(Number.isSafeInteger(scenario.maxObservedTokens) && scenario.maxObservedTokens > 0 && scenario.maxObservedTokens <= 2_000_000);
  assert(Number.isSafeInteger(scenario.maxToolCalls) && scenario.maxToolCalls > 0 && scenario.maxToolCalls <= 200);
  if (scenario.maxTurns !== undefined) assert(Number.isSafeInteger(scenario.maxTurns) && scenario.maxTurns > 0 && scenario.maxTurns <= 20);
  if (scenario.maxActiveMinutes !== undefined) assert(Number.isFinite(scenario.maxActiveMinutes) && scenario.maxActiveMinutes > 0 && scenario.maxActiveMinutes <= 60);
  if (scenario.reviewMinutes !== undefined) assert(Number.isFinite(scenario.reviewMinutes) && scenario.reviewMinutes > 0 && scenario.reviewMinutes <= 30);
}
const limits: BudgetLimits = {
  maxTurns: scenario?.maxTurns ?? Number(process.env.RAT_AGENTS_LIVE_MAX_TURNS ?? 4),
  maxObservedTokens: scenario?.maxObservedTokens ?? 1_200_000,
  maxToolItems: scenario?.maxToolCalls ?? 120,
  maxActiveMs: (scenario?.maxActiveMinutes ?? Number(process.env.RAT_AGENTS_LIVE_MAX_MINUTES ?? 35)) * 60_000,
  reviewMs: (scenario?.reviewMinutes ?? Number(process.env.RAT_AGENTS_LIVE_REVIEW_MINUTES ?? 10)) * 60_000,
};
assert(Number.isSafeInteger(limits.maxTurns) && limits.maxTurns > 0 && limits.maxTurns <= 20);
assert(Number.isFinite(limits.maxActiveMs) && limits.maxActiveMs > 0 && limits.maxActiveMs <= 60 * 60_000);
assert(Number.isFinite(limits.reviewMs) && limits.reviewMs > 0 && limits.reviewMs <= 30 * 60_000);
const participants = (scenario?.participants ?? [
  { name: 'claude', label: 'Claude · Claude Code' },
  { name: 'codex', label: 'Codex · Codex CLI' },
]).map(({ name, label }) => ({ name, token: randomUUID(), actor: { id: `agent-${name}`, kind: 'workload' as const, label, issuer: 'local-demo-fixture', subject: name }, permissions: rolePermissions('collaborator') }));

const services = createLocalServices({ directory });
const account = await services.subscription.status();
assert(account.signed_in, `Sign in first: RAT_THINGS_LOCAL_DIR=${directory} npm run rat-things -- login`);
const catalog = await services.models();
assert(catalog, 'The subscription returned no model catalog.');
const model = process.env.RAT_AGENTS_LIVE_MODEL;
assert(model, `Set RAT_AGENTS_LIVE_MODEL to one of: ${catalog.data.map(entry => entry.id).join(', ')}`);
assert(catalog.data.some(entry => entry.id === model), `Model ${model} is not in this subscription's catalog; no fallback is used.`);

const instructions = scenario?.instructions ?? [
  'You are the shared agent in a multiplayer Rat Things Session on this computer.',
  'Two AI participants contribute: Claude (Claude Code) and Codex (Codex CLI). Each message names its sender.',
  'Address participants by name, weigh both views and make one concrete decision per reply. Keep replies under 120 words.',
  'Write deliverables to /workspace/outputs. /workspace/outputs/index.html is shown to everyone in the shared browser.',
].join(' ');
const title = process.env.RAT_AGENTS_LIVE_TITLE ?? 'Claude + Codex make a demo';
const placeholder = '<!doctype html><meta charset="utf-8"><title>Demo plan</title><body style="margin:0;background:#181819;color:#f7f8f8;font:22px system-ui;padding:64px"><h1 style="font-weight:600">Demo plan</h1><p style="color:#8a8f98">Waiting for the team’s brief.</p>';

let sessionId: string | undefined;
const activeStartedAt = Date.now();
let budgetPhase: BudgetPhase = 'active';
let reviewStartedAt: number | undefined;
let reviewReason: string | undefined;
let cancellationStatus: 'not_needed' | 'requested' | 'failed' = 'not_needed';
let cancellationError: string | undefined;
let observedUsage = { turns: 0, observed_tokens: null as number | null, tool_items: 0, token_usage_pending: true };
let artifactExport: { status: 'written'; path: string; artifact_id: string } | { status: 'unavailable' | 'failed'; detail: string } = { status: 'unavailable', detail: 'Session has not produced an HTML artifact.' };
let monitor: NodeJS.Timeout | undefined;
let monitoring = false;
const enterReview = async (reason: string, activeTurnIds: readonly string[]) => {
  if (budgetPhase === 'review') return;
  budgetPhase = 'review';
  reviewStartedAt = Date.now();
  reviewReason = reason;
  if (activeTurnIds.length === 0) return;
  cancellationStatus = 'requested';
  try {
    await services.sessions.events(LOCAL_OWNER, sessionId!, { events: [{ type: 'agent.session.input.cancel' }] }, `agents-live-budget-${reason}-${sessionId}`);
  } catch (error) {
    cancellationStatus = 'failed';
    cancellationError = error instanceof Error ? error.message : String(error);
    console.error(`Could not cancel the active Turn after ${reason}: ${cancellationError}`);
  }
};
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
  const space = { id: 'space_agents', name: scenario ? 'Taco Cometa team' : 'Claude + Codex', role: 'collaborator', permissions: person.permissions };
  const route = classifyDemoRoute(request.method, path, sessionId ?? '');
  let response: Response;
  if (route.kind === 'deny') response = Response.json({ error: { message: 'Route is not available through this demo.', code: 'resource_not_found' } }, { status: 404 });
  else if (route.kind === 'inference' && (budgetPhase === 'review' || (await services.sessions.turns(LOCAL_OWNER, sessionId!)).data.length >= limits.maxTurns)) {
    response = Response.json({ error: { message: budgetPhase === 'review' ? 'Simulation inference is paused for team review.' : `Demo Turn limit (${limits.maxTurns}) reached.`, code: 'demo_budget' } }, { status: 429 });
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

const connection = process.env.RAT_AGENTS_LIVE_CONNECTION ?? join(directory, 'agents-live.json');
let closing: Promise<number> | undefined;
const close = () => closing ??= (async () => {
  if (monitor) clearInterval(monitor);
  const workerVolume = sessionId ? localWorkerNames(workspaceId, sessionId).volume : undefined;
  const stateVolume = workerVolume ? `${workerVolume}-state` : undefined;
  const result = await cleanupAgentsLive({
    stopServer: async () => {
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolveClose, rejectClose) => server.close(error => error ? rejectClose(error) : resolveClose()));
    },
    readTurns: async (): Promise<LiveTurnUsage[]> => {
      if (!sessionId) return [];
      const activity = await services.sessions.activity(LOCAL_OWNER, sessionId, participants[0]);
      await writeFile(join(output, 'activity.json'), JSON.stringify(activity, null, 2));
      const turns = (await services.sessions.turns(LOCAL_OWNER, sessionId)).data;
      const reportedUsage = activity.turns.some(turn => turn.usage != null);
      observedUsage = { turns: turns.length, observed_tokens: reportedUsage ? activity.turns.reduce((sum, turn) => sum + (turn.usage?.total_tokens ?? 0), 0) : null,
        tool_items: activity.items.filter(item => ['command_execution', 'mcp_call', 'function_call', 'tool_call'].includes(item.type)).length, token_usage_pending: activity.turns.some(turn => turn.usage == null) };
      await exportLatestHtml();
      return turns;
    },
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
      budget: { phase: budgetPhase, reason: reviewReason ?? null, cancellation_status: cancellationStatus,
        ...(cancellationError ? { cancellation_error: cancellationError } : {}),
        active_elapsed_ms: Math.max(0, (reviewStartedAt ?? Date.now()) - activeStartedAt),
        review_elapsed_ms: reviewStartedAt === undefined ? null : Math.max(0, Date.now() - reviewStartedAt),
        limits: { max_turns: limits.maxTurns, max_observed_tokens: limits.maxObservedTokens, max_tool_items: limits.maxToolItems, max_active_ms: limits.maxActiveMs, review_ms: limits.reviewMs } },
      artifact_export: artifactExport,
      observed_usage: observedUsage,
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
async function exportLatestHtml() {
  try {
    const artifacts = (await services.sessions.artifacts(LOCAL_OWNER, sessionId!, { limit: 100 })).data
      .filter((artifact: { path: string }) => /\.html?$/i.test(artifact.path))
      .sort((a: { created_at: number }, b: { created_at: number }) => b.created_at - a.created_at);
    const artifact = artifacts[0];
    if (!artifact) { artifactExport = { status: 'unavailable', detail: 'Session has no HTML artifact.' }; return; }
    if (artifact.size_bytes > 1_048_576) { artifactExport = { status: 'failed', detail: 'Latest HTML artifact exceeds the 1 MiB export limit.' }; return; }
    const stream = await services.sessions.artifactContent(LOCAL_OWNER, sessionId!, artifact.id);
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > 1_048_576) { await reader.cancel(); artifactExport = { status: 'failed', detail: 'Latest HTML artifact exceeded the 1 MiB export limit while reading.' }; return; }
        chunks.push(next.value);
      }
    } finally { reader.releaseLock(); }
    const path = join(output, 'latest.html');
    await writeFile(path, Buffer.concat(chunks));
    artifactExport = { status: 'written', path, artifact_id: artifact.id };
  } catch (error) {
    artifactExport = { status: 'failed', detail: error instanceof Error ? error.message : String(error) };
  }
}
if (scenario || limits.maxActiveMs > 0) {
  monitor = setInterval(() => void (async () => {
    if (!sessionId || closing || monitoring) return;
    monitoring = true;
    try {
    const activity = await services.sessions.activity(LOCAL_OWNER, sessionId, participants[0]);
    const tokens = activity.turns.reduce((sum, turn) => sum + (turn.usage?.total_tokens ?? 0), 0);
    const calls = activity.items.filter(item => ['command_execution', 'mcp_call', 'function_call', 'tool_call'].includes(item.type)).length;
    const turns = (await services.sessions.turns(LOCAL_OWNER, sessionId)).data;
    const reportedUsage = activity.turns.some(turn => turn.usage != null);
    observedUsage = { turns: turns.length, observed_tokens: reportedUsage ? tokens : null, tool_items: calls, token_usage_pending: activity.turns.some(turn => turn.usage == null) };
    const activeTurnIds = turns.filter(turn => !['completed', 'failed', 'cancelled', 'declined'].includes(turn.status)).map(turn => turn.id);
    const decision = budgetDecision(limits, {
      phase: budgetPhase,
      turns: turns.length,
      ...(activity.turns.some(turn => turn.usage != null) ? { observedTokens: tokens } : {}),
      toolItems: calls,
      activeElapsedMs: Date.now() - activeStartedAt,
      reviewElapsedMs: reviewStartedAt === undefined ? 0 : Date.now() - reviewStartedAt,
      activeTurnIds,
    });
    if (decision.action === 'enter_review') {
      console.error(`Simulation entering review mode: ${decision.reason}.`);
      await enterReview(decision.reason, decision.cancelTurnIds);
    } else if (decision.action === 'cleanup') {
      console.error('Simulation review deadline reached; exporting evidence and cleaning up.');
      process.exitCode = await close();
      process.exit(process.exitCode);
    }
    } finally { monitoring = false; }
  })().catch(error => console.error(String(error))), 2000);
  monitor.unref();
}
process.stdin.resume(); process.stdin.on('end', () => { void close().then(code => process.exit(code)); });
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { void close().then(code => process.exit(code)); });

try {
  const session = await services.sessions.create(LOCAL_OWNER, {
    metadata: { name: title },
    agent: { model, instructions, reasoning: { effort: 'low' }, multi_agent: { enabled: false }, tools: [sharedBrowserTool] },
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
