import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { SessionRuntime } from '../../src/runner/session-runtime.js';
import type { Turn } from '../../src/domain/agents-api.js';

it('resumes a durable native rollout after replacing worker-local SQLite databases', async () => {
  const home = await mkdtemp(join(tmpdir(), 'rat-sqlite-recovery-'));
  const requests: Array<{ input: unknown }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    if (!request.url?.endsWith('/responses')) { response.writeHead(404).end(); return; }
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    const id = `response_${requests.length}`;
    const item = { type: 'message', id: `message_${requests.length}`, role: 'assistant', phase: 'final_answer',
      content: [{ type: 'output_text', text: 'SAVED_NATIVE_ANSWER' }] };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end([{ type: 'response.created', response: { id } }, { type: 'response.output_item.done', item },
      { type: 'response.completed', response: { id } }].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  const runtime = (sqlite: string, resumeThreadId?: string) => new SessionRuntime({ sessionId: 'sess_sqlite', agentId: 'agent', request: {
    binary: process.env.CODEX_CONFORMANCE_BINARY ?? resolve('node_modules/.bin/codex'), workspace: home,
    environment: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, CODEX_SQLITE_HOME: join(home, sqlite) },
    timeoutMs: 20_000, persistent: true, prompt: '', sandbox: 'read-only', networkAccess: false, environments: [],
    model: 'gpt-5.4', modelProvider: 'fixture', ...(resumeThreadId ? { resumeThreadId } : {}),
    sessionConfig: { 'model_providers.fixture': { name: 'fixture', base_url: `http://127.0.0.1:${address.port}`,
      wire_api: 'responses', requires_openai_auth: false, supports_websockets: false } },
  } });
  const first = runtime('worker-one');
  let second: SessionRuntime | undefined;
  const turn = (id: string): Turn => ({ id, object: 'agent.session.turn', session_id: 'sess_sqlite', agent_id: 'agent', subagent_id: null,
    status: 'queued', created_at: 1, started_at: null, completed_at: null, error: null, usage: null });
  const complete = async (instance: SessionRuntime, id: string, text: string) => {
    await instance.start(turn(id), [{ role: 'user', content: [{ type: 'input_text', text }] }]);
    for (let i = 0; i < 1000; i++) {
      if (instance.snapshot().turns.some(binding => binding.turn.id === id && binding.turn.status === 'completed')) return;
      await delay(10);
    }
    throw new Error('Native recovery Turn did not complete');
  };
  try {
    const before = await first.initialize();
    await complete(first, 'first', 'RETAIN_THIS_NATIVE_CONTEXT');
    expect((await readdir(join(home, 'worker-one'))).some(name => name.endsWith('.sqlite'))).toBe(true);
    expect((await readdir(home)).some(name => name.endsWith('.sqlite'))).toBe(false);
    await first.close();
    await rm(join(home, 'worker-one'), { recursive: true, force: true });
    second = runtime('worker-two', before.rootThreadId);
    expect((await second.initialize()).rootThreadId).toBe(before.rootThreadId);
    expect((await readdir(join(home, 'worker-two'))).some(name => name.endsWith('.sqlite'))).toBe(true);
    await complete(second, 'second', 'Continue from the saved context.');
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1]!.input)).toContain('RETAIN_THIS_NATIVE_CONTEXT');
    expect(JSON.stringify(requests[1]!.input)).toContain('SAVED_NATIVE_ANSWER');
  } finally {
    await first.close(); await second?.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 30_000);
