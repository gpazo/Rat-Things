import type { AgentsStore } from './agents-ports.js';
import type { SessionState } from './session-ports.js';
import { AgentsApiError } from '../domain/agents-api-validation.js';

export function requireSessionExecution(state: SessionState): void {
  if (state.share && state.share.phase !== 'quiescing') throw new AgentsApiError(409, 'This Session is moving to its shared space.', 'session_shared');
}
export async function requireLocalExecution(store: AgentsStore, owner: string, id: string): Promise<void> {
  const state = await store.get<SessionState>(owner, 'sessions', id);
  if (state) requireSessionExecution(state.value);
}
