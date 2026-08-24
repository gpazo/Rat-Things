import type { RunQueueMessage, RunRecord } from '../domain/contracts.js';
import type { ConversationWakeMessage } from '../domain/conversations.js';

export type RunRecoveryWake =
  | { kind: 'run'; message: RunQueueMessage }
  | { kind: 'thread'; message: ConversationWakeMessage };

/**
 * Chooses the coordinator that can safely advance a stale queued Run.
 * Threaded Runs must first receive trusted continuation state; all other Runs
 * can go directly to execution dispatch.
 */
export function recoveryWakeForQueuedRun(run: RunRecord, now = Date.now()): RunRecoveryWake {
  const traceId = `reconcile:${run.runId}:${now}`;
  if (run.conversation && !run.executionInput) {
    return {
      kind: 'thread',
      message: {
        version: '1',
        conversationId: run.conversation.conversationId,
        traceId,
        runId: run.runId,
        ownerId: run.ownerId,
      },
    };
  }
  return {
    kind: 'run',
    message: { version: '1', runId: run.runId, traceId },
  };
}
