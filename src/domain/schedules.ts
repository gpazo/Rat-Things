import type { SessionIntegrationTarget } from './session-integrations.js';
import { AgentsApiError, parseAgentsContract } from './agents-api-validation.js';
import { isRecord } from './validation.js';

export interface ScheduleConfiguration extends SessionIntegrationTarget {
  name: string;
  expression: string;
  timezone?: string;
  input: string;
  overlap: 'allow' | 'skip';
}
export interface Schedule extends ScheduleConfiguration {
  id: string;
  object: 'rat.schedule';
  status: 'active' | 'paused' | 'deleted';
  generation: number;
  created_at: number;
  updated_at: number;
}
export interface ScheduleState {
  schedule: Schedule;
  activeSessionId?: string;
  occurrences: Record<string, { sessionId: string; configuration: ScheduleConfiguration } | { skipped: true }>;
}
export interface ScheduleInvocation { ownerId: string; scheduleId: string; generation: number; scheduledAt: string }

export function scheduleConfiguration(raw: unknown): ScheduleConfiguration {
  if (!isRecord(raw)) invalid('Schedule configuration must be an object');
  const keys = ['name', 'expression', 'timezone', 'input', 'overlap', 'agentId', 'environment', 'vaultIds', 'destinations', 'connectionSetId'];
  if (Object.keys(raw).some((key) => !keys.includes(key))) invalid('Unknown schedule field');
  const name = text(raw.name, 'name', 128);
  const expression = text(raw.expression, 'expression', 256);
  if (!/^(?:rate|cron|at)\([^\r\n]+\)$/.test(expression)) invalid('expression must be an EventBridge rate, cron, or at expression');
  const timezone = raw.timezone === undefined ? undefined : text(raw.timezone, 'timezone', 128);
  if (timezone) { try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { invalid('timezone must be an IANA time zone'); } }
  const input = text(raw.input, 'input', 100_000);
  const overlap = raw.overlap ?? 'skip';
  if (overlap !== 'allow' && overlap !== 'skip') invalid('overlap must be allow or skip');
  const target = parseAgentsContract('SessionCreate', { agent_id: raw.agentId, environment: raw.environment, vault_ids: raw.vaultIds ?? [], input });
  if (!target.agent_id) invalid('agentId is required');
  if (raw.destinations !== undefined && (!Array.isArray(raw.destinations) || raw.destinations.some((entry) => !isRecord(entry) || !['source', 'teams', 'slack', 'none'].includes(String(entry.kind)) || Object.keys(entry).some((key) => key !== 'kind' && key !== 'route') || entry.route !== undefined && (typeof entry.route !== 'string' || entry.route.length > 512)))) invalid('Invalid destinations');
  return { name, expression, ...(timezone ? { timezone } : {}), input, overlap, agentId: target.agent_id, environment: target.environment, vaultIds: target.vault_ids ?? [],
    ...(raw.destinations !== undefined ? { destinations: structuredClone(raw.destinations) as NonNullable<ScheduleConfiguration['destinations']> } : {}),
    ...(raw.connectionSetId !== undefined ? { connectionSetId: text(raw.connectionSetId, 'connectionSetId', 256) } : {}),
  };
}
export function scheduleInvocation(raw: unknown): ScheduleInvocation {
  if (!isRecord(raw) || Object.keys(raw).some((key) => !['ownerId', 'scheduleId', 'generation', 'scheduledAt'].includes(key))) invalid('Invalid scheduled invocation');
  const ownerId = text(raw.ownerId, 'ownerId', 1024), scheduleId = text(raw.scheduleId, 'scheduleId', 256), scheduledAt = text(raw.scheduledAt, 'scheduledAt', 64);
  if (typeof raw.generation !== 'number' || !Number.isSafeInteger(raw.generation) || raw.generation < 1 || !Number.isFinite(Date.parse(scheduledAt))) invalid('Invalid schedule generation or occurrence time');
  return { ownerId, scheduleId, generation: raw.generation, scheduledAt: new Date(scheduledAt).toISOString() };
}
export function scheduleInput(configuration: ScheduleConfiguration, invocation: ScheduleInvocation): string {
  return configuration.input.replace(/\{\{(scheduled_at|schedule_id)\}\}/g, (_, field: string) => field === 'scheduled_at' ? invocation.scheduledAt : invocation.scheduleId);
}
function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > maximum) invalid(`${label} is required and must fit within ${maximum} bytes`);
  return value;
}
function invalid(message: string): never { throw new AgentsApiError(400, message, 'invalid_request'); }
