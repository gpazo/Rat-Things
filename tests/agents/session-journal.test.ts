import { describe, it, expect } from 'vitest';
import { SessionRuntimeJournal } from '../../src/runner/session-runtime-journal.js';
import { SessionRuntimeStore } from '../../src/core/session-runtime-store.js';
import { initialSessionRuntime, type SessionRuntimeState } from '../../src/core/session-runtime-planning.js';
import { MemoryAgentsStore } from './fixtures.js';
import { SessionArtifactCapture } from '../../src/core/session-artifact-capture.js';
import { sessionAgent } from '../../src/core/session-planning.js';

describe('durable session journal', () => {
  it('coalesces adjacent text deltas without losing their first Item or action boundary', async () => {
    const published: SessionRuntimeState[] = [];
    const journal = new SessionRuntimeJournal({ publish: async (state) => { published.push(state); return true; }, onFailure: () => {} });
    const active: SessionRuntimeState = { ...initialSessionRuntime('session', 'agent', 'root'), turns: [{ threadId: 'root', nativeTurnId: 'native', turn: {
      id: 'turn', object: 'agent.session.turn', session_id: 'session', agent_id: 'agent', subagent_id: null,
      status: 'in_progress', created_at: 1, started_at: 1, completed_at: null, usage: null, error: null,
    }, items: [] }] };
    const text = (value: string): SessionRuntimeState => ({ ...active, turns: active.turns.map((entry) => ({ ...entry, items: [{ id: 'message', turn_id: 'turn', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: value }], phase: 'final_answer', status: 'in_progress' }] })) });
    journal.changed(text(''));
    for (let n = 1; n <= 3000; n++) journal.changed(text('x'.repeat(n)));
    const waiting = { ...text('x'.repeat(3000)), requiredActions: [{ type: 'environment_connection' as const, environment_id: 'env' }] };
    journal.changed(waiting); journal.changed(text('x'.repeat(3001)));
    await journal.flush();
    expect(published).toHaveLength(4);
    expect(published[0]).toEqual(text(''));
    expect(published[1]).toEqual(text('x'.repeat(3000)));
    expect(published[2]).toEqual(waiting);
    expect(published[3]).toEqual(text('x'.repeat(3001)));
  });

  it('fails execution explicitly when non-coalescible writes exceed the bounded queue', async () => {
    const failures: Error[] = [];
    const journal = new SessionRuntimeJournal({ maxPending: 2, publish: async () => true, onFailure: (error) => { failures.push(error); } });
    const state = initialSessionRuntime('session', 'agent', 'root');
    journal.changed(state); journal.changed(state); journal.changed(state);
    await expect(journal.flush()).rejects.toThrow('cannot keep up');
    expect(failures).toHaveLength(1);
  });

  it('retains rapid required-action transitions before a scheduled flush', async () => {
    const initial = initialSessionRuntime('session', 'agent', 'root');
    const waiting = { ...initial, requiredActions: [{ type: 'environment_connection' as const, environment_id: 'env' }] };
    const published: SessionRuntimeState[] = [];
    const journal = new SessionRuntimeJournal({ publish: async (state) => { published.push(state); return true; }, onFailure: () => {} });
    journal.changed(initial); journal.changed(waiting); journal.changed(initial);
    await journal.flush();
    expect(published.map((state) => state.requiredActions.length)).toEqual([0, 1, 0]);
  });
  it('flushes changes accepted during a slow write and rejects a superseded worker', async () => {
    const store = new SessionRuntimeStore(new MemoryAgentsStore());
    await store.claim('alice', 'session', 'first', 1);
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    const published: SessionRuntimeState[] = [];
    let failure: Error | undefined;
    const journal = new SessionRuntimeJournal({ publish: async (state) => {
      published.push(state);
      if (published.length === 1) await blocked;
      return store.publish('alice', 'session', 'first', state);
    }, onFailure: (error) => { failure = error; } });
    journal.changed(initialSessionRuntime('session', 'agent', 'root'));
    const flushing = journal.flush();
    journal.changed({ ...initialSessionRuntime('session', 'agent', 'root'), requiredActions: [{ type: 'environment_connection', environment_id: 'env' }] });
    unblock();
    await flushing;
    expect(published).toHaveLength(2);
    expect((await store.get('alice', 'session'))?.value.snapshot?.requiredActions).toHaveLength(1);
    expect(await store.get('bob', 'session')).toBeUndefined();
    await store.claim('alice', 'session', 'second', 2, await store.get('alice', 'session'));
    journal.changed(initialSessionRuntime('session', 'agent', 'stale-root'));
    await expect(journal.flush()).rejects.toThrow('authority changed');
    expect(failure).toBeInstanceOf(Error);
    expect((await store.get('alice', 'session'))?.value.snapshot?.rootThreadId).toBe('root');
  });

  it('copies output bytes before persisting a completed turn and retains that immutable snapshot', async () => {
    let contents = Buffer.from('first output');
    const writes: Buffer[] = [];
    const capture = new SessionArtifactCapture({ ownerId: 'alice',
      launch: { sessionId: 'session', turnId: 'turn', input: [], agent: sessionAgent({ model: 'fixture' }, 'agent', 1),
        environment: { type: 'openai_hosted', id: 'env', capability_directories: [], files: [], plugins: [], skills: [], network: { access: 'enabled', allowed_domains: [] }, packages: { npm: [], python: [], system: [] } } },
      files: { execute: async (_id, _secret, operation) => operation.operation === 'list' ? [{ path: '/workspace/outputs/result.txt', size_bytes: contents.length }] : { path: '/workspace/outputs/result.txt', size_bytes: contents.length, version: contents.toString(), data: contents.toString('base64') } },
      artifacts: { putBytes: async (key, bytes, contentType) => {
        writes.push(Buffer.from(bytes));
        return { bucket: 'private', key, contentType, bytes: bytes.length, sha256: 'fixture' };
      } },
    });
    const state: SessionRuntimeState = { ...initialSessionRuntime('session', 'agent', 'root'), turns: [{ threadId: 'root', nativeTurnId: 'native', items: [], turn: {
      id: 'turn', object: 'agent.session.turn', session_id: 'session', agent_id: 'agent', subagent_id: null,
      status: 'completed', created_at: 1, started_at: 1, completed_at: 2, usage: null, error: null,
    } }] };
    const saved = await capture.capture(state);
    contents = Buffer.from('later output');
    expect(await capture.capture(state)).toEqual(saved);
    expect(writes.map((bytes) => bytes.toString())).toEqual(['first output']);
    expect(saved.turns[0]?.artifacts?.[0]?.artifact).toMatchObject({ path: '/workspace/outputs/result.txt', turn_id: 'turn', size_bytes: 12 });
  });
});
