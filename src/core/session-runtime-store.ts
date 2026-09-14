import type { AgentsStore, AgentResource, AgentsClock } from './agents-ports.js';
import type { SessionRuntimeState } from './session-runtime-planning.js';
import { AgentsApiError } from '../domain/agents-api-validation.js';

export type StoredSessionRuntime = { snapshot?: SessionRuntimeState } & (
  | { runId: string; closed?: false }
  | { runId: string | null; closed: true }
);

/** A single owner-scoped journal fences superseded harnesses by their immutable Run ID. */
export class SessionRuntimeStore {
  public constructor(private readonly store: AgentsStore, private readonly clock: AgentsClock = { now: () => Math.floor(Date.now() / 1000) }) {}
  public get(ownerId: string, sessionId: string) { return this.store.get<StoredSessionRuntime>(ownerId, 'session_runtime', sessionId); }
  public async claim(ownerId: string, sessionId: string, runId: string, now: number, previous?: AgentResource<StoredSessionRuntime>): Promise<void> {
    if (previous?.value.closed) throw new AgentsApiError(409, 'The session harness has been closed.', 'conflict');
    await this.store.put({ ownerId, id: sessionId, collection: 'session_runtime', revision: (previous?.revision ?? 0) + 1, createdAt: previous?.createdAt ?? now, value: { runId, ...(previous?.value.snapshot ? { snapshot: previous.value.snapshot } : {}) } }, previous?.revision ?? 0);
  }
  public async publish(ownerId: string, sessionId: string, runId: string, snapshot: SessionRuntimeState): Promise<boolean> {
    const current = await this.get(ownerId, sessionId);
    if (!current || current.value.closed || current.value.runId !== runId) return false;
    await this.store.put({ ...current, revision: current.revision + 1, value: { ...current.value, snapshot } }, current.revision);
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
