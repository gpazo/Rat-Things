import type { AgentResource, AgentsStore } from './agents-ports.js';
import type { WatchdogCandidate, WatchdogFinding, WatchdogPolicy } from '../domain/watchdog.js';
import { parseWatchdogVerdict, watchdogIdentity, watchdogIncidentCandidate, watchdogLegacyIdentities } from './watchdog-planning.js';
import { AgentsResourceConflictError } from '../domain/agents-api-validation.js';

export interface WatchdogCollection { candidates: WatchdogCandidate[]; findings: Array<AgentResource<WatchdogFinding>>; partial: boolean }
export const watchdogFindingNeedsWork = (finding: WatchdogFinding, policy: WatchdogPolicy): boolean => finding.supersededBy ? Boolean(finding.judgeCleanupPending)
  : finding.candidate.reason === 'long_running' && finding.candidate.window !== undefined || finding.judge.status === 'pending' || Boolean(finding.judgeCleanupPending) || finding.retry === 'pending' || finding.reportedVersion < finding.reportVersion || finding.cancel === 'pending' || finding.judge.status === 'skipped' && finding.candidate.reason === 'long_running' && policy.maxJudgesPerTick > 0;
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
    const work = new Map<string, AgentResource<WatchdogFinding>>();
    const enqueue = (resource: AgentResource<WatchdogFinding>) => { if (watchdogFindingNeedsWork(resource.value, policy)) work.set(`${resource.ownerId}:${resource.id}`, resource); };
    const created = new Set<string>();
    let errors = 0;
    for (const finding of collected.findings) {
      try { (await this.canonicalFinding(finding)).forEach(enqueue); }
      catch (error) { if (!(error instanceof AgentsResourceConflictError)) errors++; }
    }
    for (const candidate of collected.candidates) {
      if (created.size >= policy.maxCandidates) break;
      const id = watchdogIdentity(candidate);
      let existing = await store.get<WatchdogFinding>(candidate.ownerId, 'watchdog_findings', id);
      if (!existing) {
        try {
          for (const legacyId of watchdogLegacyIdentities(candidate, now, policy)) {
            const legacy = await store.get<WatchdogFinding>(candidate.ownerId, 'watchdog_findings', legacyId);
            if (!legacy) continue;
            const migrated = await this.canonicalFinding(legacy);
            migrated.forEach(enqueue);
            existing = migrated.find(resource => resource.id === id);
            break;
          }
        } catch (error) { if (!(error instanceof AgentsResourceConflictError)) errors++; continue; }
      }
      if (existing) { enqueue(existing); continue; }
      const resource: AgentResource<WatchdogFinding> = { ownerId: candidate.ownerId, id, collection: 'watchdog_findings', createdAt: now, revision: 1, expiresAt: now + policy.retentionSeconds, value: {
        candidate: watchdogIncidentCandidate(candidate), observedAt: now, judge: { status: 'skipped' }, retry: candidate.reason === 'transient_failure' ? 'pending' : 'not_applicable', cancel: 'not_requested', reportVersion: 1, reportedVersion: 0,
      } };
      try { await store.put(resource, 0); work.set(`${candidate.ownerId}:${id}`, resource); created.add(id); }
      catch (error) { if (!(error instanceof AgentsResourceConflictError)) errors++; }
    }
    let judges = 0;
    let reports = 0;
    for (let resource of [...work.values()].sort((a, b) => Number(created.has(b.id)) - Number(created.has(a.id))).slice(0, policy.maxCandidates * 2)) {
      try {
        let value = resource.value;
        if (value.supersededBy) {
          if (value.judgeCleanupPending && value.judge.status === 'failed' && value.judge.sessionId) {
            await ports.judgeStop(resource.ownerId, value.judge.sessionId);
            await this.save(resource, { ...value, judgeCleanupPending: false });
          }
          continue;
        }
        if (value.retry === 'pending') {
          try { value = { ...value, retry: await ports.act(value.candidate, 'retry', now) ? 'submitted' : 'ineligible' }; }
          catch { errors++; }
        }
        if (value.judge.status === 'skipped' && value.candidate.reason === 'long_running' && judges < policy.maxJudgesPerTick) {
          judges++;
          resource = await this.reserveJudge(resource, value, now);
          value = resource.value;
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
          await ports.report(`${value.reportId ?? resource.id}_${value.reportVersion}`, value);
          await this.save(resource, { ...value, reportedVersion: value.reportVersion, reportLeaseUntil: 0 });
          reports++;
        }
      } catch { errors++; }
    }
    return { candidates: collected.candidates.length, reports, errors, partial: collected.partial };
  }
  private async canonicalFinding(resource: AgentResource<WatchdogFinding>): Promise<Array<AgentResource<WatchdogFinding>>> {
    const { store } = this.options;
    const id = watchdogIdentity(resource.value.candidate);
    if (id === resource.id) return [resource];
    const existing = await store.get<WatchdogFinding>(resource.ownerId, 'watchdog_findings', id);
    if (resource.value.supersededBy) return existing ? [existing, resource] : [resource];
    const canonical = existing ?? { ...resource, id, revision: 1, value: { ...resource.value, candidate: watchdogIncidentCandidate(resource.value.candidate), reportId: resource.value.reportId ?? resource.id } };
    const judge = resource.value.judge;
    const canonicalJudge = canonical.value.judge;
    const cleanup = (judge.status === 'pending' || resource.value.judgeCleanupPending) && 'sessionId' in judge && judge.sessionId !== ('sessionId' in canonicalJudge ? canonicalJudge.sessionId : undefined);
    const retired = { ...resource, revision: resource.revision + 1, value: { ...resource.value, supersededBy: id, judgeCleanupPending: Boolean(cleanup),
      ...(cleanup && judge.status === 'pending' ? { judge: { status: 'failed' as const, sessionId: judge.sessionId } } : {}),
    } };
    await store.commit([
      { resource: retired, expectedRevision: resource.revision },
      ...(!existing ? [{ resource: canonical, expectedRevision: 0 }] : []),
    ]);
    return [canonical, retired];
  }
  private reserveJudge(resource: AgentResource<WatchdogFinding>, value: WatchdogFinding, startedAt: number) {
    return this.save(resource, { ...value, judge: { status: 'pending', sessionId: `sess_${resource.id}_judge`, startedAt } });
  }
  private async save(resource: AgentResource<WatchdogFinding>, value: WatchdogFinding) {
    if (value === resource.value) return resource;
    const next = { ...resource, revision: resource.revision + 1, value };
    await this.options.store.put(next, resource.revision);
    return next;
  }
}
