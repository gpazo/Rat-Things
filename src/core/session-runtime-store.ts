import type { SessionCheckpoint } from './session-checkpoint.js';
import type { AgentsStore, AgentResource, AgentsClock } from './agents-ports.js';
import type { SessionRuntimeState } from './session-runtime-planning.js';
import { AgentsApiError } from '../domain/agents-api-validation.js';

export type StoredSessionRuntime = { snapshot?: SessionRuntimeState; generation?: string; checkpoint?: SessionCheckpoint } & (
  | { runId: string; closed?: false }
  | { runId: string | null; closed: true }
);

/** A single owner-scoped journal fences superseded harnesses by their immutable Run ID. */
export class SessionRuntimeStore {
  public constructor(private readonly store: AgentsStore, private readonly clock: AgentsClock = { now: () => Math.floor(Date.now() / 1000) }) {}
  public get(ownerId: string, sessionId: string) { return this.store.get<StoredSessionRuntime>(ownerId, 'session_runtime', sessionId); }
  public async claim(ownerId: string, sessionId: string, runId: string, now: number, previous?: AgentResource<StoredSessionRuntime>): Promise<void> {
    if (previous?.value.closed) throw new AgentsApiError(409, 'The session harness has been closed.', 'conflict');
    await this.store.put({ ownerId, id: sessionId, collection: 'session_runtime', revision: (previous?.revision ?? 0) + 1, createdAt: previous?.createdAt ?? now, value: { runId, ...(previous?.value.snapshot ? { snapshot: previous.value.snapshot } : {}), ...(previous?.value.checkpoint ? { checkpoint: previous.value.checkpoint } : {}) } }, previous?.revision ?? 0);
  }
  public async publish(ownerId: string, sessionId: string, runId: string, snapshot: SessionRuntimeState, generation?: string): Promise<boolean> {
    const current = await this.get(ownerId, sessionId);
    if (!current || current.value.closed || current.value.runId !== runId || current.value.generation !== generation) return false;
    await this.store.put({ ...current, revision: current.revision + 1, value: { ...current.value, snapshot } }, current.revision);
    return true;
  }
  /** Claim only after the Run execution attachment was checked by the trusted worker. */
  public async bindGeneration(ownerId: string, sessionId: string, runId: string, generation: string): Promise<void> {
    const current = await this.get(ownerId, sessionId);
    if (!current || current.value.closed || current.value.runId !== runId || current.value.generation && current.value.generation !== generation) throw new AgentsApiError(409, 'Session worker authority changed.', 'conflict');
    if (current.value.generation === generation) return;
    await this.store.put({ ...current, revision: current.revision + 1, value: { ...current.value, generation } }, current.revision);
  }
  /** Immutable upload precedes this CAS; newer acknowledged journal facts are retained. */
  public async checkpoint(ownerId: string, sessionId: string, runId: string, generation: string, checkpoint: SessionCheckpoint, predecessor: string | undefined): Promise<boolean> {
    const current = await this.get(ownerId, sessionId);
    if (!current || current.value.closed || current.value.runId !== runId || current.value.generation !== generation) return false;
    if (current.value.checkpoint?.id === checkpoint.id) return true;
    if (current.value.checkpoint?.id !== predecessor || checkpoint.ownerId !== ownerId || checkpoint.sessionId !== sessionId || checkpoint.runId !== runId || checkpoint.generation !== generation || checkpoint.journalRevision > current.revision) return false;
    await this.store.put({ ...current, revision: current.revision + 1, value: { ...current.value, checkpoint } }, current.revision);
    return true;
  }
  public async close(ownerId: string, sessionId: string): Promise<AgentResource<StoredSessionRuntime>> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const current = await this.get(ownerId, sessionId);
      if (current?.value.closed) return current;
      const closed = planRuntimeClosure(ownerId, sessionId, this.clock.now(), current);
      try { await this.store.put(closed, current?.revision ?? 0); return closed; }
      catch (error) { if (!(error instanceof AgentsApiError) || error.status !== 409 || attempt === 9) throw error; }
    }
    throw new AgentsApiError(409, 'The session harness changed concurrently.', 'conflict');
  }
}

/** Retain a closure even before the first claim; stale creators must lose their CAS. */
function planRuntimeClosure(ownerId: string, sessionId: string, now: number, current?: AgentResource<StoredSessionRuntime>): AgentResource<StoredSessionRuntime> {
  return {
    ownerId, id: sessionId, collection: 'session_runtime',
    createdAt: current?.createdAt ?? now, revision: (current?.revision ?? 0) + 1,
    value: { ...current?.value, runId: current?.value.runId ?? null, closed: true },
  };
}
