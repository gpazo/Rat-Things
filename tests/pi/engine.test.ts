import { afterEach, describe, expect, it, vi } from 'vitest';
import { Type, createModels, fauxAssistantMessage, fauxProvider, fauxThinking, fauxToolCall, type FauxResponseStep } from '@earendil-works/pi-ai';
import { Harness, LiveDoc, type Storage } from '@earendil-works/pi-durable';
import { MemoryAgentsStore } from '../agents/fixtures.js';
import { SessionRuntimeStore } from '../../src/core/session-runtime-store.js';
import { nativeLease } from '../../src/core/session-native-store.js';
import { sessionAgent } from '../../src/core/session-planning.js';
import { resolveRuntime } from '../../src/domain/session-runtime.js';
import type { SessionLaunch } from '../../src/domain/session-execution.js';
import type { AgentSessionInputMessageParam, Turn } from '../../src/domain/agents-api.js';
import { openPiStorage } from '../../src/runner/pi/storage.js';
import { openPiEngine, type PiEngine, type PiEngineOptions } from '../../src/runner/pi/engine.js';
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
async function fixture(responses: FauxResponseStep[], changes: Partial<SessionLaunch['agent']> = {}) {
  const faux = fauxProvider({ provider: 'amazon-bedrock', api: 'bedrock-converse-stream', models: [{ id: 'test-model', reasoning: true, input: ['text', 'image'], contextWindow: 100000, maxTokens: 10000 }], tokensPerSecond: Infinity });
  faux.setResponses(responses);
  const models = createModels(); models.setProvider(faux.provider);
  const store = new MemoryAgentsStore();
  const runtime = new SessionRuntimeStore(store);
  await runtime.claim('owner', 'session', 'run', 1);
  const lease = nativeLease(store, 'owner', 'session', 'run', 0);
  const pin = resolveRuntime({ rat_things_runtime: 'pi' }, null, [{ id: 'test-model', name: 'Test', provider: 'amazon-bedrock', api: 'bedrock-converse-stream', region: 'us-east-1', input: ['text', 'image'], contextWindow: 100000, maxTokens: 10000, reasoning: ['none', 'minimal', 'low', 'medium', 'high'] }]);
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
    expect(repaired).toEqual({ snapshot: original, nativeSeq: seq });
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
    const options: Partial<PiEngineOptions> = { effect, effectTools: [{ name: 'remote_write', description: 'Write remotely', kind: 'mcp', serverLabel: 'remote', parameters: Type.Object({ value: Type.String() }) }] };
    const first = await f.open(options); await first.start(turn(), input('write')); first.resume(); await entered.promise;
    await first.close();
    const second = await f.open({ ...options, mode: 'bounded' }); second.resume(); await second.finished;
    expect(calls).toBe(1);
    expect(text(second)).toBe('The interrupted write is uncertain');
    expect(second.snapshot().turns[0]?.items.find(item => item.type === 'mcp_call')).toMatchObject({ status: 'failed' });
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
    const engine = await f.open({ effectTools: [{ name: 'managed_read', description: 'Read', kind: 'mcp', parameters: Type.Object({}) }], effect: async () => { entered.resolve(); await release.promise; return { output: [{ type: 'text', text: 'read complete' }] }; } });
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
