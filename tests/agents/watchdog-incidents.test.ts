import { describe, expect, it, vi } from 'vitest';
import { WatchdogService } from '../../src/core/watchdog-service.js';
import { watchdogSessionCandidates } from '../../src/core/watchdog-planning.js';
import { savedSessionObservation } from '../../src/core/session-observation-planning.js';
import type { SessionState } from '../../src/core/session-ports.js';
import { defaultWatchdogPolicy, type WatchdogFinding } from '../../src/domain/watchdog.js';
import { integrationFixture } from './integration-fixtures.js';

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
