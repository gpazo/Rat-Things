import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { bedrockTokenArguments } from '../../src/runner/agent-planning.js';
import { SessionRuntime } from '../../src/runner/session-runtime.js';
import type { Turn } from '../../src/domain/agents-api.js';

it('refreshes native Bedrock command authentication on a reused Session after a 401', async () => {
  const home = await mkdtemp(join(tmpdir(), 'rat-native-bedrock-auth-'));
  const tokenFile = join(home, 'token');
  await writeFile(tokenFile, 'first-token', { mode: 0o600 });
  const headers: string[] = [];
  let expected = 'first-token';
  let sequence = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Drain the request before replying. */ }
    if (!request.url?.endsWith('/responses')) { response.writeHead(404).end(); return; }
    headers.push(request.headers.authorization ?? '');
    if (request.headers.authorization !== `Bearer ${expected}`) {
      response.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Refresh the fixture token', type: 'authentication_error' } }));
      return;
    }
    const id = `response_${++sequence}`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end([
      { type: 'response.created', response: { id } },
      { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: `message_${sequence}`, phase: 'final_answer', content: [{ type: 'output_text', text: 'Authenticated.' }] } },
      { type: 'response.completed', response: { id } },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  const runtime = new SessionRuntime({ sessionId: 'auth_session', agentId: 'auth_agent', request: {
    binary: process.env.CODEX_CONFORMANCE_BINARY ?? resolve('node_modules/.bin/codex'),
    binaryArguments: bedrockTokenArguments(tokenFile), workspace: home,
    environment: { HOME: home, CODEX_HOME: home, PATH: process.env.PATH, AWS_REGION: 'us-west-2', AWS_EC2_METADATA_DISABLED: 'true' },
    timeoutMs: 15_000, persistent: true, prompt: '', sandbox: 'read-only', networkAccess: false, environments: [],
    modelProvider: 'amazon-bedrock', model: 'openai.gpt-5.6-terra',
    sessionConfig: { 'model_providers.amazon-bedrock.base_url': `http://127.0.0.1:${address.port}` },
  } });
  try {
    await runtime.initialize();
    for (const id of ['first', 'continued']) {
      if (id === 'continued') { expected = 'second-token'; await writeFile(tokenFile, expected); }
      const turn: Turn = { id, object: 'agent.session.turn', session_id: 'auth_session', agent_id: 'auth_agent', subagent_id: null,
        status: 'queued', created_at: 100, started_at: null, completed_at: null, error: null, usage: null };
      await runtime.start(turn, [{ role: 'user', content: [{ type: 'input_text', text: 'Prove authentication' }] }]);
      await expect.poll(() => runtime.snapshot().turns.find((entry) => entry.turn.id === id)?.turn.status, { timeout: 10_000, interval: 25 }).toSatisfy((status: string) => ['completed', 'failed', 'cancelled'].includes(status));
      const completed = runtime.snapshot().turns.find((entry) => entry.turn.id === id)!.turn;
      expect(completed.status, JSON.stringify({ error: completed.error, headers })).toBe('completed');
    }
    expect(headers).toEqual(['Bearer first-token', 'Bearer first-token', 'Bearer second-token']);
  } finally {
    await runtime.close();
    server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done()));
    await delay(50);
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 20_000);
