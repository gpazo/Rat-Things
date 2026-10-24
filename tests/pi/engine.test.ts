import { afterEach, describe, expect, it, vi } from 'vitest';
import { Type, createModels, fauxAssistantMessage, fauxProvider, fauxThinking, fauxToolCall, createAssistantMessageEventStream, type FauxResponseStep, type AssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { Harness, LiveDoc, type Storage } from '@earendil-works/pi-durable';
import { MemoryAgentsStore } from '../agents/fixtures.js';
import { piProjectionRepair } from '../../src/app/pi-projection-repair.js';
import type { SessionState } from '../../src/core/session-ports.js';
import { SessionRuntimeStore } from '../../src/core/session-runtime-store.js';
import { nativeLease } from '../../src/core/session-native-store.js';
import { planSessionStream, type SessionStreamSnapshot, type PlannedSessionEvent } from '../../src/core/session-stream.js';
import type { SessionRuntimeState } from '../../src/core/session-runtime-planning.js';
import { sessionAgent } from '../../src/core/session-planning.js';
import { resolveRuntime } from '../../src/domain/session-runtime.js';
import type { SessionLaunch } from '../../src/domain/session-execution.js';
import type { AgentSessionInputMessageParam, Turn } from '../../src/domain/agents-api.js';
import { openPiStorage } from '../../src/runner/pi/storage.js';
import { abortPiRecovery, openPiEngine, type PiEngine, type PiEngineOptions } from '../../src/runner/pi/engine.js';
import { piHasLiveTasks, projectPiStorage } from '../../src/runner/pi/projection.js';
import { PI_CONTEXT } from '../../src/runner/pi/protocol.js';

const running: PiEngine[] = [];
afterEach(async () => { await Promise.all(running.splice(0).map(engine => engine.close())); vi.restoreAllMocks(); });
const input = (text: string): AgentSessionInputMessageParam[] => [{ role: 'user', content: [{ type: 'input_text', text }] }];
const turn = (id = 'turn_1', sessionId = 'session'): Turn => ({ id, session_id: sessionId, agent_id: 'agent', subagent_id: null, object: 'agent.session.turn', status: 'queued', created_at: 1, started_at: null, completed_at: null, usage: null, error: null });
const answer = (text: string) => fauxAssistantMessage(text);
const tool = (name: string, args: Record<string, unknown>, id = 'model-call') => fauxAssistantMessage(fauxToolCall(name, args as never, { id }), { stopReason: 'toolUse' });
const text = (engine: PiEngine) => engine.snapshot().turns.flatMap(turn => turn.items.flatMap(item => item.type === 'message' && item.role === 'assistant' ? item.content.flatMap(part => part.type === 'output_text' ? [part.text] : []) : [])).join('\n');
async function until(predicate: () => boolean, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Pi test condition timed out'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; }
async function fixture(responses: FauxResponseStep[], changes: Partial<SessionLaunch['agent']> = {}, modelIds = ['test-model']) {
  const faux = fauxProvider({ provider: 'amazon-bedrock', api: 'bedrock-converse-stream', models: modelIds.map(id => ({ id, reasoning: true, input: ['text', 'image'], contextWindow: 100000, maxTokens: 10000 })), tokensPerSecond: Infinity });
  faux.setResponses(responses);
  const models = createModels(); models.setProvider(faux.provider);
  const store = new MemoryAgentsStore();
  const runtime = new SessionRuntimeStore(store);
  await runtime.claim('owner', 'session', 'run', 1);
  const lease = nativeLease(store, 'owner', 'session', 'run', 0);
  const pin = resolveRuntime({ rat_things_runtime: 'pi' }, null, modelIds.map(id => ({ id, name: 'Test', provider: 'amazon-bedrock', api: 'bedrock-converse-stream', region: 'us-east-1', input: ['text', 'image'], contextWindow: 100000, maxTokens: 10000, reasoning: ['none', 'minimal', 'low', 'medium', 'high'] })));
  const launch: SessionLaunch = { runtime: pin, sessionId: 'session', turnId: 'turn_1', turn: turn(), input: input('hello'), environment: { type: 'none' },
    agent: { ...sessionAgent({ model: 'test-model', reasoning: { effort: 'medium' } }, 'agent', 1), ...changes } };
  const open = async (overrides: Partial<PiEngineOptions> = {}, customStorage?: Storage) => {
    const nativeSeq = (await lease.load()).head?.seq ?? 0;
    const engine = await openPiEngine({ storage: customStorage ?? await openPiStorage(lease), models, launch, effect: async () => { throw new Error('unexpected tool'); }, nativeSeq, ...overrides });
    running.push(engine); return engine;
  };
  return { faux, models, store, runtime, lease, launch, open };
}

describe('native Pi Session engine', () => {
  it('publishes the cleanup commit sequence when recovery aborts unfinished native work', async () => {
    const f = await fixture([]);
    const engine = await f.open();
    await engine.start(turn(), input('accepted'));
    await engine.close();
    const state: SessionState = { runtime: f.launch.runtime!,
      session: { id: 'session', object: 'agent.session', agent: f.launch.agent, environment: f.launch.environment,
        created_at: 1, last_active_at: 1, status: 'in_progress', error: null, required_actions: [], usage: null, vault_ids: [], metadata: {} },
      turns: [{ turn: turn(), input: [] }], receipts: {}, deletedArtifacts: [] };
    await f.store.put({ ownerId: 'owner', collection: 'sessions', id: 'session', createdAt: 1, revision: 1, value: state }, 0);
    await piProjectionRepair(f.store)('owner', 'session');
    const original = (await f.runtime.get('owner', 'session'))!.value;
    expect(original.snapshot?.turns[0]?.turn.status).not.toBe('failed');
    expect(await piProjectionRepair(f.store, 'abort', () => 2_000_000_000_123)('owner', 'session')).toEqual({ hasLiveTasks: false });
    const repaired = (await f.runtime.get('owner', 'session'))!.value;
    expect(repaired.projectionSeq).toBe(repaired.native?.head?.seq);
    expect(repaired.projectionSeq).toBeGreaterThan(original.projectionSeq!);
    expect(repaired.snapshot?.turns[0]?.turn).toMatchObject({ status: 'failed', completed_at: 2_000_000_000, error: { code: 'server_error' } });
    expect(f.faux.state.callCount).toBe(0);
  });

  it('admits once while paused, finishes through actual Pi, and repairs projection without running tasks', async () => {
    const f = await fixture([fauxAssistantMessage([fauxThinking('private reasoning'), { type: 'text', text: 'Hello from Pi' }])]);
    const engine = await f.open({ mode: 'bounded' });
    await engine.start(turn(), input('hello'));
    await engine.start(turn(), input('hello'));
    expect(f.faux.state.callCount).toBe(0);
    engine.resume(); await engine.finished;
    expect(engine.snapshot().turns.map(binding => ({ id: binding.turn.id, status: binding.turn.status }))).toEqual([{ id: 'turn_1', status: 'completed' }]);
    expect(text(engine)).toBe('Hello from Pi');
    expect(JSON.stringify(engine.snapshot())).not.toContain('private reasoning');
    const original = engine.snapshot();
    const seq = engine.nativeSeq;
    expect(seq).toBe((await f.lease.load()).head?.seq);
    await engine.close();
    const storage = await openPiStorage(f.lease);
    const repaired = await projectPiStorage(storage, f.launch, seq);
    expect(repaired).toEqual({ snapshot: original, nativeSeq: seq, hasLiveTasks: false });
    expect(f.faux.state.callCount).toBe(1);
    await storage.close(PI_CONTEXT);
    const reopened = await f.open();
    await reopened.start(turn(), input('hello'));
    expect(reopened.snapshot()).toEqual(original);
    expect(f.faux.state.callCount).toBe(1);
  });

  it('reacquires one pending function action and consumes its committed result after restart', async () => {
    const f = await fixture([tool('lookup', { query: 'rat' }), answer('Found the result')], {
      tools: [{ type: 'function', name: 'lookup', description: 'Look up a value', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false }, defer_loading: false }],
    });
    const first = await f.open(); await first.start(turn(), input('lookup')); first.resume();
    await until(() => first.snapshot().requiredActions.length === 1);
    const action = first.snapshot().requiredActions[0]!;
    expect(action).toMatchObject({ name: 'lookup', arguments: { query: 'rat' }, turn_id: 'turn_1' });
    const callId = action.type === 'function_call' ? action.call_id : '';
    await first.close();
    const second = await f.open({ mode: 'bounded' });
    expect(second.snapshot().requiredActions).toEqual([action]);
    await expect(second.toolResult('pi_call_unknown', { success: true, output: 'unknown' })).rejects.toThrow('Unknown Pi function call');
    expect(second.snapshot().requiredActions).toEqual([action]);
    await second.toolResult(callId, { success: true, output: 'durable result' });
    await second.toolResult(callId, { success: true, output: 'durable result' });
    await expect(second.toolResult(callId, { success: true, output: 'different' })).rejects.toThrow('different content');
    second.resume(); await second.finished;
    expect(second.snapshot().requiredActions).toEqual([]);
    expect(text(second)).toBe('Found the result');
    expect(second.snapshot().turns[0]?.items.filter(item => item.type === 'function_call_output')).toMatchObject([{ call_id: callId, output: 'durable result', status: 'completed' }]);
    expect(f.faux.state.callCount).toBe(2);
  });

  it('does not repeat an unsafe host effect interrupted before its result commit', async () => {
    const f = await fixture([tool('remote_write', { value: 'one' }), answer('The interrupted write is uncertain')]);
    let calls = 0;
    const entered = deferred<void>();
    const effect: PiEngineOptions['effect'] = async (_request, signal) => {
      calls++; entered.resolve();
      return new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('terminated')), { once: true }));
    };
    const options: Partial<PiEngineOptions> = { effect, effectTools: [{ name: 'remote_write', description: 'Write remotely', kind: 'mcp', serverLabel: 'remote', toolName: 'original_write', parameters: Type.Object({ value: Type.String() }) }] };
    const first = await f.open(options); await first.start(turn(), input('write')); first.resume(); await entered.promise;
    await first.close();
    const second = await f.open({ ...options, mode: 'bounded' }); second.resume(); await second.finished;
    expect(calls).toBe(1);
    expect(text(second)).toBe('The interrupted write is uncertain');
    expect(second.snapshot().turns[0]?.items.find(item => item.type === 'mcp_call')).toMatchObject({ status: 'failed', server_label: 'remote', name: 'original_write' });
    const snapshot = second.snapshot();
    const seq = second.nativeSeq;
    await second.close();
    const storage = await openPiStorage(f.lease);
    const repair = await projectPiStorage(storage, f.launch, seq);
    expect(repair).toEqual({ snapshot, nativeSeq: seq, hasLiveTasks: false });
    await storage.close(PI_CONTEXT);
  });
});


describe('Pi controls and durable graph', () => {
  it('steers only the intended Turn, deduplicates admission, and retains the association through final-boundary handoff', async () => {
    const requested = deferred<void>();
    const release = deferred<ReturnType<typeof answer>>();
    const f = await fixture([async () => { requested.resolve(); return release.promise; }, tool('lookup', { query: 'steered' }), answer('Steered answer')], {
      tools: [{ type: 'function', name: 'lookup', description: 'Lookup', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, defer_loading: false }],
    });
    const engine = await f.open(); await engine.start(turn(), input('first')); engine.resume(); await requested.promise;
    await engine.steer('turn_1', input('correction'), 'op-1');
    await engine.steer('turn_1', input('correction'), 'op-1');
    await expect(engine.steer('turn_1', input('different'), 'op-1')).rejects.toThrow('different command');
    release.resolve(answer('First answer'));
    await until(() => engine.snapshot().requiredActions.length === 1);
    expect(engine.snapshot().turns.map(binding => ({ id: binding.turn.id, status: binding.turn.status }))).toEqual([{ id: 'turn_1', status: 'waiting' }]);
    const action = engine.snapshot().requiredActions[0]!;
    expect(action).toMatchObject({ turn_id: 'turn_1', arguments: { query: 'steered' } });
    await engine.close();
    const recovered = await f.open({ mode: 'bounded' });
    await recovered.toolResult(action.type === 'function_call' ? action.call_id : '', { success: true, output: 'ok' });
    recovered.resume(); await recovered.finished;
    expect(text(recovered)).toBe('First answer\nSteered answer');
    expect(f.faux.state.callCount).toBe(3);
    const before = recovered.nativeSeq;
    await recovered.steer('turn_1', input('too late'), 'stale-op');
    expect(recovered.nativeSeq).toBe(before + 1);
    expect(text(recovered)).toBe('First answer\nSteered answer');
    expect(f.faux.state.callCount).toBe(3);
  });

  it('retargets cancellation across a generation handoff without cancelling a subsequent Turn', async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const f = await fixture([tool('managed_read', {}), async (_context, options) => {
      await new Promise<never>((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('request aborted')), { once: true }));
      return answer('unreachable');
    }]);
    const originalOpen = Harness.open;
    const targets: number[] = [];
    vi.spyOn(Harness, 'open').mockImplementation(async (...args) => {
      const harness = await originalOpen(...args);
      const abort = harness.abortTask.bind(harness);
      harness.abortTask = async (id, context) => {
        targets.push(id);
        if (targets.length === 1) {
          release.resolve();
          const deadline = Date.now() + 3000;
          while ((await harness.snapshot(LiveDoc, 1 as never, PI_CONTEXT))?.run?.taskId === id) {
            if (Date.now() > deadline) throw new Error('generation handoff timed out');
            await new Promise(resolve => setTimeout(resolve, 1));
          }
        }
        return abort(id, context);
      };
      return harness;
    });
    const engine = await f.open({ effectTools: [{ name: 'managed_read', description: 'Read', kind: 'mcp', serverLabel: 'remote', toolName: 'read', parameters: Type.Object({}) }], effect: async () => { entered.resolve(); await release.promise; return { output: [{ type: 'text', text: 'read complete' }] }; } });
    await engine.start(turn(), input('read')); engine.resume(); await entered.promise;
    await engine.cancel('turn_1');
    await until(() => engine.snapshot().turns[0]?.turn.status === 'cancelled');
    expect(targets.length).toBe(2);
    expect(new Set(targets).size).toBe(2);
    f.faux.setResponses([answer('Next Turn succeeds')]);
    await engine.start(turn('turn_2'), input('next'));
    await until(() => engine.snapshot().turns[1]?.turn.status === 'completed');
    await engine.cancel('turn_1');
    expect(engine.snapshot().turns.map(binding => binding.turn.status)).toEqual(['cancelled', 'completed']);
    expect(text(engine)).toBe('Next Turn succeeds');
  });

  it('recovers a working child after root completion with stable function and child identities', async () => {
    const route: FauxResponseStep = context => {
      const lastUser = [...context.messages].reverse().find(message => message.role === 'user');
      const child = lastUser?.role === 'user' && lastUser.content === 'child work';
      const results = context.messages.filter(message => message.role === 'toolResult');
      if (child) return results.some(message => message.toolName === 'lookup') ? answer('Child done') : tool('lookup', { query: 'child' });
      return results.some(message => message.toolName === 'spawn_agent') ? answer('Root done') : tool('spawn_agent', { name: 'researcher', message: 'child work' });
    };
    const f = await fixture(Array.from({ length: 12 }, () => route), {
      multi_agent: { enabled: true, max_concurrent_subagents: 2 },
      tools: [{ type: 'function', name: 'lookup', description: 'Lookup', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, defer_loading: false }],
    });
    const first = await f.open(); await first.start(turn(), input('root work')); first.resume();
    await until(() => first.snapshot().turns[0]?.turn.status === 'completed' && first.snapshot().requiredActions.length === 1);
    const child = first.snapshot().subagents[0]!;
    const action = first.snapshot().requiredActions[0]!;
    expect(child).toMatchObject({ name: 'researcher', status: 'active', parent_agent_id: 'agent' });
    expect(first.snapshot().turns[1]?.turn).toMatchObject({ status: 'waiting', subagent_id: child.id });
    await first.close();
    const storage = await openPiStorage(f.lease);
    expect(await piHasLiveTasks(storage)).toBe(true);
    await storage.close(PI_CONTEXT);
    const second = await f.open({ mode: 'bounded' });
    expect(second.snapshot().subagents).toEqual([child]);
    expect(second.snapshot().requiredActions).toEqual([action]);
    await second.toolResult(action.type === 'function_call' ? action.call_id : '', { success: true, output: 'child result' });
    second.resume(); await second.finished;
    expect(second.snapshot().turns.map(binding => binding.turn.status)).toEqual(['completed', 'completed']);
    expect(text(second)).toBe('Root done\nChild done');
    expect(f.faux.state.callCount).toBe(4);
    await second.close();
    const idle = await openPiStorage(f.lease);
    expect(await piHasLiveTasks(idle)).toBe(false);
    await idle.close(PI_CONTEXT);
  });

  it('imports fork context into independent storage without source tasks, child links, or old usage', async () => {
    const source = await fixture([answer('Remember the blue rat')]);
    const first = await source.open({ mode: 'bounded' }); await first.start(turn(), input('remember')); first.resume(); await first.finished;
    const checkpoint = await first.checkpoint();
    await first.close(); source.store.resources.clear();
    let seen = '';
    const target = await fixture([context => { seen = JSON.stringify(context.messages); return answer('I remember'); }]);
    const engine = await target.open({ mode: 'bounded', seed: checkpoint });
    expect(engine.snapshot().turns[0]?.turn.usage).toBeNull();
    await engine.start(turn('turn_fork'), input('what do you remember')); engine.resume(); await engine.finished;
    expect(seen).toContain('Remember the blue rat');
    expect(engine.snapshot().subagents).toEqual([]);
    expect(engine.snapshot().turns.map(binding => binding.turn.id)).toEqual(['turn_1', 'turn_fork']);
    expect(text(engine)).toBe('Remember the blue rat\nI remember');
    expect(target.faux.state.callCount).toBe(1);
  });
});


describe('Pi coordination replay', () => {
  it('reacquires spawn after a committed child creation loses its acknowledgement', async () => {
    const route: FauxResponseStep = context => {
      const child = context.messages.some(message => message.role === 'user' && message.content === 'child job');
      if (child) return answer('Child finished');
      return context.messages.some(message => message.role === 'toolResult') ? answer('Root finished') : tool('spawn_agent', { name: 'worker', message: 'child job' });
    };
    const f = await fixture(Array.from({ length: 8 }, () => route), { multi_agent: { enabled: true, max_concurrent_subagents: 2 } });
    const base = await openPiStorage(f.lease);
    const interrupted = new Proxy(base, { get(target, key) {
      if (key === 'commit') return async (...args: Parameters<Storage['commit']>) => {
        const seq = await target.commit(...args);
        if (args[0].some(write => write.type === 'conversation' && write.value.id !== 1)) throw new Error('worker lost after durable child creation');
        return seq;
      };
      const value: unknown = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const first = await f.open({}, interrupted); await first.start(turn(), input('spawn')); first.resume();
    await expect(first.finished).rejects.toThrow('worker lost');
    const repair = await openPiStorage(f.lease);
    const stored = await projectPiStorage(repair, f.launch, (await f.lease.load()).head!.seq);
    expect(stored.snapshot.subagents.map(child => child.name)).toEqual(['worker']);
    const childId = stored.snapshot.subagents[0]!.id;
    await repair.close(PI_CONTEXT);
    const second = await f.open({ mode: 'bounded' }); second.resume(); await second.finished;
    expect(second.snapshot().subagents.map(child => child.id)).toEqual([childId]);
    expect(second.snapshot().turns.map(binding => binding.turn.status)).toEqual(['completed', 'completed']);
    expect(text(second)).toBe('Root finished\nChild finished');
    expect(f.faux.state.callCount).toBe(3);
  });

  it('recovers send and wait receipts, then closes the durable child', async () => {
    const route: FauxResponseStep = context => {
      const lastUser = [...context.messages].reverse().find(message => message.role === 'user');
      const results = context.messages.filter(message => message.role === 'toolResult');
      if (lastUser?.role === 'user' && lastUser.content === 'first child') return results.some(message => message.toolName === 'lookup') ? answer('First child complete') : tool('lookup', { query: 'child' });
      if (lastUser?.role === 'user' && lastUser.content === 'second child') return answer('Second child complete');
      const spawn = results.find(message => message.toolName === 'spawn_agent');
      if (!spawn) return tool('spawn_agent', { name: 'worker', message: 'first child' });
      const id = JSON.parse(spawn.content.find(part => part.type === 'text')!.text).agent_id as string;
      if (!results.some(message => message.toolName === 'send_input')) return tool('send_input', { id, message: 'second child' });
      if (!results.some(message => message.toolName === 'wait_agent')) return tool('wait_agent', { ids: [id] });
      if (!results.some(message => message.toolName === 'close_agent')) return tool('close_agent', { id });
      return answer('All closed');
    };
    const f = await fixture(Array.from({ length: 16 }, () => route), {
      multi_agent: { enabled: true, max_concurrent_subagents: 2 },
      tools: [{ type: 'function', name: 'lookup', description: 'Lookup', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, defer_loading: false }],
    });
    const first = await f.open(); await first.start(turn(), input('root')); first.resume();
    await until(() => first.snapshot().turns[0]?.items.some(item => item.type === 'wait_for_subagents_call') === true && first.snapshot().requiredActions.length === 1);
    const pending = first.snapshot().requiredActions[0]!;
    const childId = first.snapshot().subagents[0]!.id;
    const childTurns = first.snapshot().turns.filter(binding => binding.turn.subagent_id === childId).map(binding => binding.turn.id);
    expect(childTurns.length).toBe(2);
    await first.close();
    const second = await f.open({ mode: 'bounded' });
    await second.toolResult(pending.type === 'function_call' ? pending.call_id : '', { success: true, output: 'ready' });
    second.resume(); await second.finished;
    expect(second.snapshot().turns.filter(binding => binding.turn.subagent_id === childId).map(binding => binding.turn.id)).toEqual(childTurns);
    expect(second.snapshot().subagents).toMatchObject([{ id: childId, status: 'closed' }]);
    expect(second.snapshot().turns.map(binding => binding.turn.status)).toEqual(['completed', 'completed', 'completed']);
    expect(second.snapshot().turns[0]?.items.filter(item => item.type !== 'message').map(item => ({ type: item.type, status: 'status' in item ? item.status : null }))).toEqual([
      { type: 'create_subagent_call', status: 'completed' }, { type: 'send_subagent_input_call', status: 'completed' }, { type: 'wait_for_subagents_call', status: 'completed' }, { type: 'close_subagent_call', status: 'completed' },
    ]);
    expect(text(second)).toBe('All closed\nFirst child complete\nSecond child complete');
    expect(f.faux.state.callCount).toBe(8);
  });

  it('rejects unsupported settings before admission and exposes no managed effect in a none environment', async () => {
    const f = await fixture([answer('Allowed')]);
    const engine = await f.open({ mode: 'bounded' });
    const seq = engine.nativeSeq;
    await expect(engine.start(turn(), input('bad'), { model: 'not-pinned', service_tier: 'auto', reasoning: { effort: 'medium' } })).rejects.toThrow('approved Pi catalog');
    await expect(engine.start(turn(), input('bad'), { model: 'test-model', service_tier: 'priority', reasoning: { effort: 'medium' } })).rejects.toThrow('auto service tier');
    expect(engine.nativeSeq).toBe(seq);
    expect(f.faux.state.callCount).toBe(0);
    await expect(f.open({ effectTools: [{ name: 'shell', description: 'Shell', kind: 'managed', parameters: Type.Object({}) }] })).rejects.toThrow('none environment');
    await engine.start(turn(), input('good')); engine.resume(); await engine.finished;
    expect(text(engine)).toBe('Allowed');
  });
});


describe('Pi model accounting and fork boundaries', () => {
  it('pins the model of an active Turn through tool rounds and applies a new model only on the next admitted Turn', async () => {
    const seen: string[] = [];
    const responses: FauxResponseStep[] = [
      (_context, _options, _state, model) => { seen.push(model.id); return tool('lookup', { query: 'first' }); },
      (_context, _options, _state, model) => { seen.push(model.id); return answer('First model finished'); },
      (_context, _options, _state, model) => { seen.push(model.id); return answer('Second model finished'); },
    ];
    const f = await fixture(responses, { tools: [{ type: 'function', name: 'lookup', description: 'Lookup', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, defer_loading: false }] }, ['test-model', 'second-model']);
    const engine = await f.open(); await engine.start(turn(), input('first')); engine.resume();
    await until(() => engine.snapshot().requiredActions.length === 1);
    const settings = { model: 'second-model', service_tier: 'auto' as const, reasoning: { effort: 'low' as const } };
    const before = engine.nativeSeq;
    await expect(engine.start(turn('turn_2'), input('second'), settings)).rejects.toThrow('active Turn');
    expect(engine.nativeSeq).toBe(before);
    const action = engine.snapshot().requiredActions[0]!;
    await engine.toolResult(action.type === 'function_call' ? action.call_id : '', { success: true, output: 'done' });
    await until(() => engine.snapshot().turns[0]?.turn.status === 'completed');
    await engine.start(turn('turn_2'), input('second'), settings);
    await until(() => engine.snapshot().turns[1]?.turn.status === 'completed');
    expect(seen).toEqual(['test-model', 'test-model', 'second-model']);
    expect(text(engine)).toBe('First model finished\nSecond model finished');
    const checkpoint = await engine.checkpoint();
    expect({ model: checkpoint.model, reasoning: checkpoint.reasoning }).toEqual({ model: 'second-model', reasoning: 'low' });
  });

  it('replays a completed Turn after model revocation without admitting new work on the revoked model', async () => {
    const f = await fixture([answer('Original answer'), answer('Allowed model answer')], {}, ['test-model', 'second-model']);
    const first = await f.open({ mode: 'bounded' }); await first.start(turn(), input('original')); first.resume(); await first.finished;
    const completed = first.snapshot(); await first.close();
    const getModel = f.models.getModel.bind(f.models);
    vi.spyOn(f.models, 'getModel').mockImplementation((provider, model) => model === 'test-model' ? undefined : getModel(provider, model));
    const second = await f.open({ mode: 'bounded', launch: { ...f.launch, agent: { ...f.launch.agent, model: 'second-model' } } });
    const seq = second.nativeSeq;
    const oldSettings = { model: 'test-model', service_tier: 'auto' as const, reasoning: { effort: 'medium' as const } };
    await second.start(turn(), input('original'), oldSettings);
    expect(second.nativeSeq).toBe(seq); expect(second.snapshot()).toEqual(completed);
    await expect(second.start(turn('turn_revoked'), input('new revoked'), oldSettings)).rejects.toThrow('unavailable');
    expect(second.nativeSeq).toBe(seq); expect(f.faux.state.callCount).toBe(1);
    await second.start(turn('turn_allowed'), input('new allowed')); second.resume(); await second.finished;
    expect(second.snapshot().turns.at(-1)?.turn).toMatchObject({ id: 'turn_allowed', status: 'completed' });
    expect(f.faux.state.callCount).toBe(2);
  });

  it('counts each committed answer once, including cache and reasoning token counts without publishing reasoning text', async () => {
    const f = await fixture([]);
    const message = { ...fauxAssistantMessage([fauxThinking('hidden'), { type: 'text', text: 'Visible' }]), api: 'bedrock-converse-stream', provider: 'amazon-bedrock', model: 'test-model',
      usage: { input: 10, output: 8, cacheRead: 3, cacheWrite: 2, reasoning: 4, totalTokens: 23, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = vi.spyOn(f.models, 'streamSimple').mockImplementation(() => {
      const result = createAssistantMessageEventStream(); result.push({ type: 'done', reason: 'stop', message }); return result;
    });
    const first = await f.open({ mode: 'bounded' }); await first.start(turn(), input('account')); first.resume(); await first.finished;
    const expected = { input_tokens: 15, output_tokens: 8, total_tokens: 23, input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 4 } };
    expect(first.snapshot().turns[0]?.turn.usage).toEqual(expected);
    expect(text(first)).toBe('Visible');
    expect(JSON.stringify(first.snapshot())).not.toContain('hidden');
    await first.close();
    const reopened = await f.open();
    expect(reopened.snapshot().turns[0]?.turn.usage).toEqual(expected);
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it('checkpoints a root with an idle open child and imports no source task graph', async () => {
    const route: FauxResponseStep = context => context.messages.some(message => message.role === 'user' && message.content === 'child memory') ? answer('Private child answer')
      : context.messages.some(message => message.role === 'toolResult') ? answer('Root memory') : tool('spawn_agent', { name: 'worker', message: 'child memory' });
    const source = await fixture(Array.from({ length: 8 }, () => route), { multi_agent: { enabled: true, max_concurrent_subagents: 2 } });
    const first = await source.open({ mode: 'bounded' }); await first.start(turn(), input('root')); first.resume(); await first.finished;
    expect(first.snapshot().subagents).toMatchObject([{ status: 'active', name: 'worker' }]);
    const checkpoint = await first.checkpoint();
    expect(checkpoint.history.map(binding => binding.turn.subagent_id)).toEqual([null]);
    expect(JSON.stringify(checkpoint.messages)).not.toContain('Private child answer');
    await first.close(); source.store.resources.clear();
    const target = await fixture([answer('Independent fork')]);
    const second = await target.open({ mode: 'bounded', seed: checkpoint });
    expect(second.snapshot().subagents).toEqual([]);
    expect(second.snapshot().inheritedNativeTurnIds).toEqual([`pi_fork_${checkpoint.history[0]!.nativeTurnId}`]);
    const native = await target.lease.load();
    expect(native.commits.flatMap(commit => commit.writes).filter(write => typeof write === 'object' && write !== null && 'type' in write && write.type === 'task')).toEqual([]);
    await second.start(turn('turn_fork'), input('continue')); second.resume(); await second.finished;
    expect(text(second)).toBe('Root memory\nIndependent fork');
    const items = second.snapshot().turns.flatMap(binding => binding.items);
    expect(new Set(items.map(item => item.id)).size).toBe(items.length);
    expect(second.snapshot().turns[0]!.items.every(item => item.id?.startsWith('pi_fork_'))).toBe(true);
    expect(target.faux.state.callCount).toBe(1);
  });
});


describe('Pi committed streaming identity', () => {
  function collectStream(launch: SessionLaunch) {
    let previous: SessionStreamSnapshot | undefined;
    const events: PlannedSessionEvent[] = [];
    return { events, changed(state: SessionRuntimeState) {
      const current: SessionStreamSnapshot = { session: { id: launch.sessionId, object: 'agent.session', agent: launch.agent, environment: launch.environment,
        created_at: 1, last_active_at: 1, error: null, metadata: {}, required_actions: state.requiredActions, status: 'in_progress', usage: null, vault_ids: [] },
        turns: state.turns.map(binding => binding.turn), items: state.turns.flatMap(binding => binding.items) };
      events.push(...planSessionStream(previous, current)); previous = current;
    } };
  }
  function partial(stream: AssistantMessageEventStream, text: string): AssistantMessage {
    const message: AssistantMessage = { ...fauxAssistantMessage(text), api: 'bedrock-converse-stream', provider: 'amazon-bedrock', model: 'test-model', stopReason: 'pending' };
    stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: message });
    return message;
  }
  it('streams one message ID from incremental native partials through completion and read-only reopen', async () => {
    const f = await fixture([]);
    const entered = deferred<AssistantMessageEventStream>();
    vi.spyOn(f.models, 'streamSimple').mockImplementation(() => { const stream = createAssistantMessageEventStream(); entered.resolve(stream); return stream; });
    const sink = collectStream(f.launch);
    const first = await f.open({ mode: 'bounded', changed: sink.changed }); await first.start(turn(), input('stream')); first.resume();
    const stream = await entered.promise;
    partial(stream, 'First'); await until(() => sink.events.some(event => event.type === 'agent.session.turn.output_text.delta'));
    const complete = partial(stream, 'First and second'); await until(() => sink.events.filter(event => event.type === 'agent.session.turn.output_text.delta').length === 2);
    stream.push({ type: 'done', reason: 'stop', message: { ...complete, stopReason: 'stop' } });
    await first.finished;
    const added = sink.events.filter(event => event.type === 'agent.session.turn.item.added');
    const deltas = sink.events.filter(event => event.type === 'agent.session.turn.output_text.delta');
    const done = sink.events.filter(event => event.type === 'agent.session.turn.item.done');
    expect(added).toHaveLength(1); expect(done).toHaveLength(1);
    expect(deltas.map(event => event.delta)).toEqual(['First', ' and second']);
    expect(new Set([...added.map(event => event.item.id), ...deltas.map(event => event.item_id), ...done.map(event => event.item.id)])).toEqual(new Set([first.snapshot().turns[0]!.items[0]!.id]));
    const snapshot = first.snapshot(); await first.close();
    const eventCount = sink.events.length;
    const published = deferred<void>();
    const reopened = await f.open({ changed: state => { sink.changed(state); published.resolve(); } }); await published.promise;
    expect(reopened.snapshot()).toEqual(snapshot); expect(sink.events).toHaveLength(eventCount);
    expect(text(reopened)).toBe('First and second');
  });
  it('finalizes an interrupted partial under its original ID and gives a divergent retry a new ID', async () => {
    const f = await fixture([]);
    const entered = deferred<AssistantMessageEventStream>();
    const resumed = deferred<AssistantMessageEventStream>();
    let count = 0;
    vi.spyOn(f.models, 'streamSimple').mockImplementation((_model, _context, options) => {
      const stream = createAssistantMessageEventStream();
      if (++count === 1) {
        options?.signal?.addEventListener('abort', () => stream.push({ type: 'error', reason: 'aborted', error: { ...fauxAssistantMessage('Old attempt'), stopReason: 'aborted' } }), { once: true });
        entered.resolve(stream);
      } else resumed.resolve(stream);
      return stream;
    });
    const sink = collectStream(f.launch);
    const first = await f.open({ changed: sink.changed }); await first.start(turn(), input('restart')); first.resume();
    partial(await entered.promise, 'Old attempt'); await until(() => sink.events.some(event => event.type === 'agent.session.turn.output_text.delta'));
    const oldId = first.snapshot().turns[0]!.items[0]!.id;
    await first.close();
    const second = await f.open({ mode: 'bounded', changed: sink.changed }); second.resume();
    const stream = await resumed.promise;
    const message = partial(stream, 'Different answer'); await until(() => second.snapshot().turns[0]!.items.length === 2);
    stream.push({ type: 'done', reason: 'stop', message: { ...message, stopReason: 'stop' } }); await second.finished;
    const items = second.snapshot().turns[0]!.items;
    expect(items).toMatchObject([{ id: oldId, status: 'incomplete' }, { status: 'completed' }]);
    expect(items[1]!.id).not.toBe(oldId);
    const done = sink.events.filter(event => event.type === 'agent.session.turn.item.done');
    expect(done.map(event => ({ id: event.item.id, status: event.item.status }))).toEqual([{ id: oldId, status: 'incomplete' }, { id: items[1]!.id, status: 'completed' }]);
    expect(sink.events.filter(event => event.type === 'agent.session.turn.output_text.delta').map(event => event.delta)).toEqual(['Old attempt', 'Different answer']);
    const snapshot = second.snapshot(); await second.close(); const reopened = await f.open(); expect(reopened.snapshot()).toEqual(snapshot);
  });
});


describe('Pi recovery exhaustion', () => {
  it('durably ends root, child and queued work without inference and then admits a new Turn', async () => {
    const route: FauxResponseStep = context => {
      const last = [...context.messages].reverse().find(message => message.role === 'user');
      const prompt = last?.role === 'user' ? typeof last.content === 'string' ? last.content : last.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('') : '';
      if (prompt === 'previous completed') return answer('Previous answer');
      if (prompt === 'fresh turn') return answer('New answer');
      if (prompt === 'first child') return tool('lookup', { query: 'child' });
      const results = context.messages.filter(message => message.role === 'toolResult');
      const spawn = results.find(message => message.toolName === 'spawn_agent');
      if (!spawn) return tool('spawn_agent', { name: 'worker', message: 'first child' });
      const id = JSON.parse(spawn.content.find(part => part.type === 'text')!.text).agent_id as string;
      if (!results.some(message => message.toolName === 'send_input')) return tool('send_input', { id, message: 'queued child' });
      return tool('wait_agent', { ids: [id] });
    };
    const f = await fixture(Array.from({ length: 16 }, () => route), {
      multi_agent: { enabled: true, max_concurrent_subagents: 2 },
      tools: [{ type: 'function', name: 'lookup', description: 'Lookup', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, defer_loading: false }],
    });
    const first = await f.open();
    await first.start(turn('turn_cancelled'), input('previous cancelled')); await first.cancel('turn_cancelled'); first.resume();
    await until(() => first.snapshot().turns[0]?.turn.status === 'cancelled');
    await first.start(turn('turn_completed'), input('previous completed')); await until(() => first.snapshot().turns[1]?.turn.status === 'completed');
    await first.start(turn(), input('exhausted root'));
    await until(() => first.snapshot().turns[2]?.items.some(item => item.type === 'wait_for_subagents_call') === true && first.snapshot().requiredActions.length === 1);
    await first.steer('turn_1', input('queued root correction'), 'recovery-steer');
    const childId = first.snapshot().subagents[0]!.id;
    const activeIds = first.snapshot().turns.filter(binding => ['queued', 'waiting', 'in_progress'].includes(binding.turn.status)).map(binding => binding.turn.id);
    expect(activeIds).toHaveLength(3);
    await first.close();
    const calls = f.faux.state.callCount;
    const native = await f.lease.load();
    const open = Harness.open;
    let maintenanceStreams = 0; let maintenanceOpens = 0;
    const cleanup: string[] = [];
    let expectedCleanup: string[] = [];
    const maintenance = vi.spyOn(Harness, 'open').mockImplementation(async (...args) => {
      expect(args[1].registry.snapshot().tools()).toEqual([]);
      maintenanceOpens++;
      const stream = args[1].models.streamSimple.bind(args[1].models);
      args[1].models.streamSimple = (...request) => { maintenanceStreams++; return stream(...request); };
      const harness = await open(...args);
      const inspection = await harness.inspect(PI_CONTEXT);
      expectedCleanup = [...inspection.tasks.map(task => `abort:${task.record.id}`), ...inspection.submissions.filter(submission => submission.status === 'queued').map(submission => `submission:${submission.id}`), ...inspection.tasks.map(task => `wait:${task.record.id}`)];
      harness.subscribeCommits(() => cleanup.push('commit'));
      const abort = harness.abortTask.bind(harness);
      harness.abortTask = async (id, context) => { cleanup.push(`abort:${id}`); return abort(id, context); };
      const abortSubmission = harness.abortSubmission.bind(harness);
      harness.abortSubmission = async (id, context) => { cleanup.push(`submission:${id}`); return abortSubmission(id, context); };
      const wait = harness.waitForTask.bind(harness);
      harness.waitForTask = async (id, context) => { cleanup.push(`wait:${id}`); return wait(id, context); };
      return harness;
    });
    const cleaned = await abortPiRecovery(await openPiStorage(f.lease), f.launch, native.head!.seq, () => 2_000_000_000_123);
    expect(cleanup[0]).toBe('commit');
    expect(cleanup.filter(event => event !== 'commit')).toEqual(expectedCleanup);
    expect(maintenanceOpens).toBe(1);
    expect(maintenanceStreams).toBe(0); maintenance.mockRestore();
    expect(f.faux.state.callCount).toBe(calls);
    expect(cleaned.hasLiveTasks).toBe(false);
    expect(cleaned.nativeSeq).toBe((await f.lease.load()).head!.seq);
    expect(cleaned.snapshot.requiredActions).toEqual([]);
    expect(cleaned.snapshot.subagents).toMatchObject([{ id: childId, status: 'closed', closed_at: 2_000_000_000 }]);
    expect(cleaned.snapshot.turns.slice(0, 2).map(binding => binding.turn.status)).toEqual(['cancelled', 'completed']);
    expect(cleaned.snapshot.turns.filter(binding => activeIds.includes(binding.turn.id)).map(binding => ({ status: binding.turn.status, error: binding.turn.error }))).toEqual(activeIds.map(() => ({ status: 'failed', error: { code: 'server_error', message: 'Pi recovery attempts were exhausted.' } })));
    expect(cleaned.snapshot.turns.filter(binding => activeIds.includes(binding.turn.id)).map(binding => binding.turn.completed_at)).toEqual(activeIds.map(() => 2_000_000_000));
    const repeated = await abortPiRecovery(await openPiStorage(f.lease), f.launch, cleaned.nativeSeq, () => 2_100_000_000_456);
    expect(repeated.snapshot).toEqual(cleaned.snapshot); expect(repeated.hasLiveTasks).toBe(false);
    const second = await f.open({ mode: 'bounded' }); expect(second.snapshot()).toEqual(cleaned.snapshot);
    await second.start(turn('turn_new'), input('fresh turn')); second.resume(); await second.finished;
    expect(second.snapshot().turns.at(-1)?.turn).toMatchObject({ id: 'turn_new', status: 'completed', error: null });
    expect(f.faux.state.callCount).toBe(calls + 1);
    expect(second.snapshot().turns.slice(0, -1)).toEqual(cleaned.snapshot.turns);
  });

  it('aborts an uncertain unsafe host effect without invoking it again', async () => {
    const f = await fixture([tool('remote_write', {}), answer('New safe Turn')]);
    const entered = deferred<void>(); let effects = 0;
    const options: Partial<PiEngineOptions> = { effectTools: [{ name: 'remote_write', kind: 'mcp', description: 'Remote write', serverLabel: 'remote', toolName: 'write', parameters: Type.Object({}) }],
      effect: async (_request, signal) => { effects++; entered.resolve(); return new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('worker stopped')), { once: true })); } };
    const first = await f.open(options); await first.start(turn(), input('write')); first.resume(); await entered.promise; await first.close();
    const result = await abortPiRecovery(await openPiStorage(f.lease), f.launch, (await f.lease.load()).head!.seq);
    expect(effects).toBe(1); expect(f.faux.state.callCount).toBe(1);
    expect(result.snapshot.turns[0]?.turn.status).toBe('failed'); expect(result.hasLiveTasks).toBe(false);
    expect(result.snapshot.turns[0]?.items).toMatchObject([{ type: 'mcp_call', name: 'write', status: 'failed' }]);
    const second = await f.open({ ...options, mode: 'bounded' }); await second.start(turn('turn_new'), input('continue')); second.resume(); await second.finished;
    expect(second.snapshot().turns[1]?.turn.status).toBe('completed'); expect(effects).toBe(1); expect(f.faux.state.callCount).toBe(2);
  });
});
