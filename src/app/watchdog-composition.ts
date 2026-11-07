import { DynamoOwnerRateLimit } from '../adapters/dynamo-owner-rate-limit.js';
import { ownerRateLimits } from './owner-rate-limits.js';
import { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import { createAwsClients } from '../adapters/aws-runtime.js';
import { WatchdogCollector } from '../adapters/watchdog-collector.js';
import { requiredEnv } from '../adapters/executors.js';
import { WatchdogService } from '../core/watchdog-service.js';
import { WatchdogReporting } from '../core/watchdog-reporting.js';
import { applyWatchdogAction } from '../core/watchdog-session-actions.js';
import { defaultWatchdogPolicy, watchdogJudgeInput, type WatchdogPolicy } from '../domain/watchdog.js';
import { getAgentsApiServices, getDeliveryService, getSessionDeliveryService } from './composition.js';
import { SessionDeliveryService } from '../delivery/session-delivery.js';
import type { SessionState } from '../core/session-ports.js';
import type { RunDestination } from '../domain/contracts.js';

export function watchdogAlarmNamesFromEnv(env: NodeJS.ProcessEnv): string[] {
  const names: unknown = JSON.parse(env.WATCHDOG_ALARM_NAMES_JSON ?? 'null');
  if (!Array.isArray(names) || names.length < 1 || names.length > 100 ||
    names.some(name => typeof name !== 'string' || !name.trim() || name.length > 255) || new Set(names).size !== names.length) throw new Error('Invalid WATCHDOG_ALARM_NAMES_JSON');
  return names;
}

export function watchdogPolicyFromEnv(env: NodeJS.ProcessEnv): WatchdogPolicy {
  const number = (key: string, fallback: number, maximum: number): number => {
    const value = env[key] === undefined ? fallback : Number(env[key]);
    if (!Number.isFinite(value) || value < 0 || value > maximum || (key !== 'WATCHDOG_LOOP_CONFIDENCE' && !Number.isInteger(value))) throw new Error(`Invalid ${key}`);
    return value;
  };
  const defaults = defaultWatchdogPolicy;
  return {
    longRunningSeconds: number('WATCHDOG_LONG_RUNNING_SECONDS', defaults.longRunningSeconds, 604800),
    recentFailureSeconds: number('WATCHDOG_RECENT_FAILURE_SECONDS', defaults.recentFailureSeconds, 604800),
    stuckSeconds: number('WATCHDOG_STUCK_SECONDS', defaults.stuckSeconds, 604800),
    retryBackoffSeconds: number('WATCHDOG_RETRY_BACKOFF_SECONDS', defaults.retryBackoffSeconds, 86400),
    maxCandidates: Math.max(1, number('WATCHDOG_MAX_CANDIDATES', defaults.maxCandidates, 100)),
    maxJudgesPerTick: number('WATCHDOG_MAX_JUDGES_PER_TICK', defaults.maxJudgesPerTick, 10),
    judgeTimeoutSeconds: number('WATCHDOG_JUDGE_TIMEOUT_SECONDS', defaults.judgeTimeoutSeconds, 86400),
    retentionSeconds: number('WATCHDOG_RETENTION_SECONDS', defaults.retentionSeconds, 31536000),
    loopConfidence: Math.max(0.9, number('WATCHDOG_LOOP_CONFIDENCE', defaults.loopConfidence, 1)), allowCancel: env.WATCHDOG_ALLOW_CANCEL === 'true',
  };
}

let service: WatchdogService | undefined;
export function getWatchdogService(): WatchdogService {
  if (service) return service;
  const clients = createAwsClients();
  const services = getAgentsApiServices();
  const policy = watchdogPolicyFromEnv(process.env);
  const rateLimit = new DynamoOwnerRateLimit(clients.dynamodb, requiredEnv('AGENTS_TABLE_NAME'), ownerRateLimits(process.env.OWNER_RATE_LIMITS_JSON));
  const collector = new WatchdogCollector({ store: services.store, dynamodb: clients.dynamodb, cloudwatch: new CloudWatchClient({ region: requiredEnv('AWS_REGION') }),
    agentsTable: requiredEnv('AGENTS_TABLE_NAME'), runsTable: requiredEnv('RUNS_TABLE_NAME'), alarmNames: watchdogAlarmNamesFromEnv(process.env), operatorOwnerId: requiredEnv('WATCHDOG_OWNER_ID'), policy });
  const destinations = JSON.parse(process.env.WATCHDOG_DESTINATIONS_JSON ?? '[]') as RunDestination[];
  const reporting = new WatchdogReporting({ store: services.store, delivery: getSessionDeliveryService(), operatorDelivery: new SessionDeliveryService(getDeliveryService()), webhooks: services.webhooks, operatorDestinations: destinations });
  service = new WatchdogService({ store: services.store, policy, clock: { now: () => Math.floor(Date.now() / 1000) }, ports: {
    collect: now => collector.collect(now),
    judgeStart: async (candidate, sessionId) => {
      await services.sessions.create(candidate.ownerId, watchdogJudgeInput(requiredEnv('WATCHDOG_MODEL'), candidate), sessionId);
      await services.sessions.dispatch(candidate.ownerId, sessionId);
    },
    judgeRead: async (ownerId, sessionId) => {
      await services.sessions.completeReadyTurns(ownerId, sessionId);
      const state = await services.store.get<SessionState>(ownerId, 'sessions', sessionId);
      const binding = state?.value.turns.at(-1);
      if (!binding || ['queued', 'in_progress', 'waiting'].includes(binding.turn.status)) return { status: 'pending' };
      if (binding.turn.status !== 'completed') return { status: 'failed' };
      const text = (binding.savedItems ?? []).filter(item => item.type === 'message' && item.role === 'assistant' && item.phase !== 'commentary').flatMap(item => item.type === 'message' ? item.content.flatMap(part => part.type === 'output_text' ? [part.text] : []) : []).join('\n');
      return { status: 'completed', text };
    },
    judgeStop: async (ownerId, sessionId) => {
      if (!await services.store.get(ownerId, 'sessions', sessionId)) return;
      await services.sessions.events(ownerId, sessionId, { events: [{ type: 'agent.session.input.cancel' }] }, `watchdog-judge-timeout:${sessionId}`);
      await services.sessions.dispatch(ownerId, sessionId);
    },
    act: async (candidate, action, now) => {
      if (candidate.sessionId) await services.sessions.completeReadyTurns(candidate.ownerId, candidate.sessionId);
      const accepted = await applyWatchdogAction(services.store, rateLimit, candidate, action, now, policy);
      if (accepted && candidate.sessionId) await services.sessions.dispatch(candidate.ownerId, candidate.sessionId);
      return accepted;
    },
    report: (id, finding) => reporting.report(id, finding),
  } });
  return service;
}
