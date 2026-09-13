import type { AgentsStore, AgentResource } from './agents-ports.js';
import type { SessionRuntimeState } from './session-runtime-planning.js';
import { AgentsApiError } from '../domain/agents-api-validation.js';

export interface StoredSessionRuntime { runId: string; closed?: boolean; snapshot?: SessionRuntimeState }

/** A single owner-scoped journal fences superseded harnesses by their immutable Run ID. */
export class SessionRuntimeStore {
  public constructor(private readonly store: AgentsStore) {}
  public get(ownerId: string, sessionId: string) { return this.store.get<StoredSessionRuntime>(ownerId, 'session_runtime', sessionId); }
  public async claim(ownerId: string, sessionId: string, runId: string, now: number, previous?: AgentResource<StoredSessionRuntime>): Promise<void> {
    await this.store.put({ ownerId, id: sessionId, collection: 'session_runtime', revision: (previous?.revision ?? 0) + 1, createdAt: previous?.createdAt ?? now, value: { runId, ...(previous?.value.snapshot ? { snapshot: previous.value.snapshot } : {}) } }, previous?.revision ?? 0);
  }
  public async publish(ownerId: string, sessionId: string, runId: string, snapshot: SessionRuntimeState): Promise<boolean> {
    const current = await this.get(ownerId, sessionId);
    if (!current || current.value.closed || current.value.runId !== runId) return false;
    await this.store.put({ ...current, revision: current.revision + 1, value: { ...current.value, snapshot } }, current.revision);
    return true;
  }
  public async close(ownerId: string, sessionId: string): Promise<void> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const current = await this.get(ownerId, sessionId);
      if (!current || current.value.closed) return;
      try { await this.store.put({ ...current, revision: current.revision + 1, value: { ...current.value, closed: true } }, current.revision); return; }
      catch (error) { if (!(error instanceof AgentsApiError) || error.status !== 409 || attempt === 9) throw error; }
    }
  }
}
