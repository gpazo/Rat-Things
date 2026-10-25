import { describe, expect, it, vi } from 'vitest';
import { SessionRuntime, type SessionCheckpointOptions } from '../../src/runner/session-runtime.js';
import { WorkspaceAdmission } from '../../src/runner/workspace-handoff.js';
import { CodexRpcError, type CodexRpcClient, type CodexRpcEvent } from '../../src/adapters/codex-rpc.js';
import type { Turn } from '../../src/domain/agents-api.js';
import type { WorkspaceCheckpoint } from '../../src/domain/workspace-checkpoint.js';

const checkpoint: WorkspaceCheckpoint = { id: 'checkpoint', source: { runId: 'source', generation: 'generation' }, sandboxId: 'sandbox', setupDigest: 'a'.repeat(64), policyDigest: 'b'.repeat(64), rootThreadId: 'root', lastRootTurnId: null, lastNativeTurnId: null, createdAt: 1, reason: 'hibernate' };

function fixture(requiredResumeThreadId?: string, initialTurnId?: string) {
  let handlers!: ConstructorParameters<typeof CodexRpcClient>[0];
  const order: string[] = [];
  const ports: SessionCheckpointOptions = {
    admission: new WorkspaceAdmission(),
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
      if (method === 'thread/loaded/list') return { data: ['root', 'child'], nextCursor: null };
      if (method === 'thread/turns/list') return { data: [], nextCursor: null };
      if (method === 'thread/checkpoint') {
        const { threadId, expectedThreadIds } = params as { threadId: string; expectedThreadIds: string[] };
        order.push('native-checkpoint'); return { threadId, threadIds: expectedThreadIds, flushed: true };
      }
      throw new Error(`Unexpected method ${method}`);
    }),
    closeCheckpoint: vi.fn(async () => { order.push('native-exit'); handlers.onClose!(); }),
    close: vi.fn(async () => { handlers.onClose!(); }),
  };
  const runtime = new SessionRuntime({ sessionId: 'session', agentId: 'agent', lifetime: 'host-managed', checkpoint: ports,
    ...(requiredResumeThreadId ? { requiredResumeThreadId } : {}),
    ...(initialTurnId ? { initialTurnId } : {}),
    request: { binary: 'unused', workspace: '/workspace', environment: {}, timeoutMs: 10_000, prompt: '', sandbox: 'read-only', persistent: true, modelProvider: 'openai', model: 'fixture', networkAccess: false },
    client: options => { handlers = options; return rpc; },
  });
  return { runtime, ports, rpc, order, disconnect: () => handlers.onClose!(), emit: (event: CodexRpcEvent) => handlers.onEvent!(event),
    request: (event: CodexRpcEvent & { requestId: string | number }) => handlers.onServerRequest!(event) };
}
const turn: Turn = { id: 'turn', session_id: 'session', agent_id: 'agent', subagent_id: null, object: 'agent.session.turn', status: 'queued', created_at: 1, started_at: null, completed_at: null, usage: null, error: null };

describe('native Session checkpoint integration', () => {
  it('keeps an empty unmaterialized thread alive instead of publishing an unresumable checkpoint', async () => {
    const f = fixture();
    try {
      await f.runtime.initialize();
      const call = f.rpc.call.getMockImplementation()!;
      f.rpc.call.mockImplementation(async (method, params) => {
        if (method === 'thread/turns/list') throw new Error('thread is not materialized yet');
        return call(method, params);
      });
      await expect(f.runtime.checkpoint()).rejects.toThrow('not materialized');
      expect(f.ports.begin).not.toHaveBeenCalled();
      expect(f.rpc.close).not.toHaveBeenCalled();
      await expect(f.ports.admission.run(async () => 'open')).resolves.toBe('open');
    } finally { await f.runtime.close(); }
  });

  it('does not mistake the gap before a replacement admits its accepted first Turn for idleness', async () => {
    const f = fixture('root', turn.id);
    try {
      await f.runtime.initialize();
      await expect(f.runtime.checkpoint()).rejects.toThrow('active turns');
      expect(f.ports.begin).not.toHaveBeenCalled();
      await f.runtime.start(turn, []);
      expect(f.rpc.call).toHaveBeenCalledWith('turn/start', expect.anything());
    } finally { await f.runtime.close(); }
  });

  it('holds Run completion until every flush and the durable commit have finished', async () => {
    const f = fixture();
    await f.runtime.initialize();
    let finished = false;
    void f.runtime.finished.then(() => { finished = true; });
    vi.mocked(f.ports.commit).mockImplementationOnce(async state => {
      expect(finished).toBe(false);
      expect(state.rootThreadId).toBe('root');
      f.order.push('commit'); return checkpoint;
    });
    await expect(f.runtime.checkpoint()).resolves.toEqual(checkpoint);
    await f.runtime.finished;
    expect(f.order).toEqual(['begin', 'native-checkpoint', 'native-exit', 'writers', 'journal', 'sync', 'commit']);
    expect(f.rpc.call.mock.calls.filter(([method]) => method === 'thread/checkpoint')).toEqual([
      ['thread/checkpoint', { threadId: 'root', expectedThreadIds: ['root', 'child'] }, 35_000],
    ]);
    expect(f.rpc.call.mock.calls.filter(([method]) => method === 'thread/turns/list').map(([, params]) => params)).toEqual([
      { threadId: 'root', limit: 1, itemsView: 'summary' }, { threadId: 'child', limit: 1, itemsView: 'summary' },
      { threadId: 'root', limit: 1, itemsView: 'summary' }, { threadId: 'child', limit: 1, itemsView: 'summary' },
    ]);
    expect(finished).toBe(true);
    expect(() => f.runtime.assertSuccessfulShutdown()).not.toThrow();
    await expect(f.ports.admission.run(async () => {})).rejects.toThrow();
  });

  it('rejects busy checkpointing before durable transition and keeps accepting work', async () => {
    const f = fixture();
    try {
      await f.runtime.initialize();
      await f.runtime.start(turn, []);
      await expect(f.runtime.checkpoint()).rejects.toThrow();
      expect(f.ports.begin).not.toHaveBeenCalled();
      expect(f.rpc.close).not.toHaveBeenCalled();
      await expect(f.ports.admission.run(async () => 'accepted')).resolves.toBe('accepted');
      expect(() => f.runtime.assertSuccessfulShutdown()).not.toThrow();
    } finally { await f.runtime.close(); }
  });

  it.each(['flush', 'exit', 'sync', 'commit'])('fails the Run and never publishes after %s failure', async failure => {
    const f = fixture();
    await f.runtime.initialize();
    const error = new Error('injected failure');
    if (failure === 'flush') {
      const call = f.rpc.call.getMockImplementation()!;
      f.rpc.call.mockImplementation(async (method, params) => method === 'thread/checkpoint' ? { threadId: (params as { threadId: string }).threadId, flushed: false } : call(method, params));
    } else if (failure === 'exit') f.rpc.closeCheckpoint.mockRejectedValueOnce(error);
    else vi.mocked(f.ports[failure === 'sync' ? 'syncStorage' : 'commit']).mockRejectedValueOnce(error);
    await expect(f.runtime.checkpoint()).rejects.toThrow();
    await f.runtime.finished;
    expect(() => f.runtime.assertSuccessfulShutdown()).toThrow();
    expect(f.ports.abort).toHaveBeenCalledOnce();
    if (failure !== 'commit') expect(f.ports.commit).not.toHaveBeenCalled();
    await expect(f.ports.admission.run(async () => {})).rejects.toThrow();
  });

  it('rejects a descendant that appeared after thread shutdown began', async () => {
    const f = fixture();
    await f.runtime.initialize();
    let lists = 0;
    const call = f.rpc.call.getMockImplementation()!;
    f.rpc.call.mockImplementation(async (method, params) => method === 'thread/loaded/list' && ++lists > 1 ? { data: ['root', 'child', 'late-child'] } : call(method, params));
    await expect(f.runtime.checkpoint()).rejects.toThrow('threads changed');
    expect(f.ports.commit).not.toHaveBeenCalled();
    expect(f.rpc.closeCheckpoint).not.toHaveBeenCalled();
  });

  it.each([{ remainingIds: ['root'] }, { remainingIds: [] }])('allows acknowledged threads to unregister while requiring their persisted histories: %j', async ({ remainingIds }) => {
    const f = fixture();
    await f.runtime.initialize();
    let acknowledged = false;
    const readsAfterShutdown: string[] = [];
    const call = f.rpc.call.getMockImplementation()!;
    f.rpc.call.mockImplementation(async (method, params) => {
      if (method === 'thread/checkpoint') acknowledged = true;
      if (method === 'thread/loaded/list' && acknowledged) return { data: remainingIds, nextCursor: null };
      if (method === 'thread/turns/list' && acknowledged) readsAfterShutdown.push((params as { threadId: string }).threadId);
      return call(method, params);
    });
    await expect(f.runtime.checkpoint()).resolves.toEqual(checkpoint);
    expect(readsAfterShutdown).toEqual(['root', 'child']);
    expect(f.ports.commit).toHaveBeenCalledOnce();
    expect(f.rpc.closeCheckpoint).toHaveBeenCalledOnce();
  });

  it('rejects missing persisted history even after every thread acknowledged shutdown', async () => {
    const f = fixture();
    await f.runtime.initialize();
    let acknowledged = false;
    const call = f.rpc.call.getMockImplementation()!;
    f.rpc.call.mockImplementation(async (method, params) => {
      if (method === 'thread/checkpoint') acknowledged = true;
      if (method === 'thread/turns/list' && acknowledged && (params as { threadId: string }).threadId === 'child') throw new Error('child history unavailable');
      return call(method, params);
    });
    await expect(f.runtime.checkpoint()).rejects.toThrow('child history unavailable');
    expect(f.ports.commit).not.toHaveBeenCalled();
    expect(f.ports.abort).toHaveBeenCalledOnce();
  });

  it('checks descendant history before starting durable handoff', async () => {
    const f = fixture();
    try {
      await f.runtime.initialize();
      const call = f.rpc.call.getMockImplementation()!;
      f.rpc.call.mockImplementation(async (method, params) => {
        if (method === 'thread/turns/list' && (params as { threadId: string }).threadId === 'child') throw new Error('child history unavailable');
        return call(method, params);
      });
      await expect(f.runtime.checkpoint()).rejects.toThrow('child history unavailable');
      expect(f.ports.begin).not.toHaveBeenCalled();
      expect(f.rpc.call.mock.calls.some(([method]) => method === 'thread/checkpoint')).toBe(false);
      expect(f.rpc.close).not.toHaveBeenCalled();
      await expect(f.ports.admission.run(async () => 'open')).resolves.toBe('open');
    } finally { await f.runtime.close(); }
  });

  it.each([
    { threadId: 'other-root', threadIds: ['root', 'child'], flushed: true },
    { threadId: 'root', threadIds: ['root'], flushed: true },
    { threadId: 'root', threadIds: ['root', 'child', 'extra'], flushed: true },
    { threadId: 'root', threadIds: ['root', 'root'], flushed: true },
    { threadId: 'root', threadIds: ['root', 1], flushed: true },
    { threadId: 'root', flushed: true },
    { threadId: 'root', threadIds: ['root', 'child'], flushed: false },
  ])('rejects an incomplete or malformed checkpoint acknowledgement: %j', async acknowledgement => {
    const f = fixture();
    await f.runtime.initialize();
    const call = f.rpc.call.getMockImplementation()!;
    f.rpc.call.mockImplementation(async (method, params) => method === 'thread/checkpoint' ? acknowledgement : call(method, params));
    await expect(f.runtime.checkpoint()).rejects.toThrow();
    expect(f.ports.abort).toHaveBeenCalledOnce();
    expect(f.ports.commit).not.toHaveBeenCalled();
    expect(f.rpc.closeCheckpoint).not.toHaveBeenCalled();
  });

  it.each([
    { data: ['root', 'root'] },
    { data: ['root', ''] },
    { data: ['root'], nextCursor: '' },
    { data: ['root'], nextCursor: 1 },
    { data: [], nextCursor: 'more' },
  ])('rejects invalid loaded-thread pagination before shutdown: %j', async page => {
    const f = fixture();
    try {
      await f.runtime.initialize();
      f.rpc.call.mockResolvedValueOnce(page);
      await expect(f.runtime.checkpoint()).rejects.toThrow();
      expect(f.ports.begin).not.toHaveBeenCalled();
      expect(f.rpc.close).not.toHaveBeenCalled();
    } finally { await f.runtime.close(); }
  });

  it.each(['duplicate identity', 'repeated cursor'])('rejects %s across loaded-thread pages', async failure => {
    const f = fixture();
    try {
      await f.runtime.initialize();
      f.rpc.call.mockResolvedValueOnce({ data: ['root'], nextCursor: 'first' });
      f.rpc.call.mockResolvedValueOnce(failure === 'duplicate identity'
        ? { data: ['root', 'child'] } : { data: ['child'], nextCursor: 'first' });
      await expect(f.runtime.checkpoint()).rejects.toThrow();
      expect(f.ports.begin).not.toHaveBeenCalled();
      expect(f.rpc.close).not.toHaveBeenCalled();
    } finally { await f.runtime.close(); }
  });

  it('accepts paginated identities and acknowledgements in a different order', async () => {
    const f = fixture();
    await f.runtime.initialize();
    const call = f.rpc.call.getMockImplementation()!;
    f.rpc.call.mockImplementation(async (method, params) => {
      if (method === 'thread/loaded/list') return (params as { cursor?: string }).cursor
        ? { data: ['child'], nextCursor: null } : { data: ['root'], nextCursor: 'root' };
      if (method === 'thread/checkpoint') return { threadId: 'root', threadIds: ['child', 'root'], flushed: true };
      return call(method, params);
    });
    await expect(f.runtime.checkpoint()).resolves.toEqual(checkpoint);
    expect(f.ports.commit).toHaveBeenCalledOnce();
  });

  it.each(['native', 'exit', 'journal'])('rejects late activity during %s even after its Turn completes', async stage => {
    const f = fixture();
    await f.runtime.initialize();
    const activity = () => {
      f.emit({ method: 'turn/started', params: { threadId: 'root', turn: { id: 'late-turn', status: 'inProgress' } } });
      f.emit({ method: 'turn/completed', params: { threadId: 'root', turn: { id: 'late-turn', status: 'completed' } } });
    };
    if (stage === 'native') {
      const call = f.rpc.call.getMockImplementation()!;
      f.rpc.call.mockImplementation(async (method, params) => { if (method === 'thread/checkpoint') activity(); return call(method, params); });
    } else if (stage === 'exit') f.rpc.closeCheckpoint.mockImplementationOnce(async () => { activity(); f.disconnect(); });
    else vi.mocked(f.ports.flushJournal).mockImplementationOnce(async () => { activity(); });
    await expect(f.runtime.checkpoint()).rejects.toThrow('activity changed');
    expect(f.ports.commit).not.toHaveBeenCalled();
    expect(f.ports.abort).toHaveBeenCalledOnce();
    expect(() => f.runtime.assertSuccessfulShutdown()).toThrow();
  });

  it('refuses native host requests during checkpoint before running a host effect', async () => {
    const f = fixture();
    await f.runtime.initialize();
    vi.mocked(f.ports.begin).mockImplementationOnce(async () => {
      await expect(f.request({ method: 'currentTime/read', params: {}, requestId: 'late' })).rejects.toThrow('during checkpoint');
    });
    await expect(f.runtime.checkpoint()).rejects.toThrow('activity changed');
    expect(f.rpc.call.mock.calls.some(([method]) => method === 'thread/checkpoint')).toBe(false);
    expect(f.ports.commit).not.toHaveBeenCalled();
  });

  it('rejects raw response activity even without a matching Turn notification', async () => {
    const f = fixture();
    await f.runtime.initialize();
    vi.mocked(f.ports.flushJournal).mockImplementationOnce(async () => {
      f.emit({ method: 'rawResponseItem/completed', params: { threadId: 'root', item: { type: 'message' } } });
    });
    await expect(f.runtime.checkpoint()).rejects.toThrow('activity changed');
    expect(f.ports.commit).not.toHaveBeenCalled();
    expect(f.ports.abort).toHaveBeenCalledOnce();
  });

  it('never substitutes a new thread when a consumed checkpoint is missing native history', async () => {
    const f = fixture('root');
    f.rpc.call.mockRejectedValueOnce(new CodexRpcError({ code: -32600, message: 'no rollout found for thread id root' }));
    try {
      await expect(f.runtime.initialize()).rejects.toThrow('protocol request');
      expect(f.rpc.call.mock.calls.map(call => call[0])).toEqual(['thread/resume']);
    } finally { await f.runtime.close(); }
  });

  it('rejects native resume that acknowledges a different thread identity', async () => {
    const f = fixture('root');
    f.rpc.call.mockResolvedValueOnce({ thread: { id: 'different-root' } });
    try { await expect(f.runtime.initialize()).rejects.toThrow('different thread'); }
    finally { await f.runtime.close(); }
  });
});
