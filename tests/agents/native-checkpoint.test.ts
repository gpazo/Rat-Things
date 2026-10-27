import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { cp, mkdtemp, rename, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { CodexRpcClient, type CodexRpcEvent } from '../../src/adapters/codex-rpc.js';
import type { SessionRuntimeState } from '../../src/core/session-runtime-planning.js';
import type { Turn } from '../../src/domain/agents-api.js';
import type { WorkspaceCheckpoint } from '../../src/domain/workspace-checkpoint.js';
import { SessionRuntime, type SessionCheckpointOptions } from '../../src/runner/session-runtime.js';
import { WorkspaceAdmission } from '../../src/runner/workspace-handoff.js';
import { assertNativeHistory, nativeCheckpointEvidence } from '../../src/domain/native-checkpoint.js';
import { syncWorkspaceStorage } from '../../src/runner/workspace-sync.js';
import { createHash } from 'node:crypto';

// Uses the official unmodified binary. Model traffic stays on loopback.
// Host-only copies prove native continuation; the privileged guest test covers isolation.
const native = it.skipIf(process.env.CODEX_REQUIRE_PARITY !== 'true');
const binary = process.env.CODEX_CONFORMANCE_BINARY ?? resolve('node_modules/.bin/codex');
const sessionId = 'native_checkpoint_session';
const agentId = 'native_checkpoint_agent';
type ModelRequest = { input: Array<{ type?: string; recipient?: string; role?: string; content?: unknown }> };

native.each([{ paginated: false }, { paginated: true }])('checkpoints real root and child histories and continues them in a fresh process (paginated=$paginated)', async ({ paginated }) => {
  const fixture = await checkpointFixture({ paginated });
  try {
    const source = fixture.create();
    await source.initialize();
    await source.start(turn('first'), input('ROOT_INPUT_MARKER: delegate the fixture task.'));
    await until(() => {
      const state = source.snapshot();
      return state.subagents.length === 1 && state.turns.length === 2 && state.turns.every(binding => binding.turn.status === 'completed')
        && state.subagents.every(child => fixture.completedChildActivities.has(`${state.rootThreadId}:${child.id}`));
    }, 'root and child completion');
    const before = source.snapshot();
    const childId = before.subagents[0]!.id;
    const expectedIds = [before.rootThreadId, childId].sort();

    const checkpoint = await source.checkpoint() as WorkspaceCheckpoint;
    await source.finished;
    source.assertSuccessfulShutdown();
    expect(checkpoint.rootThreadId).toBe(before.rootThreadId);
    expect(checkpoint.nativeDurability?.historyModes).toEqual(paginated ? ['paginated'] : ['legacy', 'paginated']);
    expect(fixture.acknowledgedIds).toEqual([expectedIds]);
    // These host ports record ordering; this proves native journal handoff, not
    // an AWS filesystem snapshot, host journal implementation or worker replacement.
    expect(fixture.order).toEqual(['begin', 'native-exit', 'writers', 'journal', 'storage-sync', 'cold-verified', 'commit']);
    await expect(fixture.clients[0]!.call('thread/loaded/list', {})).rejects.toThrow('unavailable');

    const successor = fixture.create(before);
    const resumed = await successor.initialize();
    expect(resumed.rootThreadId).toBe(before.rootThreadId);
    expect(fixture.clients).toHaveLength(2);
    const freshClient = fixture.clients[1]!;
    const rootHistory = await freshClient.call('thread/turns/list', { threadId: before.rootThreadId, limit: 100, itemsView: 'full' });
    const childHistory = await freshClient.call('thread/turns/list', { threadId: childId, limit: 100, itemsView: 'full' });
    expect(JSON.stringify(rootHistory)).toContain('ROOT_DURABLE_MARKER');
    expect(JSON.stringify(childHistory)).toContain('CHILD_DURABLE_MARKER');

    await successor.start(turn('continued'), input('CONTINUE_CHECKPOINT: continue the existing child and root.'));
    await until(() => {
      const state = successor.snapshot();
      return state.turns.length === 4 && state.turns.every(binding => binding.turn.status === 'completed');
    }, 'resumed root and child completion');
    const after = successor.snapshot();
    expect(after.subagents.map(child => child.id)).toEqual([childId]);
    expect(after.rootThreadId).toBe(before.rootThreadId);
    expect(fixture.rootRequests).toHaveLength(4);
    expect(fixture.childRequests).toHaveLength(2);
    // The model inputs in the successor process must contain disk-restored
    // native history, independently of the host's saved SessionRuntimeState.
    expect(JSON.stringify(fixture.rootRequests[2])).toContain('ROOT_DURABLE_MARKER');
    expect(JSON.stringify(fixture.childRequests[1])).toContain('CHILD_DURABLE_MARKER');
    expect(JSON.stringify(after.turns.filter(binding => binding.turn.id === 'continued'))).toContain('ROOT_CONTINUED');
    expect(JSON.stringify(after.turns.filter(binding => binding.threadId === childId))).toContain('CHILD_CONTINUED');
  } finally { await fixture.close(); }
}, 60_000);

native('rejects a busy child without shutting down either thread', async () => {
  const fixture = await checkpointFixture({ paginated: false, holdChild: true });
  try {
    const runtime = fixture.create();
    const rootId = (await runtime.initialize()).rootThreadId;
    await runtime.start(turn('first'), input('ROOT_INPUT_MARKER: delegate the fixture task.'));
    await until(() => {
      const state = runtime.snapshot();
      return fixture.childRequests.length === 1 && state.subagents.length === 1
        && state.turns.some(binding => binding.turn.id === 'first' && binding.turn.status === 'completed')
        && state.turns.some(binding => binding.turn.subagent_id !== null && binding.turn.status === 'in_progress');
    }, 'busy child with idle root');
    const childId = runtime.snapshot().subagents[0]!.id;
    const rpc = fixture.clients[0]!;
    await expect(runtime.checkpoint()).rejects.toThrow('active turns');
    expect(fixture.order).toEqual([]);
    const loaded = await rpc.call('thread/loaded/list', { limit: 100 }) as { data: string[] };
    expect([...loaded.data].sort()).toEqual([rootId, childId].sort());
    expect(runtime.snapshot().turns.find(binding => binding.threadId === childId)?.turn.status).toBe('in_progress');
    fixture.releaseChild();
    await until(() => runtime.snapshot().turns.every(binding => binding.turn.status === 'completed')
      && fixture.completedChildActivities.has(`${rootId}:${childId}`), 'child completion after refused shutdown');
    await expect(runtime.checkpoint()).resolves.toMatchObject({ rootThreadId: rootId });
    expect(fixture.acknowledgedIds).toEqual([[rootId, childId].sort()]);
    expect(fixture.order.at(-1)).toBe('commit');
  } finally { await fixture.close(); }
}, 45_000);

async function checkpointFixture(options: { paginated: boolean; holdChild?: boolean }) {
  const historyMode = options.paginated ? 'paginated' : 'legacy';
  const home = await mkdtemp(join(tmpdir(), 'rat-native-checkpoint-'));
  const rootRequests: ModelRequest[] = [];
  const childRequests: ModelRequest[] = [];
  const order: string[] = [];
  const acknowledgedIds: string[][] = [];
  const clients: CodexRpcClient[] = [];
  const runtimes: SessionRuntime[] = [];
  const completedChildActivities = new Set<string>();
  let releaseChild = () => {};
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      if (!request.url?.endsWith('/responses')) { response.writeHead(404).end(); return; }
      const body = JSON.parse(Buffer.concat(chunks).toString()) as ModelRequest;
      const child = body.input.some(item => item.type === 'agent_message' && item.recipient === '/root/checkpoint_child');
      const requests = child ? childRequests : rootRequests;
      requests.push(body);
      const count = requests.length;
      const id = `${child ? 'child' : 'root'}_${count}`;
      const item = !child && count === 1
        ? tool(id, 'spawn_agent', { task_name: 'checkpoint_child', message: 'CHILD_INPUT_MARKER: complete the child task.', fork_turns: 'none' })
        : !child && count === 3
          ? tool(id, 'followup_task', { target: 'checkpoint_child', message: 'Continue the persisted child task.' })
          : { type: 'message', role: 'assistant', id: `message_${id}`, phase: 'final_answer', content: [{ type: 'output_text',
            text: child ? count === 1 ? 'CHILD_DURABLE_MARKER' : 'CHILD_CONTINUED' : count === 2 ? 'ROOT_DURABLE_MARKER' : 'ROOT_CONTINUED' }] };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ type: 'response.created', response: { id } })}\n\n`);
      const finish = () => completeResponse(response, id, item);
      if (child && count === 1 && options.holdChild) releaseChild = finish;
      else finish();
    } catch { response.destroy(new Error('Local checkpoint model fixture failed')); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  const create = (previous?: SessionRuntimeState) => {
    const checkpointPorts: SessionCheckpointOptions = {
      admission: new WorkspaceAdmission(),
      prepareNativeVerification: async () => ({
        close: async () => {},
        verify: async manifest => {
          const copyRoot = await mkdtemp(join(tmpdir(), 'rat-cold-checkpoint-copy-'));
          const candidate = join(copyRoot, 'candidate');
          const parked = join(copyRoot, 'original');
          const count = rootRequests.length + childRequests.length;
          await cp(home, candidate, { recursive: true });
          const digest = await fileDigest(candidate);
          await rename(home, parked);
          let verifier: CodexRpcClient | undefined;
          let activity = false;
          try {
            await cp(candidate, home, { recursive: true });
            verifier = new CodexRpcClient({ binary, cwd: home, environment: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home },
              onEvent: event => { if (event.requestId !== undefined || /^(turn\/(started|completed)|item\/|error$)/.test(event.method)) activity = true; } });
            await verifier.initialize();
            for (const expected of manifest.threads) {
              const result = await verifier.call('thread/read', { threadId: expected.id, includeTurns: true }) as { thread: unknown };
              assertNativeHistory(expected, result.thread, String(expected.id));
            }
            for (const expected of manifest.threads) {
              await verifier.call('thread/resume', { threadId: expected.id, deferGoalContinuation: true,
                ...(expected.id === manifest.rootThreadId ? { config: { 'model_providers.fixture': providerConfig(address.port), 'features.multi_agent': true, 'features.multi_agent_v2': true, 'features.goals': false } } : {}) });
              const result = await verifier.call('thread/read', { threadId: expected.id, includeTurns: true }) as { thread: unknown };
              assertNativeHistory(expected, result.thread, manifest.rootThreadId);
            }
            await verifier.closeCheckpoint();
            expect(activity).toBe(false);
            expect(rootRequests.length + childRequests.length).toBe(count);
            expect(await fileDigest(candidate)).toBe(digest);
            acknowledgedIds.push(manifest.threads.map(thread => String(thread.id)).sort());
            order.push('cold-verified');
            return nativeCheckpointEvidence(manifest);
          } finally {
            await verifier?.close(); await rm(home, { recursive: true, force: true }); await rename(parked, home);
            await rm(copyRoot, { recursive: true, force: true });
          }
        },
      }),
      begin: async () => { order.push('begin'); },
      stopRemainingWriters: async () => { order.push('writers'); },
      flushJournal: async () => { order.push('journal'); },
      syncStorage: async () => { await syncWorkspaceStorage(home); order.push('storage-sync'); },
      commit: async (state, nativeDurability) => {
        order.push('commit');
        return { ...(nativeDurability ? { nativeDurability } : {}), id: 'native-checkpoint', source: { runId: 'native-source', generation: 'generation' }, sandboxId: 'native-sandbox',
          setupDigest: 'a'.repeat(64), policyDigest: 'b'.repeat(64), rootThreadId: state.rootThreadId,
          lastRootTurnId: state.turns.filter(binding => binding.turn.subagent_id === null).at(-1)?.turn.id ?? null,
          lastNativeTurnId: state.turns.filter(binding => binding.turn.subagent_id === null).at(-1)?.nativeTurnId ?? null,
          createdAt: 1, reason: 'hibernate' };
      },
      abort: async () => { order.push('abort'); },
    };
    const runtime = new SessionRuntime({ sessionId, agentId, lifetime: 'host-managed', checkpoint: checkpointPorts,
      ...(previous ? { previous, requiredResumeThreadId: previous.rootThreadId } : {}),
      request: { binary, workspace: home, environment: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home },
        timeoutMs: 45_000, persistent: true, prompt: '', sandbox: 'read-only', networkAccess: false, environments: [], model: 'gpt-5.5', modelProvider: 'fixture',
        sessionConfig: { 'model_providers.fixture': { name: 'local checkpoint fixture', base_url: `http://127.0.0.1:${address.port}`,
          wire_api: 'responses', requires_openai_auth: false, supports_websockets: false, request_max_retries: 0, stream_max_retries: 0 },
        'features.multi_agent': true, 'features.multi_agent_v2': { enabled: true, max_concurrent_threads_per_session: 2 },
        'features.goals': false },
      },
      client: options => {
        const rpc = new CodexRpcClient({ ...options, onEvent: event => {
          // A child's turn/completed can precede the parent's final subAgentActivity
          // item/completed. Starting checkpoint between them correctly fails closed.
          // Wait for that real notification rather than assuming terminal Turns
          // imply that every native writer/event has settled.
          const activity = completedChildActivity(event);
          if (activity) completedChildActivities.add(activity);
          options.onEvent?.(event);
        } });
        clients.push(rpc);
        // Observe the real subprocess transport; never substitute RPC results.
        return { initialize: () => rpc.initialize(), close: () => rpc.close(),
          call: async (method, params, timeout) => {
            if (method === 'thread/checkpoint') throw new Error('Private checkpoint RPC is forbidden');
            return rpc.call(method, method === 'thread/start' ? { ...(params as object), historyMode } : params, timeout);
          },
          closeCheckpoint: async () => { await rpc.closeCheckpoint(); order.push('native-exit'); },
        };
      },
    });
    runtimes.push(runtime); return runtime;
  };
  return { create, clients, rootRequests, childRequests, order, acknowledgedIds, completedChildActivities, releaseChild: () => releaseChild(),
    close: async () => {
      releaseChild();
      for (const runtime of runtimes) await runtime.close();
      server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

function completedChildActivity(event: CodexRpcEvent): string | undefined {
  const { threadId, item } = event.params;
  if (event.method !== 'item/completed' || typeof threadId !== 'string' || !item || typeof item !== 'object'
    || !('type' in item) || item.type !== 'subAgentActivity' || !('kind' in item) || item.kind !== 'completed'
    || !('agentThreadId' in item) || typeof item.agentThreadId !== 'string') return undefined;
  return `${threadId}:${item.agentThreadId}`;
}

function completeResponse(response: ServerResponse, id: string, item: unknown): void {
  if (response.writableEnded || response.destroyed) return;
  response.end([{ type: 'response.output_item.done', item }, { type: 'response.completed', response: { id } }]
    .map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
}

function tool(id: string, name: string, args: Record<string, unknown>) {
  return { type: 'function_call', id: `function_${id}`, call_id: `call_${id}`, namespace: 'collaboration', name, arguments: JSON.stringify(args) };
}

function turn(id: string): Turn {
  return { id, object: 'agent.session.turn', session_id: sessionId, agent_id: agentId, subagent_id: null,
    status: 'queued', created_at: 1, started_at: null, completed_at: null, error: null, usage: null };
}

function input(text: string): import('../../src/domain/agents-api.js').AgentSessionInputMessageParam[] {
  return [{ role: 'user', content: [{ type: 'input_text', text }] }];
}

async function until(predicate: () => boolean, description: string): Promise<void> {
  for (let attempt = 0; attempt < 1_500; attempt++) { if (predicate()) return; await delay(10); }
  throw new Error(`Timed out waiting for ${description}`);
}

function providerConfig(port: number) { return { name: 'local checkpoint fixture', base_url: `http://127.0.0.1:${port}`, wire_api: 'responses', requires_openai_auth: false, supports_websockets: false, request_max_retries: 0, stream_max_retries: 0 }; }
async function fileDigest(root: string): Promise<string> {
  const hash = createHash('sha256');
  const visit = async (directory: string): Promise<void> => { for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name); hash.update(path.slice(root.length));
    if (entry.isDirectory()) await visit(path); else if (entry.isFile()) hash.update(await readFile(path)); else throw new Error('Unexpected fixture file');
  } };
  await visit(root); return hash.digest('hex');
}
