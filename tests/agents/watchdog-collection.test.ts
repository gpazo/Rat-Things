import { describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { CloudWatchClient, DescribeAlarmsCommandInput, DescribeAlarmsCommandOutput } from '@aws-sdk/client-cloudwatch';
import { WatchdogCollector } from '../../src/adapters/watchdog-collector.js';
import { AgentService } from '../../src/core/agent-service.js';
import { WatchdogService, type WatchdogCollection } from '../../src/core/watchdog-service.js';
import type { AgentResource } from '../../src/core/agents-ports.js';
import type { SessionState } from '../../src/core/session-ports.js';
import type { AgentSession, Turn } from '../../src/domain/agents-api.js';
import { defaultWatchdogPolicy, type WatchdogCandidate, type WatchdogFinding } from '../../src/domain/watchdog.js';
import { watchdogIdentity } from '../../src/core/watchdog-planning.js';
import { MemoryAgentsStore } from './fixtures.js';

const policy = { ...defaultWatchdogPolicy, maxCandidates: 1, maxJudgesPerTick: 0, longRunningSeconds: 60 };
const quarantine = (id: string, since: number): WatchdogCandidate => ({ ownerId: 'owner', subjectId: id, reason: 'quarantined', since });
const finding = (candidate: WatchdogCandidate): WatchdogFinding => ({ candidate, observedAt: 1, judge: { status: 'skipped' }, retry: 'not_applicable', cancel: 'not_requested', reportVersion: 1, reportedVersion: 0 });

function serviceFixture(store: MemoryAgentsStore, collect: (now: number) => Promise<WatchdogCollection>) {
  let now = 100;
  const report = vi.fn(async (_id: string, _finding: WatchdogFinding) => {});
  const service = new WatchdogService({ store, policy, clock: { now: () => now }, ports: {
    collect, judgeStart: async () => {}, judgeRead: async () => ({ status: 'failed' }), judgeStop: async () => {}, act: async () => false, report,
  } });
  return { service, report, advance: () => { now += 60; } };
}

const alarmNames = ['rat-things-test-runs-dlq', 'rat-things-test-state-stream-failures', 'rat-things-test-notifier-delivery-failures', 'rat-things-test-notifier-dlq-delivery-failures'];

function collectorFixture(store: MemoryAgentsStore, scan: (input: Record<string, unknown>) => Record<string, unknown>, alarms: (input: DescribeAlarmsCommandInput) => Partial<DescribeAlarmsCommandOutput> = () => ({ MetricAlarms: [] })) {
  const send = vi.fn(async (command: { input: Record<string, unknown> }) => scan(command.input));
  const describeAlarms = vi.fn(async (command: { input: DescribeAlarmsCommandInput }) => alarms(command.input));
  const collector = new WatchdogCollector({ store, policy, dynamodb: { send } as unknown as DynamoDBDocumentClient,
    cloudwatch: { send: describeAlarms } as unknown as CloudWatchClient,
    agentsTable: 'agents', runsTable: 'runs', alarmNames, operatorOwnerId: 'operator',
  });
  return { collector, send, describeAlarms };
}

async function activeSession(store: MemoryAgentsStore, id: string): Promise<void> {
  const agent = await new AgentService({ store }).create('owner', { model: 'test' });
  const session: AgentSession = { id, object: 'agent.session', agent: { ...agent, tools: [] }, created_at: 1, last_active_at: 1, environment: { type: 'none' },
    metadata: {}, status: 'in_progress', error: null, required_actions: [], usage: null, vault_ids: [] };
  const turn: Turn = { id: `turn_${id}`, object: 'agent.session.turn', session_id: id, agent_id: agent.id, subagent_id: null,
    status: 'in_progress', created_at: 1, started_at: 1, completed_at: null, error: null, usage: null };
  const state: SessionState = { session, turns: [{ turn, input: [] }], receipts: {}, deletedArtifacts: [] };
  await store.put({ id, ownerId: 'owner', collection: 'sessions', createdAt: 1, revision: 1, value: state }, 0);
}

describe('watchdog candidate admission', () => {
  it('counts new findings rather than previously reported candidates against the admission budget', async () => {
    const store = new MemoryAgentsStore();
    const f = serviceFixture(store, async () => ({ candidates: [quarantine('old', 1), quarantine('new', 2)], findings: [], partial: false }));
    await f.service.tick();
    expect(f.report).toHaveBeenCalledTimes(1);
    await f.service.tick();
    await f.service.tick();
    expect(f.report.mock.calls.map(([, value]) => value.candidate.subjectId)).toEqual(['old', 'new']);
    expect((await store.list('owner', 'watchdog_findings', { limit: 100 })).data).toHaveLength(2);
  });

  it('processes a newly admitted finding when older pending findings fill the work budget', async () => {
    const store = new MemoryAgentsStore();
    const pending: Array<AgentResource<WatchdogFinding>> = [];
    for (const id of ['pending-a', 'pending-b']) {
      const candidate = quarantine(id, 1);
      const resource: AgentResource<WatchdogFinding> = { ownerId: 'owner', id: watchdogIdentity(candidate), collection: 'watchdog_findings', createdAt: 1,
        revision: 1, value: { ...finding(candidate), retry: 'pending', reportedVersion: 1 } };
      await store.put(resource, 0);
      pending.push(resource);
    }
    const f = serviceFixture(store, async () => ({ candidates: [quarantine('new', 2)], findings: pending, partial: false }));
    await f.service.tick();
    expect(f.report.mock.calls.map(([, value]) => value.candidate.subjectId)).toContain('new');
    expect(f.report).toHaveBeenCalledTimes(policy.maxCandidates * 2);
  });
});

describe('watchdog scan-page fairness', () => {
  it('keeps bounded scan pages until their candidate rotation finishes, then advances both scan cursors', async () => {
    const store = new MemoryAgentsStore();
    const agentsNext = { scope: 'agents-next', key: 'root' }, runsNext = { runId: 'runs-next' };
    const f = collectorFixture(store, input => {
      if (input.ExclusiveStartKey) return { Items: [] };
      if (input.TableName === 'agents') return { Items: [], LastEvaluatedKey: agentsNext };
      return { Items: ['old', 'new'].map((runId, index) => ({ runId, ownerId: 'owner', liveness: { quarantinedAt: new Date((index + 1) * 1000).toISOString() } })), LastEvaluatedKey: runsNext };
    });
    const service = serviceFixture(store, now => f.collector.collect(now));
    await service.service.tick();
    await service.service.tick();
    await service.service.tick();
    expect(service.report.mock.calls.map(([, value]) => value.candidate.subjectId)).toEqual(['old', 'new']);
    expect(f.send.mock.calls.map(([command]) => command.input.ExclusiveStartKey)).toEqual([undefined, undefined, undefined, undefined, agentsNext, runsNext]);
    for (const [command] of f.send.mock.calls) expect(command.input.Limit).toBe(policy.maxCandidates * 20);
  });

  it('rotates dense Session pages fairly when every inspection creates a new long-running window', async () => {
    const store = new MemoryAgentsStore();
    const ids = ['session-a', 'session-b', 'session-c'];
    for (const id of ids) await activeSession(store, id);
    const f = collectorFixture(store, input => ({ Items: input.TableName === 'agents' ? ids.map(id => ({ id, ownerId: 'owner', collection: 'sessions' })) : [] }));
    const service = serviceFixture(store, now => f.collector.collect(now));
    for (const _id of ids) { await service.service.tick(); service.advance(); }
    expect(service.report.mock.calls.map(([, value]) => value.candidate.sessionId)).toEqual(ids);
    expect((await store.list('owner', 'watchdog_findings', { limit: 100 })).data).toHaveLength(ids.length);
    expect(f.send).toHaveBeenCalledTimes(ids.length * 2);
  });
});

describe('watchdog deployment alarms', () => {
  it('collects exact deployment alarms without requesting wildcard listing authority', async () => {
    const f = collectorFixture(new MemoryAgentsStore(), () => ({ Items: [] }), input => {
      if (input.AlarmNamePrefix || JSON.stringify(input.AlarmNames) !== JSON.stringify(alarmNames)) throw new Error('AccessDenied');
      return { MetricAlarms: [{ AlarmName: alarmNames[0], StateUpdatedTimestamp: new Date(1_000) }, { AlarmName: 'rat-things-test-other' }] };
    });
    expect(await f.collector.collect(100)).toEqual({ candidates: [{ ownerId: 'operator', subjectId: alarmNames[0], reason: 'alarm', since: 1 }], findings: [], partial: false });
    expect(f.describeAlarms.mock.calls[0]![0].input).toEqual({ AlarmNames: alarmNames, AlarmTypes: ['MetricAlarm'], StateValue: 'ALARM', MaxRecords: 100 });
  });

  it('completes empty scans only when the alarm request succeeds', async () => {
    const f = collectorFixture(new MemoryAgentsStore(), () => ({ Items: [] }));
    expect(await f.collector.collect(100)).toEqual({ candidates: [], findings: [], partial: false });
    f.describeAlarms.mockRejectedValueOnce(new Error('AccessDenied'));
    expect(await f.collector.collect(101)).toEqual({ candidates: [], findings: [], partial: true });
  });

  it('marks an unexpectedly truncated alarm response partial', async () => {
    const f = collectorFixture(new MemoryAgentsStore(), () => ({ Items: [] }), () => ({ NextToken: 'more' }));
    expect((await f.collector.collect(100)).partial).toBe(true);
  });
});
