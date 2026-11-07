import { feedbackSessionId } from './session-feedback-planning.js';
import { AgentsResourceConflictError } from '../domain/agents-api-validation.js';

export type AgentsJob = { ownerId: string; id: string; type: 'filter' | 'dispatch' | 'environment' | 'snapshot' | 'integration' | 'schedule' | 'delivery' | 'webhook_batch' | 'webhook_delivery' | 'tool_cleanup' | 'preparation_cleanup' } | { ownerId: string; id: string; type: 'complete'; turnId: string };

/** Expected admission delays and rejected writes must not block the FIFO for minutes. */
export function agentsJobRetrySeconds(error: { status: number; code?: string | null }): number | undefined {
  if (error instanceof AgentsResourceConflictError) return 5;
  return error.status === 503 && ['environment_unavailable', 'service_unavailable'].includes(error.code ?? '') ? 5 : undefined;
}

/** A bounded, secret-free description for failures that must remain retryable. */
export function agentsOutboxFailure(error: unknown): { errorType: string; errorCode?: string; httpStatus?: number } {
  const source = typeof error === 'object' && error !== null ? error as Record<string, unknown> : {};
  const safeIdentifier = (value: unknown): string | undefined => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : undefined;
  const errorCode = safeIdentifier(source.code) ?? safeIdentifier(source.Code) ?? safeIdentifier(source.__type);
  const status = source.$metadata && typeof source.$metadata === 'object'
    ? (source.$metadata as Record<string, unknown>).httpStatusCode
    : source.status;
  return {
    errorType: safeIdentifier(source.name) ?? 'UnknownError',
    ...(errorCode ? { errorCode } : {}),
    ...(typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? { httpStatus: status } : {}),
  };
}

/** Index values select work; provider delivery has a separate FIFO group from session execution. */
export function agentsStreamJobs(index: Record<string, unknown>): AgentsJob[] {
  if (typeof index.ownerId !== 'string') return [];
  if (['succeeded', 'failed', 'cancelled'].includes(String(index.status)) && record(index.agentsSession) && typeof index.agentsSession.sessionId === 'string' && typeof index.agentsSession.turnId === 'string') return [{ type: 'complete', ownerId: index.ownerId, id: index.agentsSession.sessionId, turnId: index.agentsSession.turnId }];
  if (index.key !== 'root' || index.deleted || typeof index.id !== 'string') return [];
  const identity = { ownerId: index.ownerId, id: index.id };
  const feedbackSession = typeof index.collection === 'string' ? feedbackSessionId(index.collection) : undefined;
  if (feedbackSession && Number(index.revision) === 1) return [{ type: 'dispatch', ownerId: index.ownerId, id: feedbackSession }];
  if (index.collection === 'event_candidates' && Number(index.revision) === 1) return [{ ...identity, type: 'filter' }];
  if (index.collection === 'session_event_batches' && Number(index.revision) === 1) return [{ ...identity, type: 'webhook_batch' }];
  if (index.collection === 'webhook_deliveries' && Number(index.revision) === 1) return [{ ...identity, type: 'webhook_delivery' }];
  if (index.collection === 'session_preparations') return [{ ...identity, type: 'preparation_cleanup' }];
  if (index.collection === 'session_tool_attempts') return [{ ...identity, type: 'tool_cleanup' }];
  if (index.collection === 'sessions') return [{ ...identity, type: 'dispatch' }, { ...identity, type: 'delivery' }];
  if (index.collection === 'session_integrations') return [{ ...identity, type: 'integration' }, { ...identity, type: 'delivery' }];
  if (index.collection === 'session_runtime') return [{ ...identity, type: 'snapshot' }];
  if (index.collection === 'schedules') return [{ ...identity, type: 'schedule' }];
  if (index.collection === 'environments' && Number(index.revision) > 1) return [{ ...identity, type: 'environment' }];
  return [];
}
export function parseAgentsJob(value: unknown): AgentsJob {
  if (record(value) && typeof value.ownerId === 'string' && typeof value.id === 'string') {
    if (value.type === 'filter' || value.type === 'dispatch' || value.type === 'environment' || value.type === 'snapshot' || value.type === 'integration' || value.type === 'schedule' || value.type === 'delivery' || value.type === 'webhook_batch' || value.type === 'webhook_delivery' || value.type === 'tool_cleanup' || value.type === 'preparation_cleanup') return { type: value.type, ownerId: value.ownerId, id: value.id };
    if (value.type === 'complete' && typeof value.turnId === 'string') return { type: value.type, ownerId: value.ownerId, id: value.id, turnId: value.turnId };
  }
  throw new Error('Invalid Agents job');
}
export function agentsJobGroup(job: AgentsJob): string { return JSON.stringify([job.type === 'filter' || job.type === 'delivery' || job.type === 'webhook_batch' || job.type === 'webhook_delivery' || job.type === 'tool_cleanup' || job.type === 'preparation_cleanup' ? job.type : 'execution', job.ownerId, job.id]); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
