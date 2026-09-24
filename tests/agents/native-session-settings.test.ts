import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { SessionRuntime } from '../../src/runner/session-runtime.js';
import type { SessionModelSettings } from '../../src/domain/session-execution.js';

// This contract requires the repository's patched runtime, not the npm CLI.
it.skipIf(process.env.CODEX_REQUIRE_PARITY !== 'true')('changes model, reasoning effort and service tier across Turns on the same native thread', async () => {
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    if (!request.url?.endsWith('/responses')) { response.writeHead(404).end(); return; }
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    const id = `response_${requests.length}`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end([
      { type: 'response.created', response: { id } },
      { type: 'response.output_item.done', item: { type: 'message', id: `message_${id}`, role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Done.' }] } },
      { type: 'response.completed', response: { id } },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  const home = await mkdtemp(join(tmpdir(), 'rat-native-settings-'));
  const runtime = new SessionRuntime({ sessionId: 'session', agentId: 'agent', request: {
    binary: process.env.CODEX_CONFORMANCE_BINARY ?? resolve('node_modules/.bin/codex'), workspace: home,
    environment: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home }, timeoutMs: 20_000,
    prompt: '', persistent: true, sandbox: 'read-only', networkAccess: false, environments: [], model: 'gpt-5.4', modelProvider: 'fixture',
    sessionConfig: { 'model_providers.fixture': { name: 'local fixture', base_url: `http://127.0.0.1:${address.port}`, wire_api: 'responses', requires_openai_auth: false, supports_websockets: false } },
  } });
  const settings: SessionModelSettings[] = [
    { model: 'gpt-5.4', reasoning: { effort: 'high' }, service_tier: 'priority' },
    { model: 'gpt-6-astra', reasoning: { effort: 'low' }, service_tier: 'flex' },
    { model: 'gpt-6-astra', reasoning: { effort: 'low' }, service_tier: 'auto' },
    { model: 'gpt-6-astra', reasoning: { effort: 'high' }, service_tier: 'default' },
    { model: 'gpt-6-astra', reasoning: { effort: null }, service_tier: 'fast' },
    ...(['none', 'minimal', 'medium', 'xhigh', 'max'] as const).map(effort => ({ model: 'gpt-6-astra', reasoning: { effort }, service_tier: 'auto' as const })),
  ];
  const turnRequests: Array<Record<string, unknown>> = [];
  try {
    const thread = (await runtime.initialize()).rootThreadId;
    for (const [index, setting] of settings.entries()) {
      const id = `turn_${index}`;
      await runtime.start({ id, object: 'agent.session.turn', session_id: 'session', agent_id: 'agent', subagent_id: null,
        status: 'queued', created_at: 1, started_at: null, completed_at: null, error: null, usage: null },
      [{ role: 'user', content: [{ type: 'input_text', text: `Turn ${index}` }] }], setting);
      for (let n = 0; n < 1_000 && runtime.snapshot().turns.find(binding => binding.turn.id === id)?.turn.status !== 'completed'; n++) await delay(10);
      expect(runtime.snapshot().turns.find(binding => binding.turn.id === id)?.turn.status).toBe('completed');
      expect(runtime.snapshot().rootThreadId).toBe(thread);
      // Model changes may first compact history using the old model. Inspect
      // the request that completed this Turn separately from that internal work.
      turnRequests.push(requests.at(-1)!);
    }
    expect(turnRequests.map(request => ({ model: request.model, reasoning: request.reasoning, service_tier: request.service_tier }))).toEqual([
      { model: 'gpt-5.4', reasoning: expect.objectContaining({ effort: 'high' }), service_tier: 'priority' },
      { model: 'gpt-6-astra', reasoning: expect.objectContaining({ effort: 'low' }), service_tier: 'flex' },
      { model: 'gpt-6-astra', reasoning: expect.objectContaining({ effort: 'low' }), service_tier: 'auto' },
      { model: 'gpt-6-astra', reasoning: expect.objectContaining({ effort: 'high' }), service_tier: 'default' },
      { model: 'gpt-6-astra', reasoning: expect.objectContaining({ effort: 'low' }), service_tier: 'fast' },
      ...(['none', 'minimal', 'medium', 'xhigh', 'max'] as const).map(effort => ({ model: 'gpt-6-astra', reasoning: expect.objectContaining({ effort }), service_tier: 'auto' })),
    ]);
  } finally {
    await runtime.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 30_000);
