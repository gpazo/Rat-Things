import { describe, it, expect, vi } from 'vitest';
import OpenAI from 'openai';
import { SessionRuntime } from '../../src/runner/session-runtime.js';
import type { CodexRpcClient, CodexRpcEvent } from '../../src/adapters/codex-rpc.js';
import { runtimeSubagents } from '../../src/core/session-runtime-planning.js';
import { SessionService } from '../../src/core/session-service.js';
import { AgentService } from '../../src/core/agent-service.js';
import { parseAgentsContract } from '../../src/domain/agents-api-validation.js';
import type { Turn } from '../../src/domain/agents-api.js';
import { MemoryAgentsStore } from './fixtures.js';
import { routeAgentsRequest } from '../../src/lambdas/agents-router.js';
import type { CodexTurnController } from '../../src/runner/codex-app-server.js';

function fixture(lifetime?: 'bounded' | 'host-managed') {
  let handlers: ConstructorParameters<typeof CodexRpcClient>[0];
  let counter = 0;
  let closed = false;
  let controller: CodexTurnController;
  const calls: Array<{ method: string; params: unknown }> = [];
  const runtime = new SessionRuntime({ sessionId: 'sess', agentId: 'agent', now: () => 100,
    ...(lifetime ? { lifetime } : {}),
    request: { binary: 'unused', workspace: '/workspace', environment: {}, timeoutMs: 10_000, prompt: '', sandbox: 'read-only', persistent: true, modelProvider: 'openai', model: 'fixture', networkAccess: false, environments: [], dynamicTools: [{ type: 'function', name: 'lookup', description: 'Lookup', inputSchema: { type: 'object', properties: {} } }], onTurnStarted: (value) => { controller = value; } },
    client: (options) => {
      handlers = options;
      return {
        initialize: async () => {},
        call: async (method, params) => {
          calls.push({ method, params });
          if (method === 'thread/start') return { thread: { id: 'root' } };
          if (method === 'turn/start') {
            const id = `native-${++counter}`;
            options.onEvent!({ method: 'turn/started', params: { threadId: 'root', turn: { id, status: 'inProgress' } } });
            return { turn: { id } };
          }
          return {};
        },
        close: async () => { closed = true; options.onClose!(); },
      };
    },
  });
  return { runtime, calls, controller: () => controller, closed: () => closed, emit: (event: CodexRpcEvent) => handlers.onEvent!(event), request: (event: CodexRpcEvent & { requestId: string }) => handlers.onServerRequest!(event) };
}
const rootTurn = (id: string): Turn => ({ id, agent_id: 'agent', session_id: 'sess', subagent_id: null, object: 'agent.session.turn', status: 'queued', created_at: 90, started_at: null, completed_at: null, usage: null, error: null });
const message = [{ role: 'user' as const, content: [{ type: 'input_text' as const, text: 'Work' }] }];

describe('persistent native session runtime', () => {
  it('preserves the same harness beyond eight hours under trusted host lifetime control', async () => {
    vi.useFakeTimers();
    const f = fixture('host-managed');
    try {
      await f.runtime.initialize();
      await f.runtime.start(rootTurn('first'), message);
      await vi.advanceTimersByTimeAsync(9 * 60 * 60 * 1000);
      expect(f.closed()).toBe(false);
      f.emit({ method: 'turn/completed', params: { threadId: 'root', turn: { id: 'native-1', status: 'completed' } } });
      await f.runtime.start(rootTurn('second'), message);
      expect(f.calls.filter(({ method }) => method === 'thread/start')).toHaveLength(1);
      expect(f.calls.filter(({ method }) => method === 'turn/start')).toHaveLength(2);
    } finally { await f.runtime.close(); vi.useRealTimers(); }
  });
  it('fences delayed cancellation and steering to their intended public Turn', async () => {
    const f = fixture();
    try {
      await f.runtime.initialize();
      await f.runtime.start(rootTurn('first'), message);
      f.emit({ method: 'turn/completed', params: { threadId: 'root', turn: { id: 'native-1', status: 'completed' } } });
      await f.runtime.start(rootTurn('second'), message);
      await f.controller().interrupt('first');
      await expect(f.controller().steer('Delayed input', message, 'first')).rejects.toThrow('already ended');
      await expect(f.controller().interrupt()).rejects.toThrow('intended Session Turn');
      expect(f.calls.filter(({ method }) => method === 'turn/interrupt' || method === 'turn/steer')).toEqual([]);
      await f.controller().steer('Current input', message, 'second');
      await f.controller().interrupt('second');
      expect(f.calls.filter(({ method }) => method === 'turn/interrupt' || method === 'turn/steer')).toEqual([
        { method: 'turn/steer', params: { threadId: 'root', expectedTurnId: 'native-2', input: [{ type: 'text', text: 'Work' }] } },
        { method: 'turn/interrupt', params: { threadId: 'root', turnId: 'native-2' } },
      ]);
    } finally { await f.runtime.close(); }
  });
  it('attributes cumulative usage once, across model calls, duplicate events, and root Turns', async () => {
    const f = fixture(); await f.runtime.initialize();
    const usage = (inputTokens: number, outputTokens: number) => f.emit({ method: 'thread/tokenUsage/updated', params: { threadId: 'root', tokenUsage: { total: { inputTokens, outputTokens, cachedInputTokens: 0, reasoningOutputTokens: 0 } } } });
    await f.runtime.start(rootTurn('first'), message);
    usage(2, 3); usage(4, 6); usage(4, 6);
    f.emit({ method: 'turn/completed', params: { threadId: 'root', turn: { id: 'native-1', status: 'completed' } } });
    await f.runtime.start(rootTurn('second'), message);
    usage(6, 9);
    expect(f.runtime.snapshot().turns.map(({ turn }) => turn.usage?.total_tokens)).toEqual([10, 5]);
    await f.runtime.close();
  });

  it('keeps children running across root turns and isolates their items, state, and usage', async () => {
    const f = fixture();
    await f.runtime.initialize();
    await f.runtime.start(rootTurn('root-one'), message);
    await f.runtime.start(rootTurn('root-one'), message);
    f.emit({ method: 'thread/started', params: { thread: { id: 'child', parentThreadId: 'root', createdAt: 101, agentNickname: 'Research', preview: 'Check the design' } } });
    f.emit({ method: 'turn/started', params: { threadId: 'child', turn: { id: 'child-turn', status: 'inProgress' } } });
    f.emit({ method: 'item/completed', params: { threadId: 'child', turnId: 'child-turn', item: { id: 'child-output', type: 'agentMessage', text: 'Child only', phase: 'commentary' } } });
    f.emit({ method: 'turn/completed', params: { threadId: 'root', turn: { id: 'native-1', status: 'completed', completedAt: 102 } } });
    expect(f.closed()).toBe(false);
    await f.runtime.start(rootTurn('root-two'), message);
    f.emit({ method: 'thread/tokenUsage/updated', params: { threadId: 'child', tokenUsage: { last: { inputTokens: 5, outputTokens: 7, cachedInputTokens: 0, reasoningOutputTokens: 0 } } } });
    const state = f.runtime.snapshot();
    const roots = state.turns.filter((binding) => binding.threadId === 'root');
    expect(roots.map((binding) => [binding.turn.id, binding.turn.status, binding.turn.created_at])).toEqual([['root-one', 'completed', 90], ['root-two', 'in_progress', 90]]);
    expect(roots.flatMap((binding) => binding.items)).toEqual([]);
    const children = runtimeSubagents(state);
    expect(children[0]?.subagent).toMatchObject({ parent_agent_id: 'agent', status: 'active', name: 'Research' });
    expect(children[0]?.turns[0]?.usage?.total_tokens).toBe(12);
    expect(children[0]?.items[0]).toMatchObject({ content: [{ type: 'output_text', text: 'Child only' }] });
    for (const entry of children) {
      parseAgentsContract('Subagent', entry.subagent);
      entry.items.forEach((item) => parseAgentsContract('Item', item));
      entry.turns.forEach((turn) => parseAgentsContract('Turn', turn));
    }
    f.emit({ method: 'thread/closed', params: { threadId: 'child' } });
    f.emit({ method: 'thread/started', params: { thread: { id: 'child', parentThreadId: 'root', createdAt: 999, agentNickname: 'Research' } } });
    expect(runtimeSubagents(f.runtime.snapshot())[0]?.subagent).toMatchObject({ opened_at: 101, closed_at: null, status: 'active' });
    f.emit({ method: 'thread/started', params: { thread: { id: 'unrelated', parentThreadId: 'other-session' } } });
    expect(f.runtime.snapshot().subagents).toHaveLength(1);
    expect(f.calls.filter((call) => call.method === 'turn/start')).toHaveLength(2);
    await f.runtime.close();
    await f.runtime.finished;
    expect(f.runtime.snapshot().turns.find((binding) => binding.turn.id === 'root-two')?.turn.status).toBe('failed');
  });

  it('resolves root functions with empty output and rejects child functions and approval requests', async () => {
    const f = fixture();
    await f.runtime.initialize();
    await f.runtime.start(rootTurn('root-one'), message);
    const request = { method: 'item/tool/call', requestId: 'rpc-function', params: { threadId: 'root', turnId: 'native-1', callId: 'call', tool: 'lookup', arguments: {} } };
    f.emit(request);
    const pending = f.request(request);
    await f.runtime.toolResult({ type: 'agent.session.input.tool_result', turn_id: 'root-one', call_id: 'call', success: true, output: '' });
    expect(await pending).toEqual({ success: true, contentItems: [{ type: 'inputText', text: '' }] });
    expect(f.runtime.snapshot().requiredActions).toEqual([]);
    await expect(f.request({ ...request, params: { ...request.params, threadId: 'child' } })).rejects.toThrow('undeclared host interaction');
    await expect(f.request({ method: 'item/commandExecution/requestApproval', requestId: 'approval', params: {} })).rejects.toThrow('undeclared host interaction');
    await f.runtime.finished;
    expect(f.closed()).toBe(true);
  });

  it('exposes all six subagent routes with SDK paging and session ownership', async () => {
    const f = fixture();
    await f.runtime.initialize();
    const store = new MemoryAgentsStore();
    const agents = new AgentService({ store });
    const sessions = new SessionService({ store, agents, execution: {
      prepare: async () => ({ type: 'none' }), start: async () => {}, steer: async () => {}, cancel: async () => {}, toolResult: async () => {},
      observe: async (_owner, _session, turn) => ({ turn, requiredActions: [] }), items: async () => [], artifacts: async () => [], artifactContent: async () => new ReadableStream(),
      subagents: async (_owner, session) => runtimeSubagents(f.runtime.snapshot()).map((entry) => ({ ...entry, subagent: { ...entry.subagent, session_id: session.id }, turns: entry.turns.map((turn) => ({ ...turn, session_id: session.id })) })),
    } });
    const client = (owner: string) => new OpenAI({ apiKey: 'fixture', baseURL: 'https://fixture.invalid/v1', maxRetries: 0, fetch: (input, init) => routeAgentsRequest(new Request(input, init), owner, { agents, sessions }) }).beta.agents;
    const session = await client('alice').sessions.create({ agent: { model: 'fixture' }, environment: { type: 'none' }, input: 'Work' });
    for (const id of ['child-a', 'child-b']) {
      f.emit({ method: 'thread/started', params: { thread: { id, parentThreadId: 'root' } } });
      f.emit({ method: 'turn/started', params: { threadId: id, turn: { id: `${id}-turn` } } });
      f.emit({ method: 'item/completed', params: { threadId: id, turnId: `${id}-turn`, item: { id: `${id}-message`, type: 'agentMessage', text: id } } });
    }
    const api = client('alice').sessions.subagents;
    const ids: string[] = [];
    for await (const agent of api.list(session.id, { limit: 1 })) ids.push(agent.id);
    expect(ids).toHaveLength(2);
    expect((await api.retrieve(ids[0]!, { session_id: session.id })).id).toBe(ids[0]);
    const turns = await api.turns.list(ids[0]!, { session_id: session.id });
    const turnId = turns.data[0]!.id;
    expect((await api.turns.retrieve(turnId, { session_id: session.id, subagent_id: ids[0]! })).id).toBe(turnId);
    expect((await api.items.list(ids[0]!, { session_id: session.id })).data).toHaveLength(1);
    expect((await api.turns.items.list(turnId, { session_id: session.id, subagent_id: ids[0]! })).data).toHaveLength(1);
    await expect(api.turns.retrieve(turnId, { session_id: session.id, subagent_id: ids[1]! })).rejects.toMatchObject({ status: 404 });
    await expect(client('bob').sessions.subagents.list(session.id)).rejects.toMatchObject({ status: 404 });
    await f.runtime.close();
  });
});
