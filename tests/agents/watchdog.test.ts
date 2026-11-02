import { parseAgentsContract } from '../../src/domain/agents-api-validation.js';
import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionItem, Turn } from '../../src/domain/agents-api.js';
import { defaultWatchdogPolicy, watchdogJudgeInput, type WatchdogCandidate, type WatchdogFinding } from '../../src/domain/watchdog.js';
import { watchdogDigest, parseWatchdogVerdict, watchdogRetryEligible, watchdogSessionCandidates } from '../../src/core/watchdog-planning.js';
import { WatchdogService, type WatchdogPorts } from '../../src/core/watchdog-service.js';
import { WatchdogReporting } from '../../src/core/watchdog-reporting.js';
import { OwnerRateLimiter } from '../../src/core/owner-rate-limiter.js';
import type { AgentsStore } from '../../src/core/agents-ports.js';
import { applyWatchdogAction } from '../../src/core/watchdog-session-actions.js';
import { savedSessionObservation } from '../../src/core/session-observation-planning.js';
import { SessionEventStore } from '../../src/core/session-event-store.js';
import { SessionRuntimeStore } from '../../src/core/session-runtime-store.js';
import { initialSessionRuntime } from '../../src/core/session-runtime-planning.js';
import type { SessionStreamSnapshot } from '../../src/core/session-stream.js';
import type { SessionState } from '../../src/core/session-ports.js';
import { WebhookService } from '../../src/core/webhook-service.js';
import { MemoryAgentsStore } from './fixtures.js';
import { integrationFixture } from './integration-fixtures.js';

const call = (id: string, argument: string): AgentSessionItem => ({ id, type: 'function_call', name: 'lookup', arguments: argument, call_id: id, turn_id: 'turn', status: 'completed' });
const candidate: WatchdogCandidate = { ownerId: 'operator', sessionId: 'session', turnId: 'turn', subjectId: 'session', reason: 'long_running', since: 1 };
const policy = defaultWatchdogPolicy;
const admission = (store: AgentsStore, maximum = 60) => new OwnerRateLimiter(store, () => maximum, { now: () => 1000 });

async function failedSession(code: NonNullable<Turn['error']>['code'] = 'server_overloaded') {
  const f = await integrationFixture();
  const session = await f.sessions.create('operator', { agent_id: f.agent.id, environment: { type: 'none' }, input: 'Do the task' });
  await f.sessions.dispatch('operator', session.id);
  const turn = (await f.sessions.turns('operator', session.id)).data[0]!;
  f.observations.set(turn.id, { turn: { ...turn, status: 'failed', completed_at: 100, error: { code, message: 'Failure' } }, requiredActions: [] });
  await f.sessions.completeReadyTurns('operator', session.id);
  return { ...f, session, turn, candidate: { ...candidate, sessionId: session.id, subjectId: session.id, turnId: turn.id, reason: 'transient_failure' as const } };
}

function watchdogFixture() {
  const store = new MemoryAgentsStore();
  let now = 4000;
  const ports: WatchdogPorts = {
    collect: vi.fn(async () => ({ candidates: [candidate], findings: (await store.list<WatchdogFinding>('operator', 'watchdog_findings', { limit: 100 })).data, partial: false })),
    judgeStart: vi.fn(async () => {}), judgeRead: vi.fn(async () => ({ status: 'pending' as const })), judgeStop: vi.fn(async () => {}),
    act: vi.fn(async () => true), report: vi.fn(async () => {}),
  };
  const service = new WatchdogService({ store, ports, policy, clock: { now: () => now } });
  return { store, ports, service, advance: (seconds: number) => { now += seconds; } };
}

describe('watchdog policy and bounded evidence', () => {
  it('creates an ordinary Session with no environment or tools and a fixed output schema', () => {
    const input = parseAgentsContract('SessionCreate', watchdogJudgeInput('test', candidate));
    expect(input).toMatchObject({ environment: { type: 'none' }, agent: { tools: [], multi_agent: { enabled: false }, text: { format: { type: 'json_schema' } } } });
    expect(input.vault_ids).toBeUndefined();
  });
  it('distinguishes repeated identical calls from progress without retaining tool arguments or outputs', () => {
    const looping = Array.from({ length: 8 }, (_, index) => call(`call_${index}`, 'secret argument'));
    const progressing = looping.map((item, index) => call(item.id ?? String(index), `page ${index}`));
    expect(watchdogDigest(looping).repeatedIdenticalCalls).toBe(8);
    expect(watchdogDigest(progressing).repeatedIdenticalCalls).toBe(1);
    const digest = watchdogDigest([...looping, { id: 'output', type: 'function_call_output', call_id: 'call', turn_id: 'turn', status: 'completed', error: null, output: 'secret tool output' },
      { id: 'msg', turn_id: 'turn', type: 'message', role: 'assistant', phase: 'commentary', status: 'completed', content: [{ type: 'output_text', text: `token=secret-value https://user:pass@example.org/path ${'a'.repeat(1000)}` }] }]);
    expect(digest.lastAssistantText.length).toBeLessThanOrEqual(600);
    expect(JSON.stringify(digest)).not.toContain('secret');
    expect(JSON.stringify(digest)).not.toContain('user:pass');
    expect(digest.toolCalls).toBe(8);
    expect(watchdogDigest(Array.from({ length: 200 }, (_, i) => call(`${i}`, 'x'))).sampledItems).toBe(100);
  });
  it('rejects malformed, oversized, and action-bearing judge outputs', () => {
    expect(parseWatchdogVerdict('{"verdict":"looping","confidence":0.95,"evidence":["Repeated calls"]}')).toMatchObject({ verdict: 'looping' });
    for (const text of ['{}', '{"verdict":"looping","confidence":2,"evidence":[]}', '{"verdict":"looping","confidence":1,"evidence":[],"action":"cancel"}', 'a'.repeat(5000)]) expect(parseWatchdogVerdict(text)).toBeUndefined();
  });
  it.each(['authentication_error', 'cyber_policy', 'session_budget_exceeded', 'credit_balance_exhausted', 'usage_limit_exceeded'] as const)('never retries %s', async code => {
    const f = await failedSession(code);
    expect(await applyWatchdogAction(f.store, admission(f.store, 1), f.candidate, 'retry', 1000, policy)).toBe(false);
  });
  it('retries a transient Turn once through normal dispatch and does not retry its failed retry', async () => {
    const f = await failedSession();
    expect(await applyWatchdogAction(f.store, admission(f.store, 1), f.candidate, 'retry', 1000, policy)).toBe(true);
    expect(await applyWatchdogAction(f.store, admission(f.store, 1), f.candidate, 'retry', 1000, policy)).toBe(true);
    expect((await f.store.get<{ requests: number }>('operator', 'rate_limits', 'current'))?.value.requests).toBe(1);
    await f.sessions.dispatch('operator', f.session.id);
    expect(f.execution.start).toHaveBeenCalledTimes(2);
    let state = (await f.store.get<SessionState>('operator', 'sessions', f.session.id))!;
    expect(state.value.turns).toHaveLength(2);
    const retried = state.value.turns.at(-1)!;
    expect(retried.input.map(input => input.content)).toEqual(state.value.turns[0]!.input.map(input => input.content));
    f.observations.set(retried.turn.id, { turn: { ...retried.turn, status: 'failed', completed_at: 1001, error: { code: 'server_overloaded', message: 'Failure' } }, requiredActions: [] });
    await f.sessions.completeReadyTurns('operator', f.session.id);
    state = (await f.store.get<SessionState>('operator', 'sessions', f.session.id))!;
    expect(watchdogRetryEligible(state.value, state.value.turns.at(-1), 2000, policy)).toBe(false);
  });
  it.each([0, 1])('does not retry when the owner limit of %s is exhausted', async maximum => {
    const f = await failedSession();
    const limiter = admission(f.store, maximum);
    if (maximum) await limiter.admit('operator', 'another-request');
    const before = await f.store.get<SessionState>('operator', 'sessions', f.session.id);
    await expect(applyWatchdogAction(f.store, limiter, f.candidate, 'retry', 1000, policy)).rejects.toMatchObject({ code: 'owner_rate_limit_exceeded', status: 429 });
    expect(await f.store.get('operator', 'sessions', f.session.id)).toEqual(before);
    await f.sessions.dispatch('operator', f.session.id);
    expect(f.execution.start).toHaveBeenCalledTimes(1);
  });
  it('keeps a rate-limited retry pending until the next admission window', async () => {
    const f = await failedSession();
    let now = 1000;
    const limiter = new OwnerRateLimiter(f.store, () => 1, { now: () => now });
    await limiter.admit('operator', 'another-request');
    const report = vi.fn(async () => {});
    const service = new WatchdogService({ store: f.store, policy, clock: { now: () => now }, ports: {
      collect: async () => ({ candidates: [f.candidate], findings: (await f.store.list<WatchdogFinding>('operator', 'watchdog_findings', { limit: 100 })).data, partial: false }),
      judgeStart: async () => {}, judgeRead: async () => ({ status: 'pending' }), judgeStop: async () => {}, report,
      act: (candidate, action, at) => applyWatchdogAction(f.store, limiter, candidate, action, at, policy),
    } });
    expect((await service.tick()).errors).toBe(1);
    expect((await f.store.list<WatchdogFinding>('operator', 'watchdog_findings', { limit: 100 })).data[0]?.value.retry).toBe('pending');
    expect(report).toHaveBeenCalledOnce();
    now = 1060;
    expect((await service.tick()).errors).toBe(0);
    expect((await f.store.list<WatchdogFinding>('operator', 'watchdog_findings', { limit: 100 })).data[0]?.value.retry).toBe('submitted');
    await f.sessions.dispatch('operator', f.session.id);
    expect(f.execution.start).toHaveBeenCalledTimes(2);
    expect((await f.store.get<{ requests: number }>('operator', 'rate_limits', 'current'))?.value.requests).toBe(1);
  });
  it('requires backoff, complete saved Items, and no tool call before retry', async () => {
    const f = await failedSession();
    const state = (await f.store.get<SessionState>('operator', 'sessions', f.session.id))!.value;
    const binding = state.turns[0]!;
    expect(watchdogRetryEligible(state, binding, 101, policy)).toBe(false);
    expect(watchdogRetryEligible(state, { ...binding, savedItems: [call('call', 'x')] }, 1000, policy)).toBe(false);
    const { savedItems: _items, ...unknownItems } = binding;
    expect(watchdogRetryEligible(state, unknownItems, 1000, policy)).toBe(false);
    const snapshot = savedSessionObservation(state, undefined, undefined, 101);
    expect(watchdogSessionCandidates('operator', state, snapshot, 101, policy)).toEqual([]);
  });
});

describe('independent watchdog effects', () => {
  it('reports deterministic evidence when the judge fails and retains owner-scoped findings with TTL', async () => {
    const f = watchdogFixture();
    vi.mocked(f.ports.judgeStart).mockRejectedValue(new Error('provider down'));
    expect(await f.service.tick()).toMatchObject({ reports: 1, errors: 1 });
    expect(f.ports.report).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ judge: expect.objectContaining({ status: 'failed' }) }));
    const finding = (await f.store.list<WatchdogFinding>('operator', 'watchdog_findings', {})).data[0]!;
    expect(finding.expiresAt).toBe(4000 + policy.retentionSeconds);
    expect(await f.store.get('another-owner', 'watchdog_findings', finding.id)).toBeUndefined();
    await f.service.tick();
    expect(f.ports.report).toHaveBeenCalledTimes(1);
  });
  it.each(['looping', 'progressing'] as const)('reports %s verdicts without cancelling under the default policy', async verdict => {
    const f = watchdogFixture();
    await f.service.tick();
    vi.mocked(f.ports.judgeRead).mockResolvedValue({ status: 'completed', text: JSON.stringify({ verdict, confidence: 0.99, evidence: ['bounded evidence'] }) });
    await f.service.tick();
    expect(f.ports.report).toHaveBeenCalledTimes(2);
    expect(f.ports.report).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ judge: expect.objectContaining({ status: 'completed', verdict: expect.objectContaining({ verdict }) }) }));
    expect(f.ports.act).not.toHaveBeenCalled();
  });
  it('cancels an overdue judge and still reports its failure', async () => {
    const f = watchdogFixture();
    await f.service.tick(); f.advance(policy.judgeTimeoutSeconds + 1);
    await f.service.tick();
    expect(f.ports.judgeStop).toHaveBeenCalledOnce();
    expect(f.ports.report).toHaveBeenCalledTimes(2);
  });
  it('delivers signed Session webhooks directly when no shared outbox runs', async () => {
    const store = new MemoryAgentsStore();
    const transport = { post: vi.fn(async (_url: string, _body: string, _headers: Record<string, string>) => 204) };
    const secrets = { create: vi.fn(async () => 'secret-ref'), read: vi.fn(async () => 'whsec_c2VjcmV0'), revoke: vi.fn(async () => {}) };
    const webhooks = new WebhookService({ store, secrets, transport, clock: { now: () => 4000 } });
    await webhooks.create('operator', { url: 'https://example.com/webhook', events: ['agent.session.watchdog'] });
    const delivery = { deliver: vi.fn(async () => {}) };
    const reporting = new WatchdogReporting({ store, webhooks, delivery, operatorDestinations: [] });
    const finding: WatchdogFinding = { candidate, observedAt: 4000, judge: { status: 'failed' }, retry: 'not_applicable', cancel: 'not_requested', reportVersion: 1, reportedVersion: 0 };
    await reporting.report('finding_1', finding);
    await reporting.report('finding_1', finding);
    expect(transport.post).toHaveBeenCalledTimes(1);
    expect(JSON.parse(transport.post.mock.calls[0]![1]!)).toMatchObject({ type: 'agent.session.watchdog', data: { id: 'session', watchdog: { finding_id: 'finding_1' } } });
    expect(transport.post.mock.calls[0]![2]).toHaveProperty('webhook-signature');
  });
});

describe('watchdog concurrency', () => {
  it('uses one new Turn when two retry invocations race', async () => {
    const f = await failedSession();
    const results = await Promise.allSettled([applyWatchdogAction(f.store, admission(f.store, 1), f.candidate, 'retry', 1000, policy), applyWatchdogAction(f.store, admission(f.store, 1), f.candidate, 'retry', 1000, policy)]);
    expect(results.filter(result => result.status === 'fulfilled' && result.value)).toHaveLength(1);
    const state = (await f.store.get<SessionState>('operator', 'sessions', f.session.id))!.value;
    expect(state.turns).toHaveLength(2);
    expect(await applyWatchdogAction(f.store, admission(f.store, 1), f.candidate, 'retry', 1000, policy)).toBe(true);
    expect((await f.store.get<{ requests: number }>('operator', 'rate_limits', 'current'))?.value.requests).toBe(1);
    await f.sessions.dispatch('operator', f.session.id);
    expect(f.execution.start).toHaveBeenCalledTimes(2);
  });
  it('leases a pending report before delivery when two scheduled ticks race', async () => {
    const f = watchdogFixture();
    vi.mocked(f.ports.judgeStart).mockRejectedValue(new Error('judge unavailable'));
    vi.mocked(f.ports.report).mockRejectedValueOnce(new Error('destination unavailable'));
    await f.service.tick();
    f.advance(301);
    await Promise.all([f.service.tick(), f.service.tick()]);
    expect(f.ports.report).toHaveBeenCalledTimes(2);
  });
});

it('preserves configured delivery defaults for an ordinary source binding', async () => {
  const f = await integrationFixture();
  const { sessionId } = await f.integrations.accept('operator', 'binding', 'thread', f.target, f.input);
  const reporting = new WatchdogReporting({ store: f.store, delivery: f.delivery, webhooks: { fanout: async () => {}, deliver: async () => ({}) }, operatorDestinations: [] });
  const finding: WatchdogFinding = { candidate: { ...candidate, sessionId }, observedAt: 4000, judge: { status: 'skipped' }, retry: 'not_applicable', cancel: 'not_requested', reportVersion: 1, reportedVersion: 0 };
  await reporting.report('finding_source', finding);
  expect(f.delivery.deliver).toHaveBeenCalledWith(expect.objectContaining({ source: f.input.source }));
  const delivered = vi.mocked(f.delivery.deliver).mock.calls as unknown as Array<[unknown]>;
  expect(delivered[0]?.[0]).not.toHaveProperty('destinations');
});

it('requires both cancellation opt-ins and unchanged evidence for the active Turn', async () => {
  const f = await integrationFixture();
  const { sessionId } = await f.integrations.accept('operator', 'binding', 'thread', { ...f.target, watchdog: { cancelLoops: true } }, f.input);
  await f.integrations.submitPending('operator', sessionId);
  await f.sessions.dispatch('operator', sessionId);
  const snapshot = await f.sessions.streamSnapshot('operator', sessionId);
  await f.store.put({ ownerId: 'operator', id: sessionId, collection: 'session_observations', createdAt: 1, revision: 1, value: snapshot }, 0);
  const turnId = snapshot.turns[0]!.id;
  const selected = { ...candidate, sessionId, turnId, digest: watchdogDigest(snapshot.items.filter(item => item.turn_id === turnId)) };
  expect(await applyWatchdogAction(f.store, admission(f.store, 1), selected, 'cancel', 4000, policy)).toBe(false);
  expect(await applyWatchdogAction(f.store, admission(f.store, 1), { ...selected, digest: { ...selected.digest, totalItems: 999 } }, 'cancel', 4000, { ...policy, allowCancel: true })).toBe(false);
  expect(await applyWatchdogAction(new SessionEventStore(f.store), admission(f.store, 0), selected, 'cancel', 4000, { ...policy, allowCancel: true })).toBe(true);
  await f.sessions.dispatch('operator', sessionId);
  expect(f.execution.cancel).toHaveBeenCalledWith('operator', expect.any(Object), turnId);
});

it('rejects cancellation when runtime progress changes the observation during its commit', async () => {
  const f = await integrationFixture();
  const { sessionId } = await f.integrations.accept('operator', 'binding', 'thread', { ...f.target, watchdog: { cancelLoops: true } }, f.input);
  await f.integrations.submitPending('operator', sessionId);
  await f.sessions.dispatch('operator', sessionId);
  const store = new SessionEventStore(f.store);
  const runtime = new SessionRuntimeStore(store);
  await runtime.claim('operator', sessionId, 'run', 1);
  const observation = (await store.get<SessionStreamSnapshot>('operator', 'session_observations', sessionId))!;
  const turn = observation.value.turns[0]!;
  const selected = { ...candidate, sessionId, turnId: turn.id, digest: watchdogDigest(observation.value.items.filter(item => item.turn_id === turn.id)) };
  const commit = f.store.commit.bind(f.store);
  let progressed = false;
  vi.spyOn(f.store, 'commit').mockImplementation(async writes => {
    if (!progressed && writes.some(({ resource }) => resource.collection === 'sessions')) {
      progressed = true;
      await runtime.publish('operator', sessionId, 'run', {
        ...initialSessionRuntime(sessionId, f.agent.id, 'thread'),
        turns: [{ threadId: 'thread', nativeTurnId: 'native', turn, items: [{ ...call('progress', 'new work'), turn_id: turn.id }] }],
      });
    }
    await commit(writes);
  });
  await expect(applyWatchdogAction(store, admission(f.store, 0), selected, 'cancel', 4000, { ...policy, allowCancel: true })).rejects.toMatchObject({ code: 'conflict' });
  expect(progressed).toBe(true);
  expect((await store.get<SessionState>('operator', 'sessions', sessionId))!.value.turns[0]!.cancelRequested).not.toBe(true);
  expect(f.execution.cancel).not.toHaveBeenCalled();
});

it('reports and submits exactly one safe server_overloaded retry across repeated ticks', async () => {
  const f = await failedSession();
  const reports = vi.fn(async () => {});
  const service = new WatchdogService({ store: f.store, policy, clock: { now: () => 1000 }, ports: {
    collect: async () => {
      const state = (await f.store.get<SessionState>('operator', 'sessions', f.session.id))!.value;
      return { candidates: watchdogSessionCandidates('operator', state, savedSessionObservation(state, undefined, undefined, 1000), 1000, policy), findings: [], partial: false };
    },
    judgeStart: async () => { throw new Error('A failed Turn should not need a judge'); }, judgeRead: async () => ({ status: 'failed' }), judgeStop: async () => {},
    act: async (selected, action, now) => { const accepted = await applyWatchdogAction(f.store, admission(f.store, 1), selected, action, now, policy); if (accepted) await f.sessions.dispatch('operator', f.session.id); return accepted; },
    report: reports,
  } });
  await service.tick(); await service.tick();
  expect(f.execution.start).toHaveBeenCalledTimes(2);
  expect(reports).toHaveBeenCalledTimes(1);
  expect(reports).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ retry: 'submitted' }));
});
