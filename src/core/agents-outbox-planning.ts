export type AgentsJob = { ownerId: string; id: string; type: 'dispatch' | 'environment' | 'snapshot' | 'integration' | 'schedule' | 'delivery' | 'webhook_batch' | 'webhook_delivery' } | { ownerId: string; id: string; type: 'complete'; turnId: string };

/** Cold workers and disconnected environments are expected admission delays. */
export function agentsJobRetrySeconds(error: { status: number; code?: string | null }): number | undefined {
  return error.status === 503 && ['environment_unavailable', 'service_unavailable'].includes(error.code ?? '') ? 5 : undefined;
}

/** Index values select work; provider delivery has a separate FIFO group from session execution. */
export function agentsStreamJobs(index: Record<string, unknown>): AgentsJob[] {
  if (typeof index.ownerId !== 'string') return [];
  if (['succeeded', 'failed', 'cancelled'].includes(String(index.status)) && record(index.agentsSession) && typeof index.agentsSession.sessionId === 'string' && typeof index.agentsSession.turnId === 'string') return [{ type: 'complete', ownerId: index.ownerId, id: index.agentsSession.sessionId, turnId: index.agentsSession.turnId }];
  if (index.key !== 'root' || index.deleted || typeof index.id !== 'string') return [];
  const identity = { ownerId: index.ownerId, id: index.id };
  if (index.collection === 'session_event_batches' && Number(index.revision) === 1) return [{ ...identity, type: 'webhook_batch' }];
  if (index.collection === 'webhook_deliveries' && Number(index.revision) === 1) return [{ ...identity, type: 'webhook_delivery' }];
  if (index.collection === 'sessions') return [{ ...identity, type: 'dispatch' }, { ...identity, type: 'delivery' }];
  if (index.collection === 'session_integrations') return [{ ...identity, type: 'integration' }, { ...identity, type: 'delivery' }];
  if (index.collection === 'session_runtime') return [{ ...identity, type: 'snapshot' }];
  if (index.collection === 'schedules') return [{ ...identity, type: 'schedule' }];
  if (index.collection === 'environments' && Number(index.revision) > 1) return [{ ...identity, type: 'environment' }];
  return [];
}
export function parseAgentsJob(value: unknown): AgentsJob {
  if (record(value) && typeof value.ownerId === 'string' && typeof value.id === 'string') {
    if (value.type === 'dispatch' || value.type === 'environment' || value.type === 'snapshot' || value.type === 'integration' || value.type === 'schedule' || value.type === 'delivery' || value.type === 'webhook_batch' || value.type === 'webhook_delivery') return { type: value.type, ownerId: value.ownerId, id: value.id };
    if (value.type === 'complete' && typeof value.turnId === 'string') return { type: value.type, ownerId: value.ownerId, id: value.id, turnId: value.turnId };
  }
  throw new Error('Invalid Agents job');
}
export function agentsJobGroup(job: AgentsJob): string { return JSON.stringify([job.type === 'delivery' || job.type === 'webhook_batch' || job.type === 'webhook_delivery' ? job.type : 'execution', job.ownerId, job.id]); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
