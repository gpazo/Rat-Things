import type { AgentsStore } from '../core/agents-ports.js';
import type { SessionExecution, SessionState } from '../core/session-ports.js';
import type { LocalHarness } from '../core/harness-ports.js';
import type { AgentSession } from '../domain/agents-api.js';

/** Dispatch by the persisted Session pin, never by a mutable UI selection. */
export function localExecutionRouter(store: AgentsStore, codex: LocalHarness['execution'], pi: LocalHarness['execution']): LocalHarness['execution'] {
  const selected = async (owner: string, session: AgentSession) => (await store.get<SessionState>(owner, 'sessions', session.id))?.value.runtime?.kind === 'pi' ? pi : codex;
  return {
    prepare: (...args) => (args[8] === 'pi' ? pi : codex).prepare(...args),
    initialize: async (owner, session, placement) => (await selected(owner, session)).initialize?.(owner, session, placement),
    reconcile: async (owner, session) => (await selected(owner, session)).reconcile?.(owner, session),
    start: async (owner, session, ...args) => (await selected(owner, session)).start(owner, session, ...args),
    steer: async (owner, session, ...args) => (await selected(owner, session)).steer(owner, session, ...args),
    cancel: async (owner, session, turn) => (await selected(owner, session)).cancel(owner, session, turn),
    toolResult: async (owner, session, event) => (await selected(owner, session)).toolResult(owner, session, event),
    observe: async (owner, session, turn) => (await selected(owner, session)).observe(owner, session, turn),
    items: async (owner, session, turn) => (await selected(owner, session)).items(owner, session, turn),
    traceSteps: async (owner, session, turn) => (await selected(owner, session)).traceSteps?.(owner, session, turn) ?? [],
    subagents: async (owner, session) => (await selected(owner, session)).subagents?.(owner, session) ?? [],
    environment: async (owner, session) => (await selected(owner, session)).environment?.(owner, session),
    artifacts: async (owner, session, turn) => (await selected(owner, session)).artifacts(owner, session, turn),
    artifactContent: async (owner, session, artifact) => (await selected(owner, session)).artifactContent(owner, session, artifact),
    close: async (owner, session) => (await selected(owner, session)).close?.(owner, session),
    shutdown: async () => {
      const failures: unknown[] = [];
      for (const execution of [pi, codex]) { try { await execution.shutdown(); } catch (error) { failures.push(error); } }
      if (failures.length) throw new AggregateError(failures, 'Local execution shutdown failed');
    },
  } satisfies SessionExecution & { shutdown(): Promise<void> };
}
