import type { RunError, RunRecord, RunResult } from '../domain/contracts.js';
import type { ConversationRecord, ConversationSession } from '../domain/conversations.js';
import type { AgentToolCallRecord } from '../domain/interaction.js';

export type ConversationCompletionDecision =
  | { kind: 'complete'; runStatus: 'succeeded' | 'cancelled'; result: RunResult }
  | { kind: 'fail'; runStatus: 'failed' | 'cancelled'; error: RunError; interrupted: AgentToolCallRecord[] };

/** Interrupted tool calls take precedence over a saved result: their external outcome is unknown. */
export function completionDecision(run: RunRecord): ConversationCompletionDecision {
  const interrupted = (run.agentToolCalls ?? []).filter(call => call.status === 'interrupted');
  if ((run.status === 'succeeded' || run.status === 'cancelled') && run.result && interrupted.length === 0) {
    return { kind: 'complete', runStatus: run.status, result: run.result };
  }
  return {
    kind: 'fail',
    runStatus: run.status === 'cancelled' ? 'cancelled' : 'failed',
    error: run.error ?? {
      code: run.status === 'cancelled' ? 'agent_cancelled' : 'agent_failed',
      message: `conversation slice ${run.status}`,
      retryable: false,
    },
    interrupted,
  };
}

export function sessionForRun(
  run: RunRecord,
  conversation: ConversationRecord,
  now: Date,
  agentThreadId?: string,
): ConversationSession {
  const existingStart = run.execution?.startedAt ? Date.parse(run.execution.startedAt) : now.getTime();
  const sameSession = conversation.session?.id === run.execution?.id;
  return {
    backend: 'microvm' as const,
    id: run.execution?.id ?? 'unknown',
    state: 'suspended' as const,
    updatedAt: now.toISOString(),
    expiresAt: sameSession && conversation.session?.expiresAt
      ? conversation.session.expiresAt
      : new Date(existingStart + 28_800_000).toISOString(),
    ...(agentThreadId ? { agentThreadId } : {}),
  };
}
