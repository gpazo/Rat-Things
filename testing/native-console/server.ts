import { iamApiPrincipal } from '../../src/domain/api-permissions.js';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { CredentialAuthCreateParam } from 'openai/resources/beta/agents/vaults/credentials';
import { AgentService } from '../../src/core/agent-service.js';
import { createModelCatalog, type ModelCatalog } from '../../src/core/model-catalog.js';
import { SessionService } from '../../src/core/session-service.js';
import { VaultService } from '../../src/core/vault-service.js';
import { EnvironmentService } from '../../src/core/environment-service.js';
import { EnvironmentTemplateService } from '../../src/core/environment-template-service.js';
import type { SessionExecution, SessionTurnObservation } from '../../src/core/session-ports.js';
import type { AgentSessionItem } from '../../src/domain/agents-api.js';
import { routeAgentsRequest } from '../../src/lambdas/agents-router.js';
import { MemoryAgentsStore } from '../../tests/agents/fixtures.js';

const owner = 'console-owner';
const store = new MemoryAgentsStore();
const secrets = new Map<string, CredentialAuthCreateParam>();
const observations = new Map<string, SessionTurnObservation>();
const output = new Map<string, AgentSessionItem[]>();
const received: Array<{ path: string; method: string; body?: unknown; key?: string | null }> = [];
const browser = process.env.RAT_THINGS_BROWSER_FIXTURE === '1' ? await (await import('./browser-fixture.js')).createBrowserFixture() : undefined;
const execution: SessionExecution = browser?.execution ?? {
  prepare: async (ownerId, sessionId, environment) => {
    if (environment.type === 'self_hosted') throw new Error('This fixture has no self-hosted relay');
    return environments.prepare(ownerId, sessionId, environment);
  },
  start: async (_owner, _session, binding) => {
    if (!observations.has(binding.turn.id)) observations.set(binding.turn.id, { turn: { ...binding.turn, started_at: binding.turn.created_at, status: 'in_progress' }, requiredActions: [] });
  },
  steer: async () => {},
  cancel: async (_owner, _session, id) => {
    const current = observations.get(id)!;
    observations.set(id, { turn: { ...current.turn, status: 'cancelled', completed_at: Math.floor(Date.now() / 1000) }, requiredActions: [] });
  },
  toolResult: async (_owner, _session, event) => {
    const current = observations.get(event.turn_id)!;
    observations.set(event.turn_id, { turn: { ...current.turn, status: 'in_progress' }, requiredActions: [] });
  },
  observe: async (_owner, _session, turn) => observations.get(turn.id) ?? { turn, requiredActions: [] },
  items: async (_owner, _session, id) => output.get(id) ?? [],
  artifacts: async (_owner, session, turn) => [{ artifact: { id: `artifact-${turn}`, object: 'agent.session.artifact', session_id: session.id, environment_id: 'fixture-env', created_at: session.created_at, path: 'report.txt', size_bytes: 23, turn_id: turn }, content: { bucket: 'fixture', key: turn, sha256: '0'.repeat(64) } }],
  artifactContent: async () => new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('Native console artifact')); controller.close(); } }),
};
let modelMode: 'available' | 'empty' | 'empty-response' | 'error' | 'retired' | 'no-default' = 'available';
function fixtureModels(): ModelCatalog | undefined {
  if (browser) return createModelCatalog({ modelIds: ['fixture-browser'], defaultModel: 'fixture-browser' });
  if (modelMode === 'error') return undefined;
  // Exercise a valid wire shape with no options, independently of configuration validation.
  if (modelMode === 'empty') return { object: 'list', data: [] };
  const modelIds = modelMode === 'retired' ? ['fixture-fast'] : ['fixture-model', 'fixture-fast'];
  const catalog = createModelCatalog({ modelIds, ...(modelMode === 'no-default' ? {} : { defaultModel: modelIds[0]! }) });
  if (!catalog) throw new Error('Invalid fixture model catalog');
  return { ...catalog, data: catalog.data.map(model => ({ ...model, display_name: model.id === 'fixture-model' ? 'Review model' : 'Fast model' })) };
}
const agents = new AgentService({ store });
const sessions = new SessionService({ store, agents, execution, streamIntervalMs: 20 });
const templates = new EnvironmentTemplateService({ store });
// Real template resolution and stored environment state; no VM is provisioned.
const environments = new EnvironmentService({ store, templates,
  credentials: { create: async () => 'unused', read: async () => ({ harness: '', executor: '' }), revoke: async () => {} },
  managedFiles: async () => [],
});
const vaults = new VaultService({ store, secrets: {
  create: async (_owner, id, auth) => { const ref = `${id}/${crypto.randomUUID()}`; secrets.set(ref, structuredClone(auth)); return ref; },
  read: async (ref) => structuredClone(secrets.get(ref)!),
  revoke: async (ref) => { secrets.delete(ref); },
} });

// A gate makes transient UI states observable without relying on network timing.
let releaseReads: (() => void) | undefined;
let readGate: Promise<void> | undefined;
let failReads = false;
const server = createServer((request, response) => void (async () => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks).toString();
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (browser && url.pathname === '/__test/browser') {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ request: browser.request, evidence: browser.state() }));
    return;
  }
  if (url.pathname === '/__test/state') {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ received, secretCount: secrets.size, sessionCount: (await sessions.list(owner)).data.length }));
    return;
  }
  if (url.pathname === '/__test/reads') {
    const control = JSON.parse(body) as { hold?: boolean; fail?: boolean };
    releaseReads?.();
    releaseReads = undefined;
    readGate = control.hold ? new Promise<void>(resolve => { releaseReads = resolve; }) : undefined;
    failReads = control.fail ?? false;
    response.end('{}');
    return;
  }
  if (url.pathname === '/__test/models') {
    const { mode } = JSON.parse(body) as { mode: string };
    if (mode !== 'available' && mode !== 'empty' && mode !== 'empty-response' && mode !== 'error' && mode !== 'retired' && mode !== 'no-default') {
      response.writeHead(400); response.end('{}'); return;
    }
    modelMode = mode;
    response.end('{}');
    return;
  }
  if (url.pathname === '/__test/seed') {
    for (let index = 0; index < 26; index++) await agents.create(owner, { model: 'fixture-model', name: `Agent ${index}` });
    response.end('{}');
    return;
  }
  if (url.pathname === '/__test/advance') {
    const { mode } = JSON.parse(body) as { mode: string };
    for (const session of (await sessions.list(owner)).data) {
      await sessions.dispatch(owner, session.id);
      const turn = (await sessions.turns(owner, session.id)).data.find(row => row.subagent_id === null);
      if (!turn) continue;
      const current = observations.get(turn.id)!;
      if (mode === 'question') {
        observations.set(turn.id, { turn: { ...current.turn, status: 'waiting' }, requiredActions: [{ type: 'function_call', name: 'lookup', arguments: { name: 'release' }, call_id: 'call-lookup', turn_id: turn.id }] });
      } else if (mode === 'complete') {
        output.set(turn.id, [{ id: `output-${turn.id}`, type: 'message', role: 'assistant', phase: 'final_answer', status: 'completed', turn_id: turn.id, content: [{ type: 'output_text', text: 'Review complete.\n\nThe **native console** restored this saved answer.\n\n```sh\nnpm run check\n```\n\n[Runbook](https://example.com/runbook)\n\n[Unsafe](javascript:alert%281%29) <img src="https://invalid.test/tracker">' }] }]);
        observations.set(turn.id, { turn: { ...current.turn, status: 'completed', completed_at: Math.floor(Date.now() / 1000) }, requiredActions: [] });
        await sessions.completeTurn(owner, session.id, turn.id);
      }
    }
    response.end('{}');
    return;
  }
  const abort = new AbortController();
  response.once('close', () => abort.abort());
  const input = new Request(`http://127.0.0.1${request.url}`, { method: request.method ?? 'GET', headers: request.headers as Record<string, string>, ...(body ? { body } : {}), signal: abort.signal });
  received.push({ path: url.pathname, method: input.method, ...(body ? { body: JSON.parse(body) } : {}), key: input.headers.get('idempotency-key') });
  if (input.method === 'GET') {
    await readGate;
    if (failReads) {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Fixture read failed' } }));
      return;
    }
  }
  const routed = await routeAgentsRequest(input, iamApiPrincipal(request.headers['x-runtime-owner'] === owner ? owner : ''), { agents, sessions, vaults, templates, models: fixtureModels() });
  // An adverse wire response exercises the desktop's empty-state handling after real authentication/routing.
  const result = modelMode === 'empty-response' && input.method === 'GET' && url.pathname === '/v1/models' && routed.ok
    ? Response.json({ object: 'list', data: [] }) : routed;
  const headers: Record<string, string> = {};
  result.headers.forEach((value, key) => { headers[key] = value; });
  response.writeHead(result.status, headers);
  response.flushHeaders();
  if (result.body) await pipeline(Readable.fromWeb(result.body as import('node:stream/web').ReadableStream), response);
  else response.end();
})().catch((error: unknown) => { console.error(error); if (!response.headersSent) response.writeHead(500); response.end(); }));
server.listen(0, '127.0.0.1');
await once(server, 'listening');
process.stdout.write(`${JSON.stringify({ port: (server.address() as AddressInfo).port })}\n`);
let dispatching = false;
const dispatcher = setInterval(() => {
  if (dispatching) return;
  dispatching = true;
  void (async () => {
    for (const session of (await sessions.list(owner)).data) await sessions.dispatch(owner, session.id);
  })().catch(error => console.error(error)).finally(() => { dispatching = false; });
}, 30);
let stopping = false;
function stop(): void {
  if (stopping) return;
  stopping = true; clearInterval(dispatcher); process.stdin.destroy(); server.closeAllConnections(); server.close();
  void browser?.close().catch(error => { console.error(error); process.exitCode = 1; });
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.stdin.resume();
process.stdin.once('end', stop);
