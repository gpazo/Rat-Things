import type { AgentResource, AgentsStore } from './agents-ports.js';
import type { WatchdogCandidate, WatchdogFinding, WatchdogPolicy } from '../domain/watchdog.js';
import { parseWatchdogVerdict, watchdogIdentity } from './watchdog-planning.js';
import { AgentsResourceConflictError } from '../domain/agents-api-validation.js';

export interface WatchdogCollection { candidates: WatchdogCandidate[]; findings: Array<AgentResource<WatchdogFinding>>; partial: boolean }
export interface WatchdogPorts {
  collect(now: number): Promise<WatchdogCollection>;
  judgeStart(candidate: WatchdogCandidate, sessionId: string): Promise<void>;
  judgeRead(ownerId: string, sessionId: string): Promise<{ status: 'pending' } | { status: 'failed' } | { status: 'completed'; text: string }>;
  judgeStop(ownerId: string, sessionId: string): Promise<void>;
  act(candidate: WatchdogCandidate, action: 'retry' | 'cancel', now: number): Promise<boolean>;
  report(id: string, finding: WatchdogFinding): Promise<void>;
}
export class WatchdogService {
  public constructor(private readonly options: { store: AgentsStore; ports: WatchdogPorts; policy: WatchdogPolicy; clock: { now(): number } }) {}
  public async tick(): Promise<{ candidates: number; reports: number; errors: number; partial: boolean }> {
    const { store, ports, policy } = this.options;
    const now = this.options.clock.now();
    const collected = await ports.collect(now);
    const work = new Map(collected.findings.map(resource => [`${resource.ownerId}:${resource.id}`, resource]));
    let errors = 0;
    for (const candidate of collected.candidates.slice(0, policy.maxCandidates)) {
      const id = watchdogIdentity(candidate);
      const existing = await store.get<WatchdogFinding>(candidate.ownerId, 'watchdog_findings', id);
      if (existing) { work.set(`${candidate.ownerId}:${id}`, existing); continue; }
      const resource: AgentResource<WatchdogFinding> = { ownerId: candidate.ownerId, id, collection: 'watchdog_findings', createdAt: now, revision: 1, expiresAt: now + policy.retentionSeconds, value: {
        candidate, observedAt: now, judge: { status: 'skipped' }, retry: candidate.reason === 'transient_failure' ? 'pending' : 'not_applicable', cancel: 'not_requested', reportVersion: 1, reportedVersion: 0,
      } };
      try { await store.put(resource, 0); work.set(`${candidate.ownerId}:${id}`, resource); }
      catch (error) { if (!(error instanceof AgentsResourceConflictError)) errors++; }
    }
    let judges = 0;
    let reports = 0;
    for (let resource of [...work.values()].slice(0, policy.maxCandidates * 2)) {
      try {
        let value = resource.value;
        if (value.retry === 'pending') {
          try { value = { ...value, retry: await ports.act(value.candidate, 'retry', now) ? 'submitted' : 'ineligible' }; }
          catch { errors++; }
        }
        if (value.judge.status === 'skipped' && value.candidate.reason === 'long_running' && judges < policy.maxJudgesPerTick) {
          judges++;
          const sessionId = `sess_${resource.id}_judge`;
          // Persist the stable judge identity before submission so crash recovery reuses it.
          value = { ...value, judge: { status: 'pending', sessionId, startedAt: now } };
          resource = await this.save(resource, value);
        }
        if (value.judge.status === 'pending') {
          const judge = value.judge;
          try {
            await ports.judgeStart(value.candidate, judge.sessionId);
            const result = await ports.judgeRead(resource.ownerId, judge.sessionId);
            if (result.status === 'completed') {
              const verdict = parseWatchdogVerdict(result.text);
              value = { ...value, judge: verdict ? { status: 'completed', sessionId: judge.sessionId, verdict } : { status: 'failed', sessionId: judge.sessionId }, reportVersion: value.reportVersion + 1,
                cancel: verdict?.verdict === 'looping' && verdict.confidence >= policy.loopConfidence && policy.allowCancel ? 'pending' : value.cancel };
            } else if (result.status === 'failed' || now - judge.startedAt >= policy.judgeTimeoutSeconds) {
              value = { ...value, judge: { status: 'failed', sessionId: judge.sessionId }, reportVersion: value.reportVersion + 1 };
              if (result.status === 'pending') value = { ...value, judgeCleanupPending: true };
            }
          } catch { value = { ...value, judge: { status: 'failed', sessionId: judge.sessionId }, judgeCleanupPending: true, reportVersion: value.reportVersion + 1 }; errors++; }
        }
        if (value.judgeCleanupPending && value.judge.status === 'failed' && value.judge.sessionId) {
          try { await ports.judgeStop(resource.ownerId, value.judge.sessionId); value = { ...value, judgeCleanupPending: false }; }
          catch { errors++; }
        }
        if (value.cancel === 'pending') {
          try { value = { ...value, cancel: await ports.act(value.candidate, 'cancel', now) ? 'submitted' : 'ineligible' }; }
          catch { errors++; }
        }
        if ((value.retry !== resource.value.retry || value.cancel !== resource.value.cancel) && value.reportedVersion === value.reportVersion) value = { ...value, reportVersion: value.reportVersion + 1 };
        resource = await this.save(resource, value);
        if (value.reportedVersion < value.reportVersion && (value.reportLeaseUntil ?? 0) <= now) {
          resource = await this.save(resource, { ...value, reportLeaseUntil: now + 300 });
          await ports.report(`${resource.id}_${value.reportVersion}`, value);
          await this.save(resource, { ...value, reportedVersion: value.reportVersion, reportLeaseUntil: 0 });
          reports++;
        }
      } catch { errors++; }
    }
    return { candidates: collected.candidates.length, reports, errors, partial: collected.partial };
  }
  private async save(resource: AgentResource<WatchdogFinding>, value: WatchdogFinding) {
    if (value === resource.value) return resource;
    const next = { ...resource, revision: resource.revision + 1, value };
    await this.options.store.put(next, resource.revision);
    return next;
  }
}
