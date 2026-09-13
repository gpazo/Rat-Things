import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { SessionRuntime } from '../../src/runner/session-runtime.js';
import { planSessionLaunch } from '../../src/runner/session-launch-planning.js';
import { planCodexLaunch } from '../../src/runner/agent-planning.js';
import { sessionAgent } from '../../src/core/session-planning.js';

it.each(['programmatic', 'deferred'] as const)('executes a %s application function and retains its required action', async (mode) => {
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    if (!request.url?.endsWith('/responses')) { response.writeHead(404).end(); return; }
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    const item = mode === 'deferred' && requests.length === 1
      ? { type: 'tool_search_call', id: 'search_call', call_id: 'search_call', execution: 'client', arguments: { query: 'Find an application record lookup', limit: 1 } }
      : mode === 'deferred' && requests.length === 2
      ? { type: 'function_call', id: 'lookup_call', call_id: 'lookup_call', namespace: 'application', name: 'lookup', arguments: JSON.stringify({ key: 'example' }) }
      : mode === 'programmatic' && requests.length === 1
      ? { type: 'custom_tool_call', id: 'code_call', call_id: 'code_call', name: 'exec', input: 'text(await tools.lookup({ key: "example" }));' }
      : { type: 'message', id: 'done', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Programmatic lookup complete.' }] };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end([
      { type: 'response.created', response: { id: `response_${requests.length}` } },
      { type: 'response.output_item.done', item },
      { type: 'response.completed', response: { id: `response_${requests.length}` } },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  const home = await mkdtemp(join(tmpdir(), 'rat-native-tools-'));
  const planned = planSessionLaunch(planCodexLaunch({ version: '1', prompt: '', agent: { sandbox: 'read-only', capabilities: { webSearch: 'cached' } } }, home, 20_000, {}), {
    sessionId: 'sess_tools', turnId: 'turn_tools', input: [], environment: { type: 'none' },
    agent: sessionAgent({ model: 'gpt-5.4', reasoning: { effort: 'high', summary: 'concise' }, service_tier: 'priority',
      text: { verbosity: 'low', format: { type: 'json_schema', schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false } } }, tools: [
      { type: 'web_search', mode: 'cached', context_size: 'low', allowed_domains: ['example.com'], location: { country: 'US', city: 'Seattle' } },
      mode === 'programmatic' ? { type: 'programmatic_tool_calling', enabled: true } : { type: 'tool_search' },
      { type: 'function', name: 'lookup', description: 'Find an application record.', defer_loading: mode === 'deferred', parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false } },
    ] }, 'agent_tools', 100),
  });
  const runtime = new SessionRuntime({ sessionId: 'sess_tools', agentId: 'agent_tools', request: {
    ...planned, binary: process.env.CODEX_CONFORMANCE_BINARY ?? resolve('node_modules/.bin/codex'),
    workspace: home, environment: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home },
    timeoutMs: 20_000, persistent: true, prompt: '', model: 'gpt-5.4', modelProvider: 'fixture', sandbox: 'read-only', networkAccess: false,
    sessionConfig: { ...planned.sessionConfig, 'model_providers.fixture': {
      name: 'local fixture', base_url: `http://127.0.0.1:${address.port}`, wire_api: 'responses', requires_openai_auth: false, supports_websockets: false,
    } },
  } });
  try {
    await runtime.initialize();
    await runtime.start({ id: 'turn_tools', object: 'agent.session.turn', session_id: 'sess_tools', agent_id: 'agent_tools', subagent_id: null,
      status: 'queued', created_at: 100, started_at: null, completed_at: null, error: null, usage: null },
    [{ role: 'user', content: [{ type: 'input_text', text: 'Look up the example record using programmatic tools.' }] }]);
    for (let attempt = 0; attempt < 1_000; attempt++) {
      if (runtime.snapshot().requiredActions.length || runtime.snapshot().turns[0]?.turn.status === 'completed') break;
      await delay(10);
    }
    const action = runtime.snapshot().requiredActions[0];
    expect(action, JSON.stringify({ state: runtime.snapshot(), requests })).toMatchObject({ type: 'function_call', name: 'lookup', arguments: { key: 'example' }, turn_id: 'turn_tools' });
    if (!action || action.type !== 'function_call') throw new Error('Missing function action');
    await runtime.toolResult({ type: 'agent.session.input.tool_result', turn_id: action.turn_id, call_id: action.call_id, success: true, output: 'APPLICATION_RESULT' });
    for (let attempt = 0; attempt < 1_000 && runtime.snapshot().turns[0]?.turn.status !== 'completed'; attempt++) await delay(10);
    expect(runtime.snapshot().turns[0]?.turn.status).toBe('completed');
    expect(requests).toHaveLength(mode === 'programmatic' ? 2 : 3);
    if (mode === 'deferred') {
      expect(requests[0]?.tools).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: 'lookup' })]));
      expect(JSON.stringify(requests[1]?.input)).toContain('tool_search_output');
      expect(JSON.stringify(requests[1]?.input)).toContain('lookup');
    }
    expect(requests[0]).toMatchObject({ model: 'gpt-5.4', service_tier: 'priority', reasoning: { effort: 'high', summary: 'concise' }, text: {
      verbosity: 'low', format: { type: 'json_schema', schema: { type: 'object', required: ['answer'] } },
    } });
    expect(requests[0]?.tools).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'web_search', external_web_access: false,
      search_context_size: 'low', filters: { allowed_domains: ['example.com'] }, user_location: expect.objectContaining({ country: 'US', city: 'Seattle' }),
    })]));
    expect(JSON.stringify(requests.at(-1)?.input)).toContain('APPLICATION_RESULT');
    expect(runtime.snapshot().turns[0]?.items).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'function_call', name: 'lookup', call_id: action.call_id })]));
  } finally {
    await runtime.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 25_000);
