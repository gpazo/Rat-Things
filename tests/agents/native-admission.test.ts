import { createServer, type ServerResponse } from 'node:http';
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

it.each(Array.from({ length: process.env.CODEX_REQUIRE_PARITY === 'true' ? 10 : 1 }, (_, index) => index + 1))('keeps the exact child limit when two active parents spawn nested children (attempt %s)', async () => {
  let rootCalls = 0;
  let nestedCalls = 0;
  let parentContinuations = 0;
  const waitingParents: ServerResponse[] = [];
  const outputs: unknown[] = [];
  let bothParentsContinued!: () => void;
  const continued = new Promise<void>((resolve) => { bothParentsContinued = resolve; });
  const finish = (response: ServerResponse, item: unknown) => response.end([
    { type: 'response.output_item.done', item },
    { type: 'response.completed', response: { id: 'fixture_completed' } },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
  const spawn = (id: string, task: string, message: string) => ({
    type: 'function_call', id, call_id: id, namespace: 'collaboration', name: 'spawn_agent',
    arguments: JSON.stringify({ task_name: task, message, fork_turns: 'none' }),
  });
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    if (!request.url?.endsWith('/responses')) { response.writeHead(404).end(); return; }
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { input: Array<{ type?: string; role?: string }> };
    const input = JSON.stringify(body.input.filter((item) => item.role === 'user' || item.type === 'agent_message'));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ type: 'response.created', response: { id: 'fixture_started' } })}\n\n`);
    if (input.includes('ROOT_ADMISSION')) {
      rootCalls++;
      if (rootCalls <= 2) finish(response, spawn(`parent_${rootCalls}`, `parent_${rootCalls}`, 'PARENT_ADMISSION: create a nested child.'));
      else {
        await continued;
        finish(response, { type: 'message', id: 'root_done', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Admissions observed.' }] });
      }
    } else if (input.includes('NESTED_ADMISSION')) {
      nestedCalls++; // Hold the model stream open so the admitted child retains its slot.
    } else if (input.includes('PARENT_ADMISSION')) {
      if (body.input.some((item) => item.type === 'function_call_output')) {
        parentContinuations++;
        if (parentContinuations === 2) bothParentsContinued();
        // Both parents also stay active. Exactly one of their children can fit.
      } else {
        waitingParents.push(response);
        if (waitingParents.length === 2) waitingParents.forEach((parent, index) => {
          finish(parent, spawn(`nested_${index}`, 'nested', 'NESTED_ADMISSION: remain active.'));
        });
      }
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  const home = await mkdtemp(join(tmpdir(), 'rat-native-admission-'));
  const planned = planSessionLaunch(planCodexLaunch({ version: '1', prompt: '', agent: { sandbox: 'read-only' } }, home, 20_000, {}), {
    sessionId: 'sess_admission', turnId: 'turn_root', input: [], environment: { type: 'none' },
    agent: sessionAgent({ model: 'gpt-6-astra', multi_agent: { enabled: true, max_concurrent_subagents: 3 } }, 'agent_fixture', 100),
  });
  const runtime = new SessionRuntime({ sessionId: 'sess_admission', agentId: 'agent_fixture', request: {
    ...planned, binary: process.env.CODEX_CONFORMANCE_BINARY ?? resolve('node_modules/.bin/codex'),
    workspace: home, environment: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home },
    timeoutMs: 20_000, persistent: true, prompt: '', model: 'gpt-6-astra', modelProvider: 'fixture', sandbox: 'read-only', networkAccess: false,
    onEvent: (event) => { if (event.method === 'rawResponseItem/completed' && (event.params.item as { type?: string })?.type === 'function_call_output') outputs.push(event); },
    sessionConfig: { ...planned.sessionConfig, 'model_providers.fixture': {
      name: 'local fixture', base_url: `http://127.0.0.1:${address.port}`, wire_api: 'responses', requires_openai_auth: false, supports_websockets: false,
    } },
  } });
  try {
    await runtime.initialize();
    await runtime.start({ id: 'turn_root', object: 'agent.session.turn', session_id: 'sess_admission', agent_id: 'agent_fixture', subagent_id: null,
      status: 'queued', created_at: 100, started_at: null, completed_at: null, error: null, usage: null },
    [{ role: 'user', content: [{ type: 'input_text', text: 'ROOT_ADMISSION: start two parents.' }] }]);
    for (let attempt = 0; attempt < 1_500; attempt++) {
      if (runtime.snapshot().turns[0]?.turn.status === 'completed' && nestedCalls) break;
      await delay(10);
    }
    const state = runtime.snapshot();
    expect(state.turns[0]?.turn.status, JSON.stringify({ outputs, rootCalls, nestedCalls, parentContinuations })).toBe('completed');
    expect(state.subagents, JSON.stringify({ state, outputs, rootCalls, nestedCalls, parentContinuations })).toHaveLength(3);
    expect(nestedCalls).toBe(1);
    const attempts = state.turns.flatMap(({ items }) => items.filter((item) => item.type === 'create_subagent_call'));
    expect(attempts.map((item) => item.status).sort()).toEqual(['completed', 'completed', 'completed', 'failed']);
    expect(JSON.stringify(outputs)).toContain('agent thread limit reached');
    expect(state.turns.filter(({ turn }) => turn.subagent_id !== null).map(({ turn }) => turn.status)).toEqual(['in_progress', 'in_progress', 'in_progress']);
  } finally {
    await runtime.close(); server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 25_000);
