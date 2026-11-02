import type { SourceEventFacts, SourceEventPolicy } from '../domain/event-policy.js';

export type EventClassification = 'accept' | 'candidate' | 'drop';

export function classifyEvent(event: SourceEventFacts, policy: SourceEventPolicy | undefined, subscribed: boolean): EventClassification {
  if (event.selfLoop || event.bot || policy?.mode === 'ignore') return 'drop';
  if (event.repositoryComment && !policy?.actors?.allow?.includes(event.actorId)) return 'drop';
  if (policy?.actors?.deny?.includes(event.actorId)) return 'drop';
  if (policy?.actors?.allow && !policy.actors.allow.includes(event.actorId)) return 'drop';
  if (policy?.channels && (!event.channelId || !policy.channels.includes(event.channelId))) return 'drop';
  if (subscribed || event.mentioned) return 'accept';
  return policy?.mode === 'candidate' ? 'candidate' : 'drop';
}

export interface EventFilterDecision { act: boolean; reason: string }

export function parseEventFilterDecision(value: unknown): EventFilterDecision {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid event filter decision');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2 || typeof record.act !== 'boolean' || typeof record.reason !== 'string' || record.reason.length > 512) throw new Error('Invalid event filter decision');
  return { act: record.act, reason: record.reason };
}
