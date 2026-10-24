import OpenAI from 'openai';
import { LocalTransferService } from '../../src/app/local-transfer.js';
import { AgentsApiError } from '../../src/domain/agents-api-validation.js';
import { iamApiPrincipal } from '../../src/domain/api-permissions.js';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { CredentialAuthCreateParam } from 'openai/resources/beta/agents/vaults/credentials';
import { piCatalog } from '../../src/adapters/pi-model-catalog.js';
import { AgentService } from '../../src/core/agent-service.js';
import { createModelCatalog, createPiModelCatalog, type ModelCatalog } from '../../src/core/model-catalog.js';
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
const executionStarts: string[] = [];
const received: Array<{ path: string; method: string; body?: unknown; key?: string | null }> = [];
const browser = process.env.RAT_THINGS_BROWSER_FIXTURE === '1' ? await (await import('./browser-fixture.js')).createBrowserFixture() : undefined;
const execution: SessionExecution = browser?.execution ?? {
  prepare: async (ownerId, sessionId, environment) => {
    if (environment.type === 'self_hosted') throw new Error('This fixture has no self-hosted relay');
    return environments.prepare(ownerId, sessionId, environment);
  },
  start: async (_owner, _session, binding) => {
    executionStarts.push(binding.turn.id);
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
const piModels = piCatalog(['amazon.nova-micro-v1:0', 'amazon.nova-2-lite-v1:0', 'us.anthropic.claude-sonnet-4-6'], 'us-west-2');
const sessions = new SessionService({ store, agents, execution, piCatalog: piModels, streamIntervalMs: 20 });
const templates = new EnvironmentTemplateService({ store });
// Real template resolution and stored environment state; no VM is provisioned.
const environments = new EnvironmentService({ store, templates,
  credentials: { create: async () => 'unused', read: async () => ({ harness: '', executor: '' }), revoke: async () => {} },
  managedFiles: async () => [],
  // Transfer uploads remain fixture ports; Session import resolves real environment settings.
  uploadedFiles: {
    retrieve: async (_owner, id) => ({ id, object: 'file', filename: 'workspace', bytes: 100,
      created_at: 1, purpose: 'user_data', status: 'processed' }),
    reference: async (_owner, id) => ({ bucket: 'fixture', key: id, sha256: '0'.repeat(64) }),
  },
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
// Direct helper protocol for held workspace transitions; other tests use the real proxy.
const workspaceFixture = process.env.RAT_THINGS_WORKSPACE_FIXTURE === '1';
let workspace = { kind: 'local', name: 'This computer', endpoint: '', region: '' };
let releaseLocal: (() => void) | undefined;
let localGate: Promise<void> | undefined;
let releaseAccount: (() => void) | undefined;
let accountGate: Promise<void> | undefined;
let releaseChange: (() => void) | undefined;
let changeGate: Promise<void> | undefined;
let releaseLogin: (() => void) | undefined;
let loginGate: Promise<void> | undefined;
let failLocal = false;
let failRuntime = false;
let failAccount = false;
let failChangePoll = false;
let nativeRuntime = false;
let signedIn = true;
let dropChangeResponse = false;
let failChangeResponse = false;
let dropLoginResponse = false;
let nativeInstallation = { state: 'needs_setup', active: null as string | null, previous: null as string | null, pending: null as string | null, generation: 0, failure: null };
const runtimeChanges = new Map<string, { id: string; action: string; status: string; phase?: string; failure?: string; created_at: number; updated_at: number }>();
let loginFlow: { id: string; url: string } | undefined;
// Exercise durable copy orchestration and import idempotency with deterministic external ports.
// Neither transport falls through to the network or resolves the AWS credential chain.
let copyModels = ['fixture-fast'];
const copyModelGates = new Map<string, { promise: Promise<void>; release: () => void }>();
let copyUploadGate: { promise: Promise<void>; release: () => void } | undefined;
let loseImportResponse = false;
let loseExecuteResponse = false;
const copyRequests: Array<{ url: string; method: string; body?: unknown }> = [];
const copyModelRequests: Array<{ baseURL: string; region: string; complete: boolean }> = [];
const copySnapshots: string[] = [];
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};
const copyCatalog = () => ({ object: 'list', default_model: copyModels[0],
  data: copyModels.map(id => ({ id, object: 'model', display_name: id === 'fixture-model' ? 'Review model' : 'Fast model' })) });
const makeTransfers = () => new LocalTransferService({ store, sessions, environments, owner,
  snapshot: async id => {
    copySnapshots.push(id);
    return [{ path: 'notes.txt', mode: 0o644, data: Buffer.from('Preserved local workspace').toString('base64') }];
  },
  modelsFetch: destination => async () => {
    // Capture both response and gate at request time: changing controls cannot rewrite an old response.
    const catalog = copyCatalog();
    const held = copyModelGates.get(destination.baseURL);
    const observed = { baseURL: destination.baseURL, region: destination.region, complete: false };
    copyModelRequests.push(observed);
    await held?.promise;
    observed.complete = true;
    return Response.json(catalog);
  },
  client: destination => new OpenAI({ apiKey: 'fixture', baseURL: destination.baseURL, maxRetries: 0,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (request.method === 'GET' && path === '/v1/agents/sessions/import') {
        copyRequests.push({ url: request.url, method: request.method });
        return Response.json({ version: 1, max_history_bytes: 2 * 1024 * 1024,
          credentials: 'destination', execution: 'on_next_message' });
      }
      if (request.method === 'POST' && path === '/v1/files') {
        copyRequests.push({ url: request.url, method: request.method, body: 'workspace archive' });
        await copyUploadGate?.promise;
        return Response.json({ id: 'file-copy-fixture' });
      }
      if (request.method === 'POST' && path === '/v1/agents/sessions/import') {
        const body: unknown = await request.json();
        copyRequests.push({ url: request.url, method: request.method, body });
        const imported = await sessions.import('copy-destination', body);
        if (loseImportResponse) { loseImportResponse = false; throw new Error('Response lost after commit'); }
        return Response.json(imported);
      }
      throw new Error(`Unexpected copy transport request: ${request.method} ${request.url}`);
    },
  }),
});
let transfers = makeTransfers();
const server = createServer((request, response) => void (async () => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks).toString();
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (workspaceFixture && url.pathname === '/__test/copies') {
    const control = JSON.parse(body) as { models?: string[]; hold_models?: string; release_models?: string;
      upload_hold?: boolean; lose_import_response?: boolean; lose_execute_response?: boolean; restart?: boolean };
    if (control.models) copyModels = control.models;
    if (control.hold_models) copyModelGates.set(control.hold_models, gate());
    if (control.release_models) {
      copyModelGates.get(control.release_models)?.release();
      copyModelGates.delete(control.release_models);
    }
    if (control.upload_hold === true) copyUploadGate ??= gate();
    if (control.upload_hold === false) { copyUploadGate?.release(); copyUploadGate = undefined; }
    if (control.lose_import_response !== undefined) loseImportResponse = control.lose_import_response;
    if (control.lose_execute_response !== undefined) loseExecuteResponse = control.lose_execute_response;
    if (control.restart) { await transfers.close(); transfers = makeTransfers(); }
    response.end('{}'); return;
  }
  if (url.pathname === '/__test/local') {
    const control = JSON.parse(body) as {
      hold?: boolean; fail?: boolean; runtime_fail?: boolean; account_fail?: boolean;
      account_hold?: boolean; change_hold?: boolean; login_hold?: boolean; change_poll_fail?: boolean; native?: boolean;
      signed_in?: boolean; drop_change_response?: boolean; fail_change_response?: boolean; drop_login_response?: boolean;
      installation?: Partial<typeof nativeInstallation>; change_state?: { status: string; phase?: string; failure?: string };
    };
    if (!control.hold) releaseLocal?.();
    localGate = control.hold ? localGate ?? new Promise<void>(resolve => { releaseLocal = resolve; }) : undefined;
    if (!control.account_hold) releaseAccount?.();
    accountGate = control.account_hold ? accountGate ?? new Promise<void>(resolve => { releaseAccount = resolve; }) : undefined;
    if (!control.change_hold) releaseChange?.();
    changeGate = control.change_hold ? changeGate ?? new Promise<void>(resolve => { releaseChange = resolve; }) : undefined;
    if (!control.login_hold) releaseLogin?.();
    loginGate = control.login_hold ? loginGate ?? new Promise<void>(resolve => { releaseLogin = resolve; }) : undefined;
    failLocal = control.fail ?? false;
    failRuntime = control.runtime_fail ?? false;
    failAccount = control.account_fail ?? false;
    failChangePoll = control.change_poll_fail ?? false;
    nativeRuntime = control.native ?? nativeRuntime;
    signedIn = control.signed_in ?? signedIn;
    if (control.signed_in === true) loginFlow = undefined;
    dropChangeResponse = control.drop_change_response ?? false;
    failChangeResponse = control.fail_change_response ?? false;
    dropLoginResponse = control.drop_login_response ?? false;
    if (control.installation) nativeInstallation = { ...nativeInstallation, ...control.installation };
    const latest = [...runtimeChanges.values()].at(-1);
    if (latest && control.change_state) {
      Object.assign(latest, control.change_state, { updated_at: Date.now() });
      if (latest.status === 'complete') nativeInstallation = { ...nativeInstallation, state: 'ready', active: 'runtime-current', pending: null };
      if (latest.status === 'awaiting_restart') nativeInstallation.pending = 'runtime-next';
    }
    response.end('{}'); return;
  }
  if (workspaceFixture && url.pathname.startsWith('/api/v1/workspace/')) {
    received.push({ path: url.pathname, method: request.method ?? 'GET', ...(body ? { body: JSON.parse(body) } : {}), key: null });
    response.setHeader('content-type', 'application/json');
    const fail = (message: string, status = 503) => { response.writeHead(status); response.end(JSON.stringify({ error: { message } })); };
    if (url.pathname === '/api/v1/workspace/transfers' || url.pathname.startsWith('/api/v1/workspace/transfers/')) {
      try {
        const path = url.pathname.slice('/api/v1/workspace/transfers'.length);
        const result = path === '/models' && request.method === 'POST' ? await transfers.models(JSON.parse(body))
          : path === '' && request.method === 'POST' ? await transfers.create(JSON.parse(body))
          : path === '' && request.method === 'GET' ? await transfers.list({
            ...(url.searchParams.has('limit') ? { limit: Number(url.searchParams.get('limit')) } : {}),
            ...(url.searchParams.has('after') ? { after: url.searchParams.get('after') } : {}),
          })
          : /^\/[a-f0-9-]{36}$/.test(path) && request.method === 'POST' ? await transfers.execute(path.slice(1))
          : /^\/[a-f0-9-]{36}$/.test(path) && request.method === 'GET' ? await transfers.retrieve(path.slice(1))
          : undefined;
        if (result === undefined) { fail('Unknown transfer fixture route.', 404); return; }
        if (loseExecuteResponse && /^\/[a-f0-9-]{36}$/.test(path) && request.method === 'POST') {
          loseExecuteResponse = false;
          response.destroy();
          return;
        }
        response.end(JSON.stringify(result));
      } catch (error) {
        fail(error instanceof Error ? error.message : 'Transfer failed', error instanceof AgentsApiError ? error.status : 500);
      }
      return;
    }
    if (url.pathname === '/api/v1/workspace/runtime') {
      await localGate;
      if (failLocal) { fail('Local setup check failed. Try again.'); return; }
      if (failRuntime) { fail('Local runtime status is unavailable. Try checking setup again.'); return; }
      response.end(JSON.stringify({ ready: nativeRuntime ? nativeInstallation.state === 'ready' : true, engine: nativeRuntime ? 'native' : 'docker-desktop',
        ...(nativeRuntime ? { installation: nativeInstallation } : {}),
        checks: [{ id: 'engine', ready: true, message: 'Linux VM is running.' }] })); return;
    }
    if (url.pathname === '/api/v1/workspace/subscription') {
      await localGate; await accountGate;
      if (failLocal) { fail('Local setup check failed. Try again.'); return; }
      if (failAccount) { fail('ChatGPT account status is unavailable. Try checking setup again.'); return; }
      response.end(JSON.stringify({ harness: 'codex', provider: 'chatgpt', signed_in: signedIn, email: signedIn ? 'fixture@example.test' : null, plan: signedIn ? 'pro' : null })); return;
    }
    if (['/api/v1/workspace/runtime/setup', '/api/v1/workspace/runtime/rollback'].includes(url.pathname) && request.method === 'POST') {
      const input = JSON.parse(body) as { id: string };
      if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(input.id) || Object.keys(input).some(key => key !== 'id')) { fail('Supply only a runtime request UUID.', 400); return; }
      const action = url.pathname.endsWith('/rollback') ? 'rollback' : 'setup';
      const existing = runtimeChanges.get(input.id);
      if (existing && existing.action !== action) { fail('This request ID belongs to a different runtime action.', 409); return; }
      if (!existing && [...runtimeChanges.values()].some(change => ['queued', 'working'].includes(change.status))) { fail('A runtime change is already active.', 409); return; }
      const change = existing ?? { id: input.id, action, status: 'queued', created_at: Date.now(), updated_at: Date.now() };
      runtimeChanges.set(input.id, change);
      await changeGate;
      if (dropChangeResponse) { dropChangeResponse = false; response.destroy(); return; }
      if (failChangeResponse) { failChangeResponse = false; fail('The runtime request response is unavailable.'); return; }
      response.writeHead(202); response.end(JSON.stringify(change)); return;
    }
    if (url.pathname.startsWith('/api/v1/workspace/runtime/changes/') && request.method === 'GET') {
      if (failChangePoll) { fail('Runtime progress is temporarily unavailable.'); return; }
      const change = runtimeChanges.get(url.pathname.split('/').at(-1)!);
      if (!change) { fail('Runtime change not found.', 404); return; }
      response.end(JSON.stringify(change)); return;
    }
    if (url.pathname === '/api/v1/workspace/subscription/login' && request.method === 'POST') {
      const input = JSON.parse(body) as { id: string };
      if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(input.id) || Object.keys(input).some(key => key !== 'id')) { fail('Supply only a sign-in request UUID.', 400); return; }
      if (loginFlow && loginFlow.id !== input.id) { fail('A ChatGPT sign-in is already open.', 409); return; }
      loginFlow ??= { id: input.id, url: `https://auth.openai.com/fixture/${input.id}` };
      const flow = loginFlow;
      await loginGate;
      if (dropLoginResponse) { dropLoginResponse = false; response.destroy(); return; }
      response.end(JSON.stringify(flow)); return;
    }
    if (url.pathname.startsWith('/api/v1/workspace/subscription/login/') && request.method === 'DELETE') {
      if (loginFlow?.id === url.pathname.split('/').at(-1)) loginFlow = undefined;
      response.writeHead(204); response.end(); return;
    }
  }
  if (browser && url.pathname === '/__test/browser') {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ request: browser.request, evidence: browser.state() }));
    return;
  }
  if (url.pathname === '/__test/state') {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ received, executionStarts, copies: { requests: copyRequests, models: copyModelRequests, snapshots: copySnapshots, plans: (await transfers.list()).data, destinationSessions: (await sessions.list('copy-destination')).data }, runtimeChanges: [...runtimeChanges.values()], loginFlow: loginFlow ?? null, secretCount: secrets.size, sessionCount: (await sessions.list(owner)).data.length }));
    return;
  }
  if (url.pathname === '/__test/reads') {
    const control = JSON.parse(body) as { hold?: boolean; fail?: boolean };
    if (!control.hold) { releaseReads?.(); releaseReads = undefined; }
    readGate = control.hold ? readGate ?? new Promise<void>(resolve => { releaseReads = resolve; }) : undefined;
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
  if (workspaceFixture && url.pathname === '/api/v1/workspace') {
    if (request.method === 'POST') {
      await readGate;
      if (failReads) {
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'Workspace unavailable; your current workspace is still selected.' } }));
        return;
      }
      const next = JSON.parse(body) as typeof workspace;
      workspace = { ...next, name: next.kind === 'local' ? 'This computer' : 'Your AWS workspace' };
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(workspace));
    return;
  }
  const abort = new AbortController();
  response.once('close', () => abort.abort());
  const path = workspaceFixture ? request.url?.replace(/^\/api\/v1\//, '/v1/') : request.url;
  const input = new Request(`http://127.0.0.1${path}`, { method: request.method ?? 'GET', headers: request.headers as Record<string, string>, ...(body ? { body } : {}), signal: abort.signal });
  received.push({ path: url.pathname, method: input.method, ...(body ? { body: JSON.parse(body) } : {}), key: input.headers.get('idempotency-key') });
  if (input.method === 'GET') {
    await readGate;
    if (failReads) {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Fixture read failed' } }));
      return;
    }
  }
  const routed = await routeAgentsRequest(input, iamApiPrincipal(workspaceFixture || request.headers['x-runtime-owner'] === owner ? owner : ''), {
    agents, sessions, vaults, templates, models: fixtureModels(), piModels: createPiModelCatalog(piModels, piModels[0]!.id),
  });
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
  for (const held of copyModelGates.values()) held.release();
  copyUploadGate?.release();
  void transfers.close().catch(error => { console.error(error); process.exitCode = 1; });
  stopping = true; clearInterval(dispatcher); process.stdin.destroy(); server.closeAllConnections(); server.close();
  void browser?.close().catch(error => { console.error(error); process.exitCode = 1; });
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.stdin.resume();
process.stdin.once('end', stop);
