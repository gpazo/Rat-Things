import { describe, expect, it, vi } from 'vitest';
import { SessionRuntime, type SessionCheckpointOptions } from '../../src/runner/session-runtime.js';
import { WorkspaceAdmission } from '../../src/runner/workspace-handoff.js';
import type { CodexRpcClient, CodexRpcEvent } from '../../src/adapters/codex-rpc.js';
import type { Turn } from '../../src/domain/agents-api.js';
import type { WorkspaceCheckpoint } from '../../src/domain/workspace-checkpoint.js';
import { nativeCheckpointEvidence } from '../../src/domain/native-checkpoint.js';

const checkpoint = { id: 'checkpoint', rootThreadId: 'root' } as WorkspaceCheckpoint;
const turn: Turn = { id: 'turn', session_id: 'session', agent_id: 'agent', subagent_id: null, object: 'agent.session.turn', status: 'queued', created_at: 1, started_at: null, completed_at: null, usage: null, error: null };
const nativeItem = { id: 'message', type: 'agentMessage', text: 'durable output', phase: 'final_answer' };
const history = (id = 'root') => ({ id, sessionId: id, parentThreadId: id === 'root' ? null : 'root', ephemeral: false, historyMode: 'paginated', turns: [{ id: id === 'root' ? 'native-turn' : 'child-turn', status: 'completed', items: [nativeItem] }] });

function fixture() {
  let handlers!: ConstructorParameters<typeof CodexRpcClient>[0];
  const order: string[] = [];
  const verify = vi.fn(async manifest => { order.push('verify'); return nativeCheckpointEvidence(manifest); });
  const ports: SessionCheckpointOptions = {
    admission: new WorkspaceAdmission(),
    prepareNativeVerification: vi.fn(async () => ({ verify, close: vi.fn(async () => {}) })),
    begin: vi.fn(async () => { order.push('begin'); }),
    stopRemainingWriters: vi.fn(async () => { order.push('writers'); }),
    flushJournal: vi.fn(async () => { order.push('journal'); }),
    syncStorage: vi.fn(async () => { order.push('sync'); }),
    commit: vi.fn(async () => { order.push('commit'); return checkpoint; }),
    abort: vi.fn(async () => { order.push('abort'); }),
  };
  const rpc = {
    initialize: vi.fn(async () => {}),
    call: vi.fn(async (method: string, params: unknown): Promise<unknown> => {
      if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'root' } };
      if (method === 'turn/start') return { turn: { id: 'native-turn' } };
      if (method === 'thread/loaded/list') return { data: ['root'], nextCursor: null };
      if (method === 'thread/read') return { thread: history((params as { threadId: string }).threadId) };
      if (method === 'config/read') return { config: {} };
      if (method === 'configRequirements/read') return { requirements: null };
      throw new Error(`Unexpected method ${method}`);
    }),
    closeCheckpoint: vi.fn(async () => { order.push('native-exit'); handlers.onClose!(); }),
    close: vi.fn(async () => { handlers.onClose!(); }),
  };
  const runtime = new SessionRuntime({ sessionId: 'session', agentId: 'agent', lifetime: 'host-managed', checkpoint: ports,
    request: { binary: 'unused', workspace: '/workspace', environment: {}, timeoutMs: 10_000, prompt: '', sandbox: 'read-only', persistent: true, modelProvider: 'openai', model: 'fixture', networkAccess: false },
    client: options => { handlers = options; return rpc; },
  });
  const emit = (event: CodexRpcEvent) => handlers.onEvent!(event);
  return { runtime, ports, rpc, order, verify, emit, complete: async () => {
    await runtime.initialize(); await runtime.start(turn, []);
    emit({ method: 'item/completed', params: { threadId: 'root', turnId: 'native-turn', item: nativeItem } });
    emit({ method: 'turn/completed', params: { threadId: 'root', turn: { id: 'native-turn', status: 'completed' } } });
  } };
}

describe('stock native Session checkpoint', () => {
  it('publishes only after EOF, stopped writers, journal, sync and cold verification', async () => {
    const f = fixture(); await f.complete();
    let finished = false; void f.runtime.finished.then(() => { finished = true; });
    vi.mocked(f.ports.commit).mockImplementationOnce(async (_state, evidence) => {
      expect(finished).toBe(false); expect(evidence).toMatchObject({ kind: 'codex-cold-native', threadIds: ['root'] });
      f.order.push('commit'); return checkpoint;
    });
    await expect(f.runtime.checkpoint()).resolves.toEqual(checkpoint);
    await f.runtime.finished;
    expect(f.order).toEqual(['begin', 'native-exit', 'writers', 'journal', 'sync', 'verify', 'commit']);
    expect(f.rpc.call.mock.calls.some(([method]) => method === 'thread/checkpoint')).toBe(false);
    expect(() => f.runtime.assertSuccessfulShutdown()).not.toThrow();
  });

  it.each(['empty', 'busy', 'stale-items', 'missing-turn', 'missing-root', 'unknown-child', 'duplicate-loaded', 'unavailable-host', 'unsafe-config'])('rejects %s before destructive shutdown and reopens admission', async failure => {
    const f = fixture();
    if (failure === 'empty') await f.runtime.initialize(); else await f.complete();
    const call = f.rpc.call.getMockImplementation()!;
    f.rpc.call.mockImplementation(async (method, params) => {
      if (method === 'thread/read' && failure === 'stale-items') return { thread: { ...history(), turns: [{ id: 'native-turn', status: 'completed', items: [] }] } };
      if (method === 'thread/read' && failure === 'missing-turn') return { thread: { ...history(), turns: [] } };
      if (method === 'thread/loaded/list' && failure === 'missing-root') return { data: [] };
      if (method === 'thread/loaded/list' && failure === 'unknown-child') return { data: ['root', 'unknown'] };
      if (method === 'thread/loaded/list' && failure === 'duplicate-loaded') return { data: ['root', 'root'] };
      if (method === 'config/read' && failure === 'unsafe-config') return { config: { hooks: { onStart: ['shell'] } } };
      return call(method, params);
    });
    if (failure === 'unavailable-host') delete f.ports.prepareNativeVerification;
    if (failure === 'busy') f.emit({ method: 'turn/started', params: { threadId: 'root', turn: { id: 'active', status: 'inProgress' } } });
    await expect(f.runtime.checkpoint()).rejects.toThrow();
    expect(f.ports.begin).not.toHaveBeenCalled(); expect(f.rpc.closeCheckpoint).not.toHaveBeenCalled();
    await expect(f.ports.admission.run(async () => 'open')).resolves.toBe('open');
    await f.runtime.close();
  });

  it.each(['exit', 'writers', 'journal', 'sync', 'verify', 'commit'])('retains source authority and fails the run after %s failure', async failure => {
    const f = fixture(); await f.complete();
    const error = new Error('injected');
    if (failure === 'exit') f.rpc.closeCheckpoint.mockRejectedValueOnce(error);
    else if (failure === 'verify') f.verify.mockRejectedValueOnce(error);
    else vi.mocked(f.ports[{ writers: 'stopRemainingWriters', journal: 'flushJournal', sync: 'syncStorage', commit: 'commit' }[failure] as 'commit']).mockRejectedValueOnce(error);
    await expect(f.runtime.checkpoint()).rejects.toThrow('injected');
    await f.runtime.finished;
    expect(f.ports.abort).toHaveBeenCalledOnce(); expect(() => f.runtime.assertSuccessfulShutdown()).toThrow();
    if (failure !== 'commit') expect(f.ports.commit).not.toHaveBeenCalled();
    await expect(f.ports.admission.run(async () => {})).rejects.toThrow();
  });

  it('includes a known unloaded child in the exact manifest', async () => {
    const f = fixture(); await f.complete();
    f.emit({ method: 'thread/started', params: { thread: { id: 'child', source: { subAgent: { thread_spawn: { parent_thread_id: 'root' } } } } } });
    f.emit({ method: 'turn/completed', params: { threadId: 'child', turn: { id: 'child-turn', status: 'completed' } } });
    await f.runtime.checkpoint();
    expect(f.verify).toHaveBeenCalledWith(expect.objectContaining({ threads: [expect.objectContaining({ id: 'root' }), expect.objectContaining({ id: 'child' })] }));
  });

  it.each(['turn/started', 'item/completed', 'error'])('rejects late %s during EOF before any publication', async method => {
    const f = fixture(); await f.complete();
    f.rpc.closeCheckpoint.mockImplementationOnce(async () => { f.emit({ method, params: {} }); });
    await expect(f.runtime.checkpoint()).rejects.toThrow('activity changed');
    expect(f.ports.commit).not.toHaveBeenCalled(); expect(f.verify).not.toHaveBeenCalled();
  });

  it.each([{ data: ['root'], nextCursor: 'repeat' }, { data: [], nextCursor: 'bad' }, { data: [42] }, { data: ['root'], nextCursor: 12 }])('rejects malformed or repeated loaded pagination %j', async page => {
    const f = fixture(); await f.complete(); const call = f.rpc.call.getMockImplementation()!;
    f.rpc.call.mockImplementation(async (method, params) => method === 'thread/loaded/list' ? page : call(method, params));
    await expect(f.runtime.checkpoint()).rejects.toThrow(); expect(f.ports.begin).not.toHaveBeenCalled(); await f.runtime.close();
  });
});
