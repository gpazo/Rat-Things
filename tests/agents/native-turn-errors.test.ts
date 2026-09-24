import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { SessionRuntime } from '../../src/runner/session-runtime.js';
import type { Turn } from '../../src/domain/agents-api.js';

const cases: Array<{ code: string; expected: NonNullable<Turn['error']>['code']; status?: number; patched?: boolean }> = [
  { code: 'context_length_exceeded', expected: 'context_length_exceeded' },
  { code: 'insufficient_quota', expected: 'usage_limit_exceeded' },
  { code: 'cyber_policy', expected: 'cyber_policy' },
  { code: 'credit_balance_exhausted', expected: 'credit_balance_exhausted', patched: true },
  { code: 'credit_balance_exhausted', expected: 'credit_balance_exhausted', status: 402, patched: true },
  { code: 'invalid_api_key', expected: 'authentication_error', status: 401, patched: true },
  { code: 'model_not_found', expected: 'resource_not_found', status: 404, patched: true },
  { code: 'invalid_request_error', expected: 'invalid_request', status: 400, patched: true },
];
for (const scenario of cases) it.skipIf(scenario.patched && process.env.CODEX_REQUIRE_PARITY !== 'true')(`preserves provider failure ${scenario.code} over ${scenario.status ?? 'SSE'}`, async () => {
  let requests = 0;
  const nativeErrors: unknown[] = [];
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume the complete request */ }
    if (!request.url?.endsWith('/responses')) { response.writeHead(404).end(); return; }
    requests++;
    const error = { code: scenario.code, message: 'PRIVATE_PROVIDER_DIAGNOSTIC', type: 'fixture_error' };
    if (scenario.status) { response.writeHead(scenario.status, { 'content-type': 'application/json' }).end(JSON.stringify({ error })); return; }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end([{ type: 'response.created', response: { id: 'response' } }, { type: 'response.failed', response: { id: 'response', error } }].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  const home = await mkdtemp(join(tmpdir(), 'rat-native-errors-'));
  const runtime = new SessionRuntime({ sessionId: 'session', agentId: 'agent', request: {
    binary: process.env.CODEX_CONFORMANCE_BINARY ?? resolve('node_modules/.bin/codex'), workspace: home,
    environment: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home }, timeoutMs: 15_000,
    prompt: '', persistent: true, sandbox: 'read-only', networkAccess: false, environments: [], model: 'gpt-5.4', modelProvider: 'fixture',
    onEvent: event => { if (event.method === 'error' || event.method === 'turn/completed') nativeErrors.push(event); },
    sessionConfig: { 'model_providers.fixture': { name: 'local fixture', base_url: `http://127.0.0.1:${address.port}`, wire_api: 'responses', requires_openai_auth: false, supports_websockets: false, stream_max_retries: 0, request_max_retries: 0 } },
  } });
  try {
    await runtime.initialize();
    await runtime.start({ id: 'turn', object: 'agent.session.turn', session_id: 'session', agent_id: 'agent', subagent_id: null,
      status: 'queued', created_at: 1, started_at: null, completed_at: null, error: null, usage: null },
    [{ role: 'user', content: [{ type: 'input_text', text: 'Trigger the fixture response.' }] }]);
    for (let n = 0; n < 1000 && !nativeErrors.some(event => (event as { method: string }).method === 'turn/completed'); n++) await delay(10);
    const turn = runtime.snapshot().turns[0]?.turn;
    expect(turn, JSON.stringify(nativeErrors)).toMatchObject({ status: 'failed', error: { code: scenario.expected } });
    expect(turn?.error?.message).not.toContain('PRIVATE_PROVIDER_DIAGNOSTIC');
    expect(requests).toBe(1);
  } finally {
    await runtime.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 20_000);
