import { ScanCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DescribeAlarmsCommand, type CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import type { AgentsStore, AgentResource } from '../core/agents-ports.js';
import type { SessionState } from '../core/session-ports.js';
import type { SessionStreamSnapshot } from '../core/session-stream.js';
import type { WatchdogCollection } from '../core/watchdog-service.js';
import type { WatchdogCandidate, WatchdogFinding, WatchdogPolicy } from '../domain/watchdog.js';
import type { WebhookDelivery } from '../domain/session-webhooks.js';
import type { SessionIntegrationState } from '../domain/session-integrations.js';
import type { RunRecord } from '../domain/contracts.js';
import { isWatchdogJudge, watchdogSessionCandidates } from '../core/watchdog-planning.js';
import { savedSessionObservation } from '../core/session-observation-planning.js';

interface ScanCursor { agents?: Record<string, unknown>; runs?: Record<string, unknown> }
export class WatchdogCollector {
  public constructor(private readonly options: { store: AgentsStore; dynamodb: DynamoDBDocumentClient; cloudwatch: CloudWatchClient; agentsTable: string; runsTable: string; alarmPrefix: string; operatorOwnerId: string; policy: WatchdogPolicy }) {}
  public async collect(now: number): Promise<WatchdogCollection> {
    const { store, dynamodb, policy, operatorOwnerId } = this.options;
    const checkpoint = await store.get<ScanCursor>(operatorOwnerId, 'watchdog_scan', 'cursor');
    const candidates: WatchdogCandidate[] = [];
    const findings: Array<AgentResource<WatchdogFinding>> = [];
    const limit = policy.maxCandidates * 20;
    const agents = await dynamodb.send(new ScanCommand({ TableName: this.options.agentsTable, Limit: limit,
      ...(checkpoint?.value.agents ? { ExclusiveStartKey: checkpoint.value.agents } : {}),
      FilterExpression: '#key = :root AND attribute_not_exists(deleted) AND #collection IN (:sessions, :findings, :deliveries, :integrations)',
      ExpressionAttributeNames: { '#key': 'key', '#collection': 'collection' },
      ExpressionAttributeValues: { ':root': 'root', ':sessions': 'sessions', ':findings': 'watchdog_findings', ':deliveries': 'webhook_deliveries', ':integrations': 'session_integrations' },
      ProjectionExpression: 'id, ownerId, #collection, createdAt, expiresAt',
    }));
    for (const index of agents.Items ?? []) {
      if (typeof index.ownerId !== 'string' || typeof index.id !== 'string' || typeof index.collection !== 'string' || Number(index.expiresAt ?? Infinity) <= now) continue;
      const { ownerId, id, collection } = index;
      if (collection === 'watchdog_findings') {
        const finding = await store.get<WatchdogFinding>(ownerId, collection, id);
        if (finding && (finding.value.judge.status === 'pending' || finding.value.judgeCleanupPending || finding.value.retry === 'pending' || finding.value.reportedVersion < finding.value.reportVersion || finding.value.cancel === 'pending')) findings.push(finding);
      } else if (collection === 'sessions') {
        const state = await store.get<SessionState>(ownerId, collection, id);
        if (!state || isWatchdogJudge(state.value)) continue;
        const snapshot = await store.get<SessionStreamSnapshot>(ownerId, 'session_observations', id);
        candidates.push(...watchdogSessionCandidates(ownerId, state.value, snapshot?.value ?? savedSessionObservation(state.value, undefined, undefined, now), now, policy));
        const pending = Object.values(state.value.receipts).some(receipt => !receipt.dispatched && !receipt.failure);
        const since = state.value.turns.at(-1)?.turn.created_at ?? state.createdAt;
        if (pending && now - since >= policy.stuckSeconds) candidates.push({ ownerId, sessionId: id, subjectId: id, reason: 'outbox_stuck', since });
      } else if (collection === 'webhook_deliveries') {
        const delivery = await store.get<WebhookDelivery>(ownerId, collection, id);
        if (delivery && delivery.value.event.type !== 'agent.session.watchdog' && ['pending', 'delivering', 'failed'].includes(delivery.value.status) && now - delivery.createdAt >= policy.stuckSeconds) candidates.push({ ownerId, sessionId: delivery.value.event.data.id, subjectId: id, reason: 'delivery_stuck', since: delivery.createdAt });
      } else {
        const integration = await store.get<SessionIntegrationState>(ownerId, collection, id);
        const state = await store.get<SessionState>(ownerId, 'sessions', id);
        for (const input of integration?.value.inputs ?? []) {
          const turn = state?.value.turns.find(binding => binding.turn.id === input.turnId)?.turn;
          if (!input.deliveryProcessed && turn?.completed_at && now - turn.completed_at >= policy.stuckSeconds) candidates.push({ ownerId, sessionId: id, turnId: turn.id, subjectId: id, reason: 'delivery_stuck', since: turn.completed_at });
        }
      }
    }
    const runs = await dynamodb.send(new ScanCommand({ TableName: this.options.runsTable, Limit: limit,
      ...(checkpoint?.value.runs ? { ExclusiveStartKey: checkpoint.value.runs } : {}),
      FilterExpression: 'attribute_exists(liveness.quarantinedAt)', ProjectionExpression: 'runId, ownerId, agentsSession, liveness',
    }));
    for (const run of runs.Items ?? []) {
      const value = run as Pick<RunRecord, 'ownerId' | 'runId' | 'agentsSession' | 'liveness'>;
      if (value.ownerId && value.runId && value.liveness?.quarantinedAt) candidates.push({ ownerId: value.ownerId, subjectId: value.runId, reason: 'quarantined', since: Date.parse(value.liveness.quarantinedAt) / 1000,
        ...(value.agentsSession ? { sessionId: value.agentsSession.sessionId, turnId: value.agentsSession.turnId } : {}) });
    }
    let alarmFailure = false;
    try {
      const alarms = await this.options.cloudwatch.send(new DescribeAlarmsCommand({ AlarmNamePrefix: this.options.alarmPrefix, StateValue: 'ALARM', MaxRecords: 50 }));
      for (const alarm of [...alarms.MetricAlarms ?? [], ...alarms.CompositeAlarms ?? []]) if (alarm.AlarmName) candidates.push({ ownerId: operatorOwnerId, subjectId: alarm.AlarmName, reason: 'alarm', since: (alarm.StateUpdatedTimestamp?.getTime() ?? now * 1000) / 1000 });
    } catch { alarmFailure = true; }
    await store.put({ ownerId: operatorOwnerId, id: 'cursor', collection: 'watchdog_scan', createdAt: checkpoint?.createdAt ?? now, revision: (checkpoint?.revision ?? 0) + 1,
      value: { ...(agents.LastEvaluatedKey ? { agents: agents.LastEvaluatedKey } : {}), ...(runs.LastEvaluatedKey ? { runs: runs.LastEvaluatedKey } : {}) },
    }, checkpoint?.revision ?? 0);
    return { candidates: candidates.sort((a, b) => a.since - b.since).slice(0, policy.maxCandidates), findings, partial: Boolean(agents.LastEvaluatedKey || runs.LastEvaluatedKey || alarmFailure) };
  }
}
