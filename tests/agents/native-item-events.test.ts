import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { SessionRuntime } from '../../src/runner/session-runtime.js';
import type { SessionRuntimeState } from '../../src/core/session-runtime-planning.js';
import { planSessionStream, type SessionStreamSnapshot } from '../../src/core/session-stream.js';
import { sessionAgent } from '../../src/core/session-planning.js';
import type { AgentSession } from '../../src/domain/agents-api.js';
import { parseAgentsContract } from '../../src/domain/agents-api-validation.js';

it.each([false, true])('retains native Item boundaries with interruption=%s', async interrupted => {
  const summary = { type: 'reasoning', id: 'reasoning_fixture', summary: [{ type: 'summary_text', text: 'Public summary' }] };
  const message = (id: string, phase: string, text: string) => ({ type: 'message', id, role: 'assistant', phase, content: [{ type: 'output_text', text }] });
  const wireEvents = [
    { type: 'response.created', response: { id: 'response_fixture' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...summary, summary: [] } },
    { type: 'response.reasoning_summary_part.added', item_id: summary.id, output_index: 0, summary_index: 0, part: { type: 'summary_text', text: '' } },
    { type: 'response.reasoning_summary_text.delta', item_id: summary.id, output_index: 0, summary_index: 0, delta: 'Public summary' },
    { type: 'response.output_item.done', output_index: 0, item: summary },
    { type: 'response.output_item.added', output_index: 1, item: message('commentary_fixture', 'commentary', '') },
    { type: 'response.output_text.delta', item_id: 'commentary_fixture', output_index: 1, content_index: 0, delta: 'Working' },
    { type: 'response.output_item.done', output_index: 1, item: message('commentary_fixture', 'commentary', 'Working') },
    { type: 'response.output_item.done', output_index: 2, item: message('answer_fixture', 'final_answer', 'Done') },
    { type: 'response.completed', response: { id: 'response_fixture' } },
  ];
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Drain the fixture request. */ }
    if (!request.url?.endsWith('/responses')) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const body = (interrupted ? wireEvents.slice(0, 7) : wireEvents).map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
    if (interrupted) response.write(body);
    else response.end(body);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  const home = await mkdtemp(join(tmpdir(), 'rat-native-item-events-'));
  const states: SessionRuntimeState[] = [];
  const runtime = new SessionRuntime({ sessionId: 'session', agentId: 'agent', changed: state => states.push(structuredClone(state)), request: {
    binary: process.env.CODEX_CONFORMANCE_BINARY ?? resolve('node_modules/.bin/codex'),
    workspace: home, environment: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home },
    timeoutMs: 15_000, persistent: true, prompt: '', model: 'gpt-5.4', modelProvider: 'fixture', sandbox: 'read-only', networkAccess: false, environments: [],
    sessionConfig: { 'model_providers.fixture': { name: 'local fixture', base_url: `http://127.0.0.1:${address.port}`,
      wire_api: 'responses', requires_openai_auth: false, supports_websockets: false } },
  } });
  try {
    await runtime.initialize();
    await runtime.start({ id: 'turn', object: 'agent.session.turn', session_id: 'session', agent_id: 'agent', subagent_id: null,
      status: 'queued', created_at: 1, started_at: null, completed_at: null, error: null, usage: null },
    [{ role: 'user', content: [{ type: 'input_text', text: 'Run the streaming fixture.' }] }]);
    if (interrupted) {
      for (let attempt = 0; attempt < 1_000 && !runtime.snapshot().turns[0]?.items.some(item => item.type === 'message' && item.content.some(part => part.type === 'output_text' && part.text === 'Working')); attempt++) await delay(10);
      await runtime.cancel('turn');
    }
    const status = interrupted ? 'cancelled' : 'completed';
    for (let attempt = 0; attempt < 1_000 && runtime.snapshot().turns[0]?.turn.status !== status; attempt++) await delay(10);
    expect(runtime.snapshot().turns[0]?.turn.status).toBe(status);
    if (interrupted) expect(runtime.snapshot().turns[0]?.items).toContainEqual(expect.objectContaining({ type: 'message', status: 'incomplete', content: [{ type: 'output_text', text: 'Working' }] }));
    const items = states.flatMap(state => state.turns.flatMap(binding => binding.items));
    expect(items).toContainEqual(expect.objectContaining({ type: 'message', phase: 'commentary', status: 'in_progress', content: [{ type: 'output_text', text: 'Working' }] }));
    expect(items).toContainEqual(expect.objectContaining({ type: 'reasoning', status: 'in_progress', summary: [{ type: 'summary_text', text: '' }] }));
    const agent = sessionAgent({ model: 'gpt-5.4' }, 'agent', 1);
    const session: AgentSession = { id: 'session', object: 'agent.session', agent, environment: { type: 'none' }, created_at: 1,
      last_active_at: 1, error: null, metadata: {}, required_actions: [], status: 'in_progress', usage: null, vault_ids: [] };
    let previous: SessionStreamSnapshot | undefined;
    const events = states.flatMap(state => {
      const current = { session, turns: state.turns.map(binding => binding.turn), items: state.turns.flatMap(binding => binding.items) };
      const planned = planSessionStream(previous, current);
      previous = current;
      return planned;
    });
    events.forEach((event, index) => expect(() => parseAgentsContract('SessionEvent', { ...event, event_id: `evt_${index}` }), JSON.stringify(event)).not.toThrow());
    expect(events.filter(event => event.type === 'agent.session.turn.reasoning_summary_part.added')).toHaveLength(1);
    const done = events.filter(event => event.type === 'agent.session.turn.item.done');
    expect(done).toHaveLength(interrupted ? 2 : 3);
    expect(done.map(event => event.item.type)).toEqual(interrupted ? ['reasoning', 'message'] : ['reasoning', 'message', 'message']);
    expect(done[1]).toMatchObject({ item: { phase: 'commentary' } });
    if (!interrupted) expect(done[2]).toMatchObject({ item: { phase: 'final_answer' } });
    expect(events.indexOf(done.at(-1)!)).toBeLessThan(events.findIndex(event => event.type === `agent.session.turn.${status}`));
  } finally {
    await runtime.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 20_000);
