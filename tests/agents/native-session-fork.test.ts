import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, realpath, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { SessionRuntime } from '../../src/runner/session-runtime.js';
import { copyForkTree } from '../../src/runner/fork-workspace.js';
import type { Turn } from '../../src/domain/agents-api.js';

it('forks a copied CODEX_HOME at a new absolute path through the captured Turn with fresh policy', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rat-native-fork-')));
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    if (!request.url?.endsWith('/responses')) { response.writeHead(404).end(); return; }
    requests.push(JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>);
    const id = `response_${requests.length}`;
    const item = { type: 'message', role: 'assistant', id: `msg_${requests.length}`, content: [{ type: 'output_text', text: 'Ready' }], phase: 'final_answer' };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end([{ type: 'response.created', response: { id } }, { type: 'response.output_item.done', item },
      { type: 'response.completed', response: { id, usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } }]
      .map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  const runtimes: SessionRuntime[] = [];
  const create = (id: string, fork?: { rootThreadId: string; lastNativeTurnId: string | null }, previous?: import('../../src/core/session-runtime-planning.js').SessionRuntimeState) => {
    const state = join(root, id);
    const runtime = new SessionRuntime({ sessionId: id, agentId: 'agent', ...(fork ? { fork } : {}), ...(previous ? { previous } : {}), request: {
      binary: process.env.CODEX_CONFORMANCE_BINARY ?? resolve('node_modules/.bin/codex'), workspace: join(state, 'workspace'),
      environment: { PATH: process.env.PATH, HOME: state, CODEX_HOME: join(state, 'codex-home'), CODEX_SQLITE_HOME: join(state, 'local-sqlite') },
      timeoutMs: 25000, persistent: true, prompt: '', sandbox: id === 'source' ? 'danger-full-access' : 'read-only', networkAccess: false, environments: [], model: 'gpt-5.4', modelProvider: 'fixture',
      developerInstructions: 'PINNED_AGENT_INSTRUCTIONS', webSearch: 'disabled',
      dynamicTools: [{ type: 'function', name: 'lookup', description: 'Lookup', inputSchema: { type: 'object', properties: {} } }],
      sessionConfig: { 'model_providers.fixture': { name: 'fixture', base_url: `http://127.0.0.1:${address.port}`, wire_api: 'responses', requires_openai_auth: false, supports_websockets: false }, 'features.multi_agent': false, 'features.paginated_threads': false },
    } });
    runtimes.push(runtime); return runtime;
  };
  const turn = (session: string, id: string): Turn => ({ id, object: 'agent.session.turn', session_id: session, agent_id: 'agent', subagent_id: null, status: 'queued', created_at: 1, started_at: null, completed_at: null, usage: null, error: null });
  const complete = async (runtime: SessionRuntime, session: string, id: string, text: string) => {
    await runtime.start(turn(session, id), [{ role: 'user', content: [{ type: 'input_text', text }] }]);
    for (let attempt = 0; attempt < 1000; attempt++) { if (runtime.snapshot().turns.find(entry => entry.turn.id === id)?.turn.status === 'completed') return; await delay(10); }
    throw new Error('Native Turn did not complete');
  };
  try {
    await mkdir(join(root, 'source/workspace'), { recursive: true });
    await mkdir(join(root, 'source/codex-home'), { recursive: true });
    await mkdir(join(root, 'source/local-sqlite'), { recursive: true });
    await mkdir(join(root, 'child/local-sqlite'), { recursive: true });
    await writeFile(join(root, 'source/workspace/marker'), 'prepared');
    const source = create('source'); await source.initialize();
    await complete(source, 'source', 'first', 'PREFORK_CONTEXT');
    const snapshot = source.snapshot();
    const boundary = snapshot.turns[0]!.nativeTurnId!;
    await complete(source, 'source', 'later', 'AFTER_BOUNDARY_MUST_BE_EXCLUDED');
    await source.close();
    await copyForkTree(join(root, 'source'), join(root, 'child'), snapshot.rootThreadId);
    await rm(join(root, 'source'), { recursive: true, force: true });
    let child = create('child', { rootThreadId: snapshot.rootThreadId, lastNativeTurnId: boundary });
    const initial = await child.initialize();
    expect(initial.rootThreadId).not.toBe(snapshot.rootThreadId);
    expect(initial.turns).toEqual([]); expect(initial.subagents).toEqual([]);
    // A fork with no initial input can be replaced before its first new Turn.
    await child.close();
    child = create('child', undefined, initial);
    expect((await child.initialize()).turns).toEqual([]);
    await complete(child, 'child', 'branch', 'Continue');
    const payload = JSON.stringify(requests.at(-1));
    expect(payload).toContain('PREFORK_CONTEXT');
    expect(payload).not.toContain('AFTER_BOUNDARY_MUST_BE_EXCLUDED');
    expect(payload).toContain('PINNED_AGENT_INSTRUCTIONS');
    const metadata = requests.at(-1)!.client_metadata as Record<string, string>;
    expect(JSON.parse(metadata['x-codex-turn-metadata']!).sandbox_mode).toBe('read-only');
    expect(payload).toContain('lookup');
    expect(payload).not.toContain('web_search_preview');
    expect(child.snapshot().turns[0]!.turn.usage?.total_tokens).toBe(5);
    expect(await readFile(join(root, 'child/workspace/marker'), 'utf8')).toBe('prepared');
  } finally {
    for (const runtime of runtimes) await runtime.close();
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 30000);
