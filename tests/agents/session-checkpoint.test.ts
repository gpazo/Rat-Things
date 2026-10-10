import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { SessionCheckpoint } from '../../src/core/session-checkpoint.js';
import { SessionRuntimeStore } from '../../src/core/session-runtime-store.js';
import { initialSessionRuntime, type SessionRuntimeState } from '../../src/core/session-runtime-planning.js';
import { checkpointRecoveryItems } from '../../src/runner/checkpoint-recovery.js';
import { idleCheckpointState } from '../../src/runner/session-checkpoints.js';
import { MemoryAgentsStore } from './fixtures.js';

const snapshot = (): SessionRuntimeState => ({ ...initialSessionRuntime('session', 'agent', 'root'), turns: [{ threadId: 'root', nativeTurnId: 'native', turn: {
  id: 'turn', object: 'agent.session.turn', session_id: 'session', agent_id: 'agent', subagent_id: null, status: 'completed', created_at: 1, started_at: 1, completed_at: 2, error: null, usage: null,
}, items: [{ id: 'answer', turn_id: 'turn', type: 'message', role: 'assistant', phase: 'final_answer', status: 'completed', content: [{ type: 'output_text', text: 'COMMITTED_FACT' }] }] }] });
const checkpoint = (state = snapshot()): SessionCheckpoint => ({ version: 1, id: randomUUID(), ownerId: 'owner', sessionId: 'session', runId: 'run', generation: 'generation', createdAt: 3, journalRevision: 3, snapshot: state, archive: { bucket: 'private', key: 'checkpoint', sha256: 'a'.repeat(64) }, archiveBytes: 10, recovery: 'history' });

describe('checkpoint publication and recovery', () => {
  it('fences stale runs/generations, retains later journal state and preserves the pointer across claims/closure', async () => {
    const store = new SessionRuntimeStore(new MemoryAgentsStore());
    await store.claim('owner', 'session', 'run', 1);
    await store.bindGeneration('owner', 'session', 'run', 'generation');
    const state = snapshot();
    expect(await store.publish('owner', 'session', 'run', state)).toBe(false);
    expect(await store.publish('owner', 'session', 'run', state, 'generation')).toBe(true);
    const saved = checkpoint(state);
    const newer = { ...state, rootThreadId: 'newer-journal' };
    await store.publish('owner', 'session', 'run', newer, 'generation');
    expect(await store.checkpoint('owner', 'session', 'run', 'old-generation', saved, undefined)).toBe(false);
    expect(await store.checkpoint('owner', 'session', 'run', 'generation', saved, undefined)).toBe(true);
    expect(await store.checkpoint('owner', 'session', 'run', 'generation', saved, undefined)).toBe(true);
    expect((await store.get('owner', 'session'))!.value).toMatchObject({ snapshot: newer, checkpoint: { snapshot: state } });
    await store.claim('owner', 'session', 'replacement', 4, await store.get('owner', 'session'));
    await store.bindGeneration('owner', 'session', 'replacement', 'replacement-generation');
    expect(await store.publish('owner', 'session', 'run', state, 'generation')).toBe(false);
    expect(await store.checkpoint('owner', 'session', 'run', 'generation', checkpoint(), saved.id)).toBe(false);
    expect((await store.get('owner', 'session'))!.value.checkpoint).toEqual(saved);
    await store.close('owner', 'session');
    expect(await store.checkpoint('owner', 'session', 'replacement', 'replacement-generation', saved, saved.id)).toBe(false);
    expect((await store.get('owner', 'session'))!.value.checkpoint).toEqual(saved);
    expect(await store.get('another-owner', 'session')).toBeUndefined();
  });

  it('does not install a pointer after concurrent source change or accept a mismatched archive owner', async () => {
    const memory = new MemoryAgentsStore(); const store = new SessionRuntimeStore(memory);
    await store.claim('owner', 'session', 'run', 1); await store.bindGeneration('owner', 'session', 'run', 'generation');
    await store.publish('owner', 'session', 'run', snapshot(), 'generation');
    expect(await store.checkpoint('owner', 'session', 'run', 'generation', { ...checkpoint(), ownerId: 'other' }, undefined)).toBe(false);
    const put = memory.put.bind(memory); let raced = false;
    memory.put = async (resource, revision) => {
      if (!raced) { raced = true; await store.close('owner', 'session'); }
      return put(resource, revision);
    };
    await expect(store.checkpoint('owner', 'session', 'run', 'generation', checkpoint(), undefined)).rejects.toMatchObject({ status: 409 });
    expect((await store.get('owner', 'session'))!.value.checkpoint).toBeUndefined();
  });

  it('retains newer same-Turn facts and marks incomplete external effects as historical', () => {
    const state = snapshot(); const saved = checkpoint(state); const later = structuredClone(state);
    later.turns[0]!.items.push({ id: 'later', turn_id: 'turn', type: 'command_execution', command: 'external_side_effect', cwd: '/workspace', duration_ms: null, exit_code: null, output: 'ALREADY_SENT', status: 'incomplete' });
    const before = structuredClone(later);
    const recovery = checkpointRecoveryItems(saved, later, []);
    const text = JSON.stringify(recovery);
    expect(text).toContain('COMMITTED_FACT'); expect(text).toContain('ALREADY_SENT');
    expect(text.indexOf('newer than the restored workspace')).toBeLessThan(text.indexOf('ALREADY_SENT'));
    expect(text).toContain('Incomplete operations may already have produced effects');
    expect(recovery.some(item => item.type === 'function_call')).toBe(false);
    expect(later).toEqual(before);
  });

  it('requires all child Turns and pending actions to be idle, including newly discovered children', () => {
    const state = snapshot(); expect(idleCheckpointState(state)).toBe(true);
    expect(idleCheckpointState({ ...state, requiredActions: [{ type: 'environment_connection', environment_id: 'environment' }] })).toBe(false);
    const child = { ...state.turns[0]!, threadId: 'child', turn: { ...state.turns[0]!.turn, id: 'child-turn', subagent_id: 'child', status: 'in_progress' as const } };
    expect(idleCheckpointState({ ...state, turns: [...state.turns, child] })).toBe(false);
    // Narrow fixture: only identity and lifecycle status participate in this predicate.
    const subagent = { id: 'child', status: 'active' } as SessionRuntimeState['subagents'][number];
    expect(idleCheckpointState({ ...state, subagents: [subagent] })).toBe(false);
    expect(idleCheckpointState({ ...state, subagents: [subagent], turns: [...state.turns, { ...child, turn: { ...child.turn, status: 'completed' } }] })).toBe(true);
  });
});
