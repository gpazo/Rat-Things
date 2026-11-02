import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { WatchdogService } from '../../src/core/watchdog-service.js';
import { watchdogIdentity, watchdogSessionCandidates } from '../../src/core/watchdog-planning.js';
import { savedSessionObservation } from '../../src/core/session-observation-planning.js';
import type { SessionState } from '../../src/core/session-ports.js';
import { defaultWatchdogPolicy, type WatchdogCandidate, type WatchdogFinding } from '../../src/domain/watchdog.js';
import { integrationFixture } from './integration-fixtures.js';
import { MemoryAgentsStore } from './fixtures.js';

describe('long-running watchdog incidents', () => {
  it('keeps one incident and judge across time windows, updates its verdict, and admits a later Turn independently', async () => {
    const f = await integrationFixture();
    const session = await f.sessions.create('operator', { agent_id: f.agent.id, environment: { type: 'none' }, input: 'Do the task' });
    await f.sessions.dispatch('operator', session.id);
    let now = 120;
    const policy = { ...defaultWatchdogPolicy, longRunningSeconds: 60 };
    const judgeStart = vi.fn(async (_candidate: unknown, _id: string) => {});
    const judgeRead = vi.fn(async () => ({ status: 'pending' as const } as { status: 'pending' } | { status: 'completed'; text: string }));
    const report = vi.fn(async (_id: string, _finding: WatchdogFinding) => {});
    const service = new WatchdogService({ store: f.store, policy, clock: { now: () => now }, ports: {
      collect: async () => {
        const state = (await f.store.get<SessionState>('operator', 'sessions', session.id))!.value;
        const snapshot = await f.sessions.streamSnapshot('operator', session.id);
        return { candidates: watchdogSessionCandidates('operator', state, snapshot, now, policy), findings: (await f.store.list<WatchdogFinding>('operator', 'watchdog_findings', { limit: 100 })).data, partial: false };
      }, judgeStart, judgeRead, judgeStop: async () => {}, report, act: async () => false,
    } });
    await service.tick();
    now = 180;
    await service.tick();
    expect(new Set(judgeStart.mock.calls.map(([, id]) => id)).size).toBe(1);
    expect(report).toHaveBeenCalledTimes(1);
    judgeRead.mockResolvedValue({ status: 'completed', text: JSON.stringify({ verdict: 'progressing', confidence: 0.98, evidence: ['Useful progress'] }) });
    now = 240;
    await service.tick();
    now = 300;
    await service.tick();
    expect(report.mock.calls.map(([, finding]) => finding.reportVersion)).toEqual([1, 2]);
    expect((await f.store.list('operator', 'watchdog_findings', { limit: 100 })).data).toHaveLength(1);
    const firstTurn = (await f.sessions.turns('operator', session.id)).data[0]!;
    f.observations.set(firstTurn.id, { turn: { ...firstTurn, status: 'completed', completed_at: now }, requiredActions: [] });
    await f.sessions.completeReadyTurns('operator', session.id);
    await f.sessions.events('operator', session.id, { events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: 'Next task' }] }] }] });
    await f.sessions.dispatch('operator', session.id);
    now = 360;
    await service.tick();
    expect(new Set(judgeStart.mock.calls.map(([, id]) => id)).size).toBe(2);
    expect((await f.store.list('operator', 'watchdog_findings', { limit: 100 })).data).toHaveLength(2);
  });

  it('reserves a single judge when two different-window observations race', async () => {
    const f = await integrationFixture();
    const session = await f.sessions.create('operator', { agent_id: f.agent.id, environment: { type: 'none' }, input: 'Do the task' });
    await f.sessions.dispatch('operator', session.id);
    const state = (await f.store.get<SessionState>('operator', 'sessions', session.id))!.value;
    const snapshot = savedSessionObservation(state, undefined, undefined, 120);
    snapshot.turns = (await f.sessions.streamSnapshot('operator', session.id)).turns;
    const judgeStart = vi.fn(async (_candidate: unknown, _id: string) => {});
    const report = vi.fn(async () => {});
    const policy = { ...defaultWatchdogPolicy, longRunningSeconds: 60 };
    const service = (now: number) => new WatchdogService({ store: f.store, policy, clock: { now: () => now }, ports: {
      collect: async () => ({ candidates: watchdogSessionCandidates('operator', state, snapshot, now, policy), findings: [], partial: false }),
      judgeStart, judgeRead: async () => ({ status: 'pending' }), judgeStop: async () => {}, report, act: async () => false,
    } });
    await Promise.all([service(120).tick(), service(180).tick()]);
    expect(new Set(judgeStart.mock.calls.map(([, id]) => id)).size).toBe(1);
    expect(report).toHaveBeenCalledOnce();
    expect((await f.store.list('operator', 'watchdog_findings', { limit: 100 })).data).toHaveLength(1);
  });
});

describe('legacy windowed watchdog incidents', () => {
  const candidate: WatchdogCandidate = { ownerId: 'operator', sessionId: 'session', subjectId: 'session', turnId: 'turn', reason: 'long_running', since: 1, window: 3 };
  const legacyId = (window: number) => `wd_${createHash('sha256').update(JSON.stringify(['operator', 'long_running', 'session', 'turn', window, null])).digest('hex')}`;

  async function migrationFixture(windows: number[], collected = false) {
    const store = new MemoryAgentsStore();
    const resources = windows.map(window => ({ ownerId: 'operator', id: legacyId(window), collection: 'watchdog_findings', createdAt: 100, revision: 1, expiresAt: 30000,
      value: { candidate: { ...candidate, window }, observedAt: 100, judge: { status: 'pending', sessionId: `sess_${legacyId(window)}_judge`, startedAt: 100 }, retry: 'not_applicable', cancel: 'not_requested', reportVersion: 1, reportedVersion: 1 } as WatchdogFinding,
    }));
    for (const resource of resources) await store.put(resource, 0);
    const judgeStart = vi.fn(async (_candidate: WatchdogCandidate, _id: string) => {});
    const judgeRead = vi.fn(async () => ({ status: 'pending' } as { status: 'pending' } | { status: 'completed'; text: string }));
    const judgeStop = vi.fn(async (_owner: string, _id: string) => {});
    const report = vi.fn(async (_id: string, _finding: WatchdogFinding) => {});
    const list = vi.spyOn(store, 'list');
    const service = new WatchdogService({ store, policy: { ...defaultWatchdogPolicy, longRunningSeconds: 60 }, clock: { now: () => 180 }, ports: {
      collect: async () => ({ candidates: [candidate], findings: collected ? (await Promise.all(resources.map(resource => store.get<WatchdogFinding>(resource.ownerId, resource.collection, resource.id)))).filter(resource => resource !== undefined) : [], partial: false }),
      judgeStart, judgeRead, judgeStop, report, act: async () => false,
    } });
    return { store, service, resources, judgeStart, judgeRead, judgeStop, report, list };
  }

  it.each([3, 2])('adopts the existing judge from legacy window %s without reposting and keeps its report identity for the verdict', async window => {
    const f = await migrationFixture([window]);
    await f.service.tick();
    expect(f.judgeStart.mock.calls.map(([, id]) => id)).toEqual([`sess_${legacyId(window)}_judge`]);
    expect(f.report).not.toHaveBeenCalled();
    f.judgeRead.mockResolvedValue({ status: 'completed', text: JSON.stringify({ verdict: 'progressing', confidence: 0.99, evidence: ['Progress'] }) });
    await f.service.tick();
    expect(f.report.mock.calls.map(([id]) => id)).toEqual([`${legacyId(window)}_2`]);
    expect((await f.store.get<WatchdogFinding>('operator', 'watchdog_findings', watchdogIdentity(candidate)))!.value.judge.status).toBe('completed');
    expect(f.list).not.toHaveBeenCalled();
  });

  it('migrates older collected windows and retires duplicate judges without another report', async () => {
    const f = await migrationFixture([0, 1], true);
    await f.service.tick();
    await f.service.tick();
    expect(new Set(f.judgeStart.mock.calls.map(([, id]) => id))).toEqual(new Set([`sess_${legacyId(0)}_judge`]));
    expect(f.judgeStop).toHaveBeenCalledExactlyOnceWith('operator', `sess_${legacyId(1)}_judge`);
    expect(f.report).not.toHaveBeenCalled();
    expect(f.list).not.toHaveBeenCalled();
  });

  it('uses CAS to retain one judge when two ticks adopt the same legacy finding', async () => {
    const f = await migrationFixture([2]);
    await Promise.all([f.service.tick(), f.service.tick()]);
    await f.service.tick();
    expect(new Set(f.judgeStart.mock.calls.map(([, id]) => id))).toEqual(new Set([`sess_${legacyId(2)}_judge`]));
    expect(f.report).not.toHaveBeenCalled();
    expect(f.list).not.toHaveBeenCalled();
  });

  it('adopts an already reported completed legacy finding without launching or reporting again', async () => {
    const f = await migrationFixture([2]);
    const original = f.resources[0]!;
    await f.store.put({ ...original, revision: 2, value: { ...original.value, judge: { status: 'completed', sessionId: `sess_${legacyId(2)}_judge`, verdict: { verdict: 'progressing', confidence: 0.99, evidence: [] } } } }, 1);
    await f.service.tick();
    await f.service.tick();
    expect(f.judgeStart).not.toHaveBeenCalled();
    expect(f.report).not.toHaveBeenCalled();
    expect((await f.store.get<WatchdogFinding>('operator', 'watchdog_findings', watchdogIdentity(candidate)))!.value.judge.status).toBe('completed');
    expect(f.list).not.toHaveBeenCalled();
  });
});
