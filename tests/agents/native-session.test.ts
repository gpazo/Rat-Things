import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { SessionRuntime } from '../../src/runner/session-runtime.js';
import type { AgentSessionItem, Turn } from '../../src/domain/agents-api.js';
import { parseAgentsContract } from '../../src/domain/agents-api-validation.js';
import { runtimeSubagents } from '../../src/core/session-runtime-planning.js';
import { planSessionLaunch } from '../../src/runner/session-launch-planning.js';
import { planCodexLaunch } from '../../src/runner/agent-planning.js';
import { sessionAgent } from '../../src/core/session-planning.js';

const nativeBinary = process.env.CODEX_CONFORMANCE_BINARY ?? resolve('node_modules/.bin/codex');
const requireParity = process.env.CODEX_REQUIRE_PARITY === 'true';

describe('stock harness with a local model protocol fixture', () => {
  it.each([{ multiAgentV2: false, plaintext: false }, { multiAgentV2: true, plaintext: false }, { multiAgentV2: true, plaintext: true }])('records native child work with multi_agent_v2=$multiAgentV2 and plaintext=$plaintext', async ({ multiAgentV2, plaintext }) => {
    let count = 0;
    const requests: Array<Record<string, unknown>> = [];
    const notifications: Array<unknown> = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      if (!request.url?.endsWith('/responses')) { response.writeHead(404).end(); return; }
      requests.push(JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>);
      const id = `fixture_${++count}`;
      const item = count === 1
        ? { type: 'function_call', id: 'spawn_1', call_id: 'spawn_fixture', namespace: multiAgentV2 ? 'collaboration' : 'multi_agent_v1', name: 'spawn_agent', ...(plaintext ? { encrypted_function_args: [] } : {}), arguments: JSON.stringify({ message: 'Perform the child fixture task.', ...(multiAgentV2 ? { task_name: 'child_fixture', fork_turns: 'none' } : { agent_type: 'default' }) }) }
        : { type: 'message', role: 'assistant', id: `msg_${count}`, content: [{ type: 'output_text', text: 'Fixture complete.' }], phase: 'final_answer' };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end([{ type: 'response.created', response: { id } }, { type: 'response.output_item.done', item }, { type: 'response.completed', response: { id } }].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const bound = server.address(); if (!bound || typeof bound === 'string') throw new Error('Missing fixture address');
    const home = await mkdtemp(join(tmpdir(), 'rat-native-child-'));
    const runtime = new SessionRuntime({ sessionId: 'sess_child_fixture', agentId: 'agent_fixture', request: {
      binary: nativeBinary, workspace: home, environment: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home },
      onEvent: (event) => { notifications.push(event); },
      timeoutMs: 15_000, persistent: true, prompt: '', sandbox: 'read-only', networkAccess: false, environments: [], model: 'gpt-5.4', modelProvider: 'fixture',
      dynamicTools: [{ type: 'function', name: 'lookup', description: 'Application lookup', inputSchema: { type: 'object', properties: {} } }],
      sessionConfig: { 'model_providers.fixture': { name: 'local fixture', base_url: `http://127.0.0.1:${bound.port}`, wire_api: 'responses', requires_openai_auth: false, supports_websockets: false }, 'features.multi_agent': true, 'features.multi_agent_v2': { enabled: multiAgentV2, max_concurrent_threads_per_session: 2 }, ...(!multiAgentV2 ? { 'agents.max_concurrent_threads_per_session': 1 } : {}) },
    } });
    try {
      await runtime.initialize();
      await runtime.start({ id: 'turn_parent', object: 'agent.session.turn', session_id: 'sess_child_fixture', agent_id: 'agent_fixture', subagent_id: null,
        status: 'queued', created_at: 100, started_at: null, completed_at: null, error: null, usage: null }, [{ role: 'user', content: [{ type: 'input_text', text: 'Run the child fixture.' }] }]);
      for (let n = 0; n < 700; n++) {
        const state = runtime.snapshot();
        if (state.subagents.length === 1 && state.turns.length === 2 && state.turns.every((binding) => binding.turn.status === 'completed')) break;
        await delay(10);
      }
      const state = runtime.snapshot();
      expect(state.subagents, JSON.stringify({ notifications, tools: requests[0]?.tools, input: requests.at(-1)?.input })).toHaveLength(1);
      expect(state.turns.map(({ turn }) => turn.status)).toEqual(['completed', 'completed']);
      expect(state.turns.find(({ turn }) => turn.id === 'turn_parent')!.items).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'create_subagent_call', status: 'completed' })]));
      const children = runtimeSubagents(state);
      if (multiAgentV2) expect(children[0]?.items, JSON.stringify(notifications.filter(event => JSON.stringify(event).includes('"type":"agent_message"')))).toContainEqual(expect.objectContaining({
        type: 'agent_message', sender_agent_id: 'agent_fixture', recipient_agent_id: children[0]?.subagent.id,
        content: plaintext ? expect.arrayContaining([expect.objectContaining({ type: 'output_text', text: expect.stringContaining('Perform the child fixture task.') })])
          : [expect.objectContaining({ type: 'output_text' }), { type: 'encrypted_content', encrypted_content: 'Perform the child fixture task.' }],
      }));
      expect(state.turns.find(({ turn }) => turn.id === 'turn_parent')!.items).toContainEqual(expect.objectContaining({
        type: 'create_subagent_call', content: multiAgentV2 && !plaintext
          ? [{ type: 'encrypted_content', encrypted_content: 'Perform the child fixture task.' }]
          : [{ type: 'output_text', text: 'Perform the child fixture task.' }],
      }));
      parseAgentsContract('Subagent', children[0]!.subagent);
      expect(children[0]!.turns).toHaveLength(1);
      for (const binding of state.turns) { parseAgentsContract('Turn', binding.turn); binding.items.forEach((item) => parseAgentsContract('Item', item)); }
      expect(requests.length).toBeGreaterThanOrEqual(3);
      expect(toolNames(requests[0]!.tools)).toContain('lookup');
      const childRequests = requests.filter((request) => (request.input as Array<{ type?: string; role?: string; content?: unknown; recipient?: string }>).some((item) => item.type === 'agent_message' && item.recipient === '/root/child_fixture' || item.role === 'user' && JSON.stringify(item.content).includes('Perform the child fixture task.')));
      expect(childRequests.length).toBeGreaterThan(0);
      for (const request of childRequests) expect(toolNames(request.tools)).not.toContain('lookup');
      for (const request of requests) {
        const names = toolNames(request.tools);
        expect(names).not.toEqual(expect.arrayContaining(['exec_command']));
        expect(names).not.toContain('view_image');
        expect(names).not.toContain('request_user_input');
        expect(names).not.toContain('create_goal');
        expect(JSON.stringify(request.input)).not.toContain('/skills/.system/');
      }
    } finally {
      await runtime.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
      // Codex may still be reaping short-lived marketplace helpers after its main process exits.
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 20_000);

  it.each([
    { limit: 1, forkTurns: 'none', batch: false },
    { limit: 6, forkTurns: 'none', batch: false },
    { limit: 6, forkTurns: 'all', batch: false },
    { limit: 6, forkTurns: 'all', batch: true },
  ])('admits exactly $limit simultaneous children with fork_turns=$forkTurns and batch=$batch, excluding the root', async ({ limit, forkTurns, batch }) => {
    let rootCalls = 0;
    let childCalls = 0;
    const outputs: unknown[] = [];
    const childStarts = Array.from({ length: limit }, () => {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => { resolve = done; });
      return { promise, resolve };
    });
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      if (!request.url?.endsWith('/responses')) { response.writeHead(404).end(); return; }
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { input: Array<{ type?: string; recipient?: string; role?: string; content?: unknown }> };
      // Forked children also retain the coordinator's user input. Their task
      // message, rather than copied history, identifies the receiving agent.
      const childTask = body.input.some(item => item.type === 'agent_message' && item.recipient?.startsWith('/root/child_'));
      const parent = !childTask && body.input.some((item) => item.role === 'user' && JSON.stringify(item.content).includes('PARENT_LIMIT'));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ type: 'response.created', response: { id: `response_${parent ? 'root' : 'child'}_${parent ? ++rootCalls : ++childCalls}` } })}\n\n`);
      if (!parent) { childStarts[childCalls - 1]?.resolve(); return; }
      if (batch && rootCalls === 2) await Promise.all(childStarts.map(start => start.promise));
      if (!batch && rootCalls > 1 && rootCalls <= limit + 1) await childStarts[rootCalls - 2]!.promise;
      const spawnNumbers = batch
        ? rootCalls === 1 ? Array.from({ length: limit }, (_, index) => index + 1) : rootCalls === 2 ? [limit + 1] : []
        : rootCalls <= limit + 1 ? [rootCalls] : [];
      const items = spawnNumbers.length
        ? spawnNumbers.map(number => ({ type: 'function_call', id: `spawn_${number}`, call_id: `spawn_${number}`, namespace: 'collaboration', name: 'spawn_agent', arguments: JSON.stringify({ task_name: `child_${number}`, message: 'Remain active.', fork_turns: forkTurns }) }))
        : [{ type: 'message', role: 'assistant', id: 'done', content: [{ type: 'output_text', text: 'Limit observed.' }], phase: 'final_answer' }];
      response.end([...items.map(item => ({ type: 'response.output_item.done', item })), { type: 'response.completed', response: { id: `root_${rootCalls}` } }].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const bound = server.address(); if (!bound || typeof bound === 'string') throw new Error('Missing fixture address');
    const home = await mkdtemp(join(tmpdir(), 'rat-native-limit-'));
    const planned = planSessionLaunch(planCodexLaunch({ version: '1', prompt: '', agent: { sandbox: 'read-only' } }, home, 20_000, {}), {
      sessionId: 'sess_limit', turnId: 'turn_limit', input: [], environment: { type: 'none' },
      agent: sessionAgent({ model: 'gpt-5.4', multi_agent: { enabled: true, max_concurrent_subagents: limit } }, 'agent_limit', 100),
    });
    const runtime = new SessionRuntime({ sessionId: 'sess_limit', agentId: 'agent_limit', request: {
      binary: nativeBinary, workspace: home, environment: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home },
      timeoutMs: 20_000, persistent: true, prompt: '', sandbox: 'read-only', networkAccess: false, environments: [], model: 'gpt-5.4', modelProvider: 'fixture',
      onEvent: (event) => { if (event.method === 'rawResponseItem/completed' && (event.params.item as { type?: string })?.type === 'function_call_output') outputs.push(event); },
      sessionConfig: { ...planned.sessionConfig, 'model_providers.fixture': { name: 'local fixture', base_url: `http://127.0.0.1:${bound.port}`, wire_api: 'responses', requires_openai_auth: false, supports_websockets: false } },
    } });
    try {
      await runtime.initialize();
      await runtime.start({ id: 'turn_limit', object: 'agent.session.turn', session_id: 'sess_limit', agent_id: 'agent_limit', subagent_id: null,
        status: 'queued', created_at: 100, started_at: null, completed_at: null, error: null, usage: null }, [{ role: 'user', content: [{ type: 'input_text', text: 'PARENT_LIMIT: start concurrent work.' }] }]);
      for (let n = 0; n < 1500; n++) {
        if (runtime.snapshot().turns[0]?.turn.status === 'completed') break;
        await delay(10);
      }
      const state = runtime.snapshot();
      expect(state.turns[0]?.turn.status, JSON.stringify(outputs)).toBe('completed');
      expect(state.subagents).toHaveLength(limit);
      expect(childCalls).toBe(limit);
      expect(state.turns[0]!.items.filter((item) => item.type === 'create_subagent_call').map((item) => item.status)).toEqual([...Array.from({ length: limit }, () => 'completed'), 'failed']);
      expect(JSON.stringify(outputs)).toContain('agent thread limit reached');
      expect(state.turns.filter(({ turn }) => turn.subagent_id !== null)).toHaveLength(limit);
      expect(state.turns.filter(({ turn }) => turn.subagent_id !== null).every(({ turn }) => turn.status === 'in_progress')).toBe(true);
    } finally {
      await runtime.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 25_000);

  // The boundary probe characterizes a native race; it is not passing parity
  // evidence when the native tool rejects follow-up work (see the ledger).
  for (const maxSubagents of [1, 6]) {
  it.each(Array.from({ length: requireParity ? 10 : 1 }, (_, index) => index + 1))(`preserves the native interruption and follow-up outcome (limit=${maxSubagents}, attempt %s)`, async () => {
    let rootCalls = 0;
    let childCalls = 0;
    const outputs: unknown[] = [];
    let childStarted!: () => void;
    const started = new Promise<void>((resolve) => { childStarted = resolve; });
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      if (!request.url?.endsWith('/responses')) { response.writeHead(404).end(); return; }
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { input: Array<{ role?: string; content?: unknown }> };
      const parent = body.input.some((item) => item.role === 'user' && JSON.stringify(item.content).includes('PARENT_TASK'));
      const count = parent ? ++rootCalls : ++childCalls;
      const id = `${parent ? 'root' : 'child'}_${count}`;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ type: 'response.created', response: { id } })}\n\n`);
      if (!parent && count === 1) { childStarted(); return; } // Real stream cancellation must interrupt this Turn.
      if (parent && count === 2) await started;
      const calls = [
        ['spawn_agent', { task_name: 'child_task', message: 'CHILD_TASK: wait for more work.', fork_turns: 'none' }],
        ['interrupt_agent', { target: 'child_task' }],
        ['followup_task', { target: 'child_task', message: 'CHILD_FOLLOW_UP: finish now.' }],
        ['wait_agent', { timeout_ms: 10_000 }],
      ] as const;
      const call = parent ? calls[count - 1] : undefined;
      const item = call
        ? { type: 'function_call', id: `fc_${id}`, call_id: `call_${id}`, namespace: 'collaboration', name: call[0], arguments: JSON.stringify(call[1]) }
        : { type: 'message', role: 'assistant', id: `msg_${id}`, content: [{ type: 'output_text', text: parent ? 'Parent finished.' : 'Child follow-up finished.' }], phase: 'final_answer' };
      response.end([{ type: 'response.output_item.done', item }, { type: 'response.completed', response: { id } }].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const bound = server.address(); if (!bound || typeof bound === 'string') throw new Error('Missing fixture address');
    const home = await mkdtemp(join(tmpdir(), 'rat-native-interrupt-'));
    const runtime = new SessionRuntime({ sessionId: 'sess_interrupt', agentId: 'agent_fixture', request: {
      binary: nativeBinary, workspace: home, environment: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home },
      timeoutMs: 20_000, persistent: true, prompt: '', sandbox: 'read-only', networkAccess: false, environments: [], model: 'gpt-5.4', modelProvider: 'fixture',
      onEvent: (event) => { if (event.method === 'rawResponseItem/completed' && (event.params.item as { type?: string })?.type === 'function_call_output') outputs.push(event); },
      sessionConfig: { 'model_providers.fixture': { name: 'local fixture', base_url: `http://127.0.0.1:${bound.port}`, wire_api: 'responses', requires_openai_auth: false, supports_websockets: false }, 'features.multi_agent': true, 'features.multi_agent_v2': { enabled: true, max_concurrent_threads_per_session: maxSubagents + 1 } },
    } });
    try {
      await runtime.initialize();
      await runtime.start({ id: 'turn_parent', object: 'agent.session.turn', session_id: 'sess_interrupt', agent_id: 'agent_fixture', subagent_id: null,
        status: 'queued', created_at: 100, started_at: null, completed_at: null, error: null, usage: null }, [{ role: 'user', content: [{ type: 'input_text', text: 'PARENT_TASK: delegate, interrupt and continue.' }] }]);
      for (let n = 0; n < 1500; n++) {
        if (runtime.snapshot().turns.length >= 2 && runtime.snapshot().turns.every(({ turn }) => ['completed', 'cancelled'].includes(turn.status))) break;
        await delay(10);
      }
      const state = runtime.snapshot();
      expect(state.subagents).toHaveLength(1);
      const child = state.subagents[0]!;
      const followup = state.turns[0]!.items.find((item) => item.type === 'send_subagent_input_call');
      const rejected = maxSubagents === 1 && followup?.type === 'send_subagent_input_call' && followup.status === 'failed';
      if (rejected) expect(JSON.stringify(outputs)).toContain('collab tool failed: agent thread limit reached');
      if (requireParity) expect(rejected, 'Native interrupted follow-up must succeed at the configured concurrency limit').toBe(false);
      expect(state.turns.filter(({ threadId }) => threadId === child.id).map(({ turn }) => turn.status), JSON.stringify({ state, outputs, rootCalls, childCalls })).toEqual(rejected ? ['cancelled'] : ['cancelled', 'completed']);
      expect(state.turns[0]!.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'create_subagent_call', status: 'completed' }),
        expect.objectContaining({ type: 'interrupt_subagent_call', status: 'completed' }),
        expect.objectContaining({ type: 'send_subagent_input_call', status: rejected ? 'failed' : 'completed' }),
        expect.objectContaining({ type: 'wait_for_subagents_call', status: 'completed' }),
      ]));
      for (const binding of state.turns) { parseAgentsContract('Turn', binding.turn); binding.items.forEach((item) => parseAgentsContract('Item', item)); }
      expect(rootCalls).toBe(5); expect(childCalls).toBe(rejected ? 1 : 2);
    } finally {
      await runtime.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 25_000);
  }

  it('recovers an absent native checkpoint from saved tool context without replay', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      if (!request.url?.endsWith('/responses')) { response.writeHead(404).end(); return; }
      requests.push(JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>);
      const id = `response_${requests.length}`;
      const item = requests.length === 1
        ? { type: 'function_call', id: 'fc_1', call_id: 'call_fixture', name: 'lookup', arguments: '{"key":"example"}' }
        : { type: 'message', role: 'assistant', id: `msg_${requests.length}`, content: [{ type: 'output_text', text: `Answer ${requests.length}` }], phase: 'final_answer' };
      const events = [{ type: 'response.created', response: { id } }, { type: 'response.output_item.done', item },
        { type: 'response.completed', response: { id, usage: { input_tokens: 2, output_tokens: 3, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 5 } } }];
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const bound = server.address(); if (!bound || typeof bound === 'string') throw new Error('Missing fixture address');
    const home = await mkdtemp(join(tmpdir(), 'rat-native-session-'));
    const history: AgentSessionItem[] = [
      { type: 'function_call', id: 'saved_call', turn_id: 'saved_turn', name: 'lookup', call_id: 'saved_call', arguments: { key: 'saved' }, status: 'completed' },
      { type: 'function_call_output', id: 'saved_output', turn_id: 'saved_turn', call_id: 'saved_call', output: '', error: null, status: 'completed' },
      { type: 'command_execution', id: 'saved_command', turn_id: 'saved_turn', command: 'write invoice', cwd: '/workspace', duration_ms: null, exit_code: null, output: 'SAVED_COMMAND_RESULT', status: 'incomplete' },
      { type: 'mcp_call', id: 'saved_mcp', turn_id: 'saved_turn', server_label: 'crm', name: 'save', arguments: { enabled: false }, output: { result: 'SAVED_MCP_RESULT' }, error: null, status: 'completed' },
      { type: 'agent_message', id: 'saved_message', turn_id: 'saved_turn', sender_agent_id: 'child', recipient_agent_id: 'root', content: [{ type: 'output_text', text: 'SAVED_CHILD_RESULT' }] },
      { type: 'close_subagent_call', id: 'saved_close', turn_id: 'saved_turn', sender_agent_id: 'root', recipient_agent_id: 'child', status: 'completed' },
      { type: 'function_call', id: 'unfinished', turn_id: 'saved_turn', name: 'lookup', call_id: 'unfinished', arguments: { key: 'unfinished' }, status: 'incomplete' },
    ];
    const planned = planSessionLaunch(planCodexLaunch({ version: '1', prompt: '', agent: { sandbox: 'read-only' } }, home, 15_000, {}), {
      sessionId: 'sess_fixture', turnId: 'turn_one', input: [], history, environment: { type: 'none' }, agent: sessionAgent({ model: 'gpt-5.4', multi_agent: { enabled: false } }, 'agent_fixture', 100),
    });
    const runtime = new SessionRuntime({ sessionId: 'sess_fixture', agentId: 'agent_fixture', request: {
      binary: nativeBinary, workspace: home, environment: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home },
      timeoutMs: 15_000, persistent: true, prompt: '', sandbox: 'read-only', networkAccess: false, environments: [], model: 'gpt-5.4', modelProvider: 'fixture',
      resumeThreadId: '00000000-0000-4000-8000-000000000000',
      recoveryItems: planned.recoveryItems!,
      sessionConfig: { ...planned.sessionConfig, 'model_providers.fixture': { name: 'local fixture', base_url: `http://127.0.0.1:${bound.port}`, wire_api: 'responses', requires_openai_auth: false, supports_websockets: false } },
      dynamicTools: [{ type: 'function', name: 'lookup', description: 'Look up a value', inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } }],
    } });
    const turn = (id: string): Turn => ({ id, object: 'agent.session.turn', session_id: 'sess_fixture', agent_id: 'agent_fixture', subagent_id: null,
      status: 'queued', created_at: 100, started_at: null, completed_at: null, error: null, usage: null });
    const input = [{ role: 'user' as const, content: [{ type: 'input_text' as const, text: 'Use the lookup tool.' }] }];
    async function until(predicate: () => boolean) { for (let n = 0; n < 500; n++) { if (predicate()) return; await delay(10); } throw new Error(`Native session did not reach expected state: ${JSON.stringify(runtime.snapshot().turns.map(({ turn }) => turn))}`); }
    try {
      const initial = await runtime.initialize();
      expect(initial.rootThreadId).not.toBe('00000000-0000-4000-8000-000000000000');
      expect(initial.requiredActions).toEqual([]);
      expect(initial.subagents).toEqual([]);
      expect(requests).toHaveLength(0);
      await runtime.start(turn('turn_one'), input);
      await until(() => runtime.snapshot().requiredActions.length > 0);
      expect(runtime.snapshot().requiredActions).toHaveLength(1);
      for (const fact of ['SAVED_COMMAND_RESULT', 'SAVED_MCP_RESULT', 'SAVED_CHILD_RESULT', 'unfinished', 'close_subagent_call']) expect(JSON.stringify(requests[0]!.input)).toContain(fact);
      const savedCalls = (requests[0]!.input as Array<Record<string, unknown>>).filter((item) => item.type === 'function_call');
      expect(savedCalls).toEqual([expect.objectContaining({ name: 'lookup', call_id: 'recovered_call_0' })]);
      await runtime.toolResult({ type: 'agent.session.input.tool_result', turn_id: 'turn_one', call_id: 'call_fixture', success: true, output: '' });
      await until(() => runtime.snapshot().turns.some((entry) => entry.turn.id === 'turn_one' && entry.turn.status === 'completed'));
      await runtime.start(turn('turn_two'), input);
      await until(() => runtime.snapshot().turns.some((entry) => entry.turn.id === 'turn_two' && entry.turn.status === 'completed'));
      const state = runtime.snapshot();
      expect(state.rootThreadId).toBe(initial.rootThreadId);
      expect(state.turns.map((entry) => entry.turn.id)).toEqual(['turn_one', 'turn_two']);
      expect(state.turns.map((entry) => entry.turn.usage?.total_tokens)).toEqual([10, 5]);
      expect(state.turns[0]!.items).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'function_call', call_id: 'call_fixture' })]));
      for (const binding of state.turns) { parseAgentsContract('Turn', binding.turn); binding.items.forEach((item) => parseAgentsContract('Item', item)); }
      expect(requests).toHaveLength(3);
      expect(requests.every((request) => request.model === 'gpt-5.4')).toBe(true);
      for (const request of requests) expect(toolNames(request.tools)).not.toContain('spawn_agent');
    } finally {
      await runtime.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
      // Codex may still be reaping short-lived marketplace helpers after its main process exits.
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 20_000);
});

function toolNames(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(toolNames);
  if (!value || typeof value !== 'object') return [];
  const tool = value as { name?: unknown; tools?: unknown };
  return [...typeof tool.name === 'string' ? [tool.name] : [], ...toolNames(tool.tools)];
}
