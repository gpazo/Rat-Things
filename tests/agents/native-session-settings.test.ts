import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { SessionRuntime } from '../../src/runner/session-runtime.js';
import type { SessionModelSettings } from '../../src/domain/session-execution.js';

it.each(['auto', 'priority'] as const)('changes supported settings on the same official native thread from initial tier %s', async initialTier => {
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
  const provider = { name: 'local fixture', base_url: `http://127.0.0.1:${address.port}`, wire_api: 'responses', requires_openai_auth: false, supports_websockets: false };
  const runtime = new SessionRuntime({ sessionId: 'session', agentId: 'agent', request: {
    binary: process.env.CODEX_CONFORMANCE_BINARY ?? resolve('node_modules/.bin/codex'), workspace: home,
    // model/list uses startup provider configuration, before thread/start overrides.
    binaryArguments: ['-c', 'model_provider="fixture"', ...Object.entries(provider).flatMap(([key, value]) => ['-c', `model_providers.fixture.${key}=${JSON.stringify(value)}`]), 'app-server'],
    environment: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home }, timeoutMs: 20_000,
    prompt: '', persistent: true, sandbox: 'read-only', networkAccess: false, environments: [], model: 'gpt-5.5', modelProvider: 'fixture', serviceTier: initialTier,
    // The host's explicit capability enables a later admitted priority tier even
    // when inherited settings disabled fast mode; it does not select a paid tier.
    sessionConfig: { 'model_providers.fixture': provider, 'features.fast_mode': false },
  } });
  const settings: SessionModelSettings[] = [
    { model: 'gpt-5.5', reasoning: { effort: 'high' }, service_tier: 'priority' },
    { model: 'gpt-6-astra', reasoning: { effort: 'low' }, service_tier: 'flex' },
    { model: 'gpt-6-astra', reasoning: { effort: 'low' }, service_tier: 'auto' },
    { model: 'gpt-6-astra', reasoning: { effort: 'high' }, service_tier: 'fast' },
    { model: 'gpt-6-astra', reasoning: { effort: 'high' }, service_tier: 'default' },
    { model: 'gpt-6-astra', reasoning: { effort: 'high' }, service_tier: 'priority' },
    { model: 'gpt-6-astra', reasoning: { effort: null }, service_tier: 'auto' },
    ...(['medium', 'xhigh', 'max'] as const).map(effort => ({ model: 'gpt-6-astra', reasoning: { effort }, service_tier: 'default' as const })),
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
      { model: 'gpt-5.5', reasoning: expect.objectContaining({ effort: 'high' }), service_tier: 'priority' },
      { model: 'gpt-6-astra', reasoning: expect.objectContaining({ effort: 'low' }), service_tier: 'flex' },
      { model: 'gpt-6-astra', reasoning: expect.objectContaining({ effort: 'low' }), service_tier: undefined },
      { model: 'gpt-6-astra', reasoning: expect.objectContaining({ effort: 'high' }), service_tier: 'priority' },
      { model: 'gpt-6-astra', reasoning: expect.objectContaining({ effort: 'high' }), service_tier: undefined },
      { model: 'gpt-6-astra', reasoning: expect.objectContaining({ effort: 'high' }), service_tier: 'priority' },
      { model: 'gpt-6-astra', reasoning: expect.objectContaining({ effort: 'low' }), service_tier: undefined },
      ...(['medium', 'xhigh', 'max'] as const).map(effort => ({ model: 'gpt-6-astra', reasoning: expect.objectContaining({ effort }), service_tier: undefined })),
    ]);
    const count = requests.length;
    const rejectedTurn = { id: 'retry-after-admission', object: 'agent.session.turn' as const, session_id: 'session', agent_id: 'agent', subagent_id: null,
      status: 'queued' as const, created_at: 1, started_at: null, completed_at: null, error: null, usage: null };
    const input = [{ role: 'user' as const, content: [{ type: 'input_text' as const, text: 'Continue after a rejected setting.' }] }];
    await expect(runtime.start(rejectedTurn, input, { model: 'custom-uncatalogued-model', reasoning: { effort: 'low' }, service_tier: 'priority' }))
      .rejects.toMatchObject({ status: 400, code: 'invalid_request', param: 'agent.service_tier' });
    expect(requests).toHaveLength(count);
    expect(runtime.snapshot().rootThreadId).toBe(thread);
    expect(runtime.snapshot().turns.some(binding => binding.turn.id === rejectedTurn.id)).toBe(false);
    // Admission made no native attempt, so correcting that same public Turn is safe.
    await runtime.start(rejectedTurn, input, { model: 'gpt-6-astra', reasoning: { effort: 'low' }, service_tier: 'priority' });
    for (let n = 0; n < 1_000 && runtime.snapshot().turns.find(binding => binding.turn.id === rejectedTurn.id)?.turn.status !== 'completed'; n++) await delay(10);
    expect(runtime.snapshot().turns.find(binding => binding.turn.id === rejectedTurn.id)?.turn.status).toBe('completed');
    expect(requests.at(-1)).toMatchObject({ model: 'gpt-6-astra', service_tier: 'priority' });
    expect(runtime.snapshot().rootThreadId).toBe(thread);
  } finally {
    await runtime.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 30_000);
