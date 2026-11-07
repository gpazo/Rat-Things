import { expect, it } from 'vitest';
import { access } from 'node:fs/promises';
import { defaults, parsePerformanceArguments, quantile, summarize, targetCheck } from '../../testing/performance/statistics.js';
import { actorId, createPerformanceFixture, messageBody } from '../../testing/performance/fixture.js';
import { runScenario } from '../../testing/performance/multiplayer.js';
import { inspectActivity } from '../../testing/performance/observer.js';
import type { SessionActivity } from '../../src/core/session-activity.js';

it('preserves failure and censored denominators instead of reporting a fast successful subset as passing', () => {
  const samples = [{ correlation: 'fast', status: 'observed' as const, milliseconds: 0 }, { correlation: 'failed', status: 'error' as const }, { correlation: 'lost', status: 'timeout' as const, lowerBoundMs: 2000 }];
  expect(summarize(samples)).toMatchObject({ expected: 3, observed: 1, errors: 1, timeouts: 1, censored: 2, p50Ms: 0 });
  expect(targetCheck(samples, 500, 1500).passed).toBe(false);
  expect(targetCheck([], 500, 1500).passed).toBe(false);
  expect(quantile([9, 1, 4, 2], .5)).toBe(2);
  expect(quantile([9, 1, 4, 2], .99)).toBe(9);
  expect(() => quantile([NaN], .5)).toThrow();
});

it('bounds workload configuration and rejects ambiguous or unbounded command lines', () => {
  expect(parsePerformanceArguments(['--viewers', '20,50', '--writers', '20', '--history-items', '0,200', '--stream-mode', 'desktop', '--rounds', '1'])).toMatchObject({ viewers: [20, 50], writers: 20, historyItems: [0, 200], streamMode: 'desktop', rounds: 1 });
  for (const args of [['--writers', '21'], ['--viewers', '1,1'], ['--history-items', '-1'], ['--duration-ms', '99999999'], ['--rounds', '0'], ['--stream-mode', 'pretend'], ['--other', '1']]) expect(() => parsePerformanceArguments(args)).toThrow();
});

it.each(['persistent', 'desktop'] as const)('measures exact correlated messages over real HTTP/SQLite with %s subscriptions', async mode => {
  const result = await runScenario({ ...defaults, writers: 3, rounds: 2, idleMs: 100, streamIntervalMs: 20, syntheticDelayMs: 1, timeoutMs: 3000, durationMs: 15_000 }, 2, 6, mode);
  expect(result.errors).toEqual([]);
  expect(result.correctness).toMatchObject({ passed: true, finalAccepted: 6, errors: [], roleChecks: { viewerWriteStatus: 403, revokedWriteStatus: 403, idempotentRetryStatus: 204, durableInputCountUnchanged: true } });
  expect(result.initialItems).toBe(7);
  expect(result.submission.summary).toMatchObject({ expected: 6, observed: 6, censored: 0 });
  expect(result.peerVisibility.summary).toMatchObject({ expected: 12, observed: 12 });
  expect(result.firstSyntheticOutput.summary).toMatchObject({ expected: 12, observed: 12 });
  expect(result.syntheticExecution).toMatchObject({ invocationCount: expect.any(Number), totalInvocationCount: expect.any(Number), setupInvocationCount: 1 });
  expect(result.syntheticExecution.totalInvocationCount).toBe(result.syntheticExecution.invocationCount + result.syntheticExecution.setupInvocationCount);
  expect(result.syntheticExecution.inputOccurrences).toHaveLength(6);
  expect(result.stream.initialBytes).toBeGreaterThan(0);
  expect(result.stream.workloadBytes).toBeGreaterThan(0);
  expect(result.cleanup.completed).toBe(true);
  if (mode === 'desktop') {
    expect(result.stream.viewers.every(viewer => viewer.connections === 1 && viewer.snapshotRequests >= 1 && viewer.runtimeRequests === viewer.snapshotRequests)).toBe(true);
    expect(result.stream.viewers.every(viewer => viewer.snapshotBytes > 0 && viewer.runtimeBytes > 0 && viewer.authorityBytes > 0)).toBe(true);
    expect(result.stream.totalResponseBodyBytes).toBeGreaterThan(result.stream.bytes);
  }
}, 20_000);

it('never claims confirmed cleanup when fixture setup throws before returning its cleanup handle', async () => {
  const result = await runScenario({ ...defaults, writers: 1, rounds: 1 }, 1, 0, 'persistent', 0, performance.now() + 1000,
    async () => { throw new Error('Fixture setup and cleanup failed'); });
  expect(result.cleanup).toMatchObject({ completed: false, error: 'fixture_setup_cleanup_unconfirmed' });
  expect(result.submission.summary).toMatchObject({ expected: 1, observed: 0, notStarted: 1 });
  expect(result.peerVisibility.summary).toMatchObject({ expected: 1, notStarted: 1 });
  expect(result.correctness.passed).toBe(false);
});

it('retains timed-out output samples and fails correctness instead of treating accepted state as agent progress', async () => {
  const result = await runScenario({ ...defaults, writers: 1, rounds: 1, idleMs: 100, streamIntervalMs: 10, syntheticDelayMs: 300, timeoutMs: 100, durationMs: 5000 }, 1, 0, 'persistent');
  expect(result.submission.summary.observed).toBe(1);
  expect(result.peerVisibility.summary.observed).toBe(1);
  expect(result.firstSyntheticOutput.summary).toMatchObject({ expected: 1, observed: 0, censored: 1, timeouts: 1 });
  expect(result.correctness.passed).toBe(false);
  expect(result.cleanup.completed).toBe(true);
}, 10_000);

it('requires exact message content and authenticated receipt ownership, and cleans up its private SQLite directory', async () => {
  const fixture = await createPerformanceFixture({ ...defaults, writers: 1 }, 1, 0);
  try {
    const correlation = 'perf-msg:probe';
    const submitted = await fixture.request(`/v1/agents/sessions/${fixture.sessionId}/events`, 'writer-0', { body: messageBody(correlation), key: 'probe' });
    expect(submitted.status).toBe(204); await submitted.arrayBuffer();
    const response = await fixture.request(`/v1/rat/sessions/${fixture.sessionId}/activity`, 'viewer-0');
    const snapshot = await response.json() as SessionActivity;
    const expected = [{ correlation, writer: 0 }];
    expect(inspectActivity(snapshot, expected).accepted).toHaveLength(1);
    expect(inspectActivity(snapshot, [{ correlation: `${correlation}-different`, writer: 0 }]).accepted).toHaveLength(0);
    const modified = structuredClone(snapshot); modified.inputs.at(-1)!.actor.id = 'forged';
    expect(inspectActivity(modified, expected)).toMatchObject({ accepted: [], errors: [`wrong_attribution:${correlation}`] });
  } finally { await fixture.close(); }
  await expect(access(fixture.directory)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('preserves exact actor and receipt attribution while pending input materializes into a shared Turn', () => {
  const accepted = {
    cursor: 'opaque.digest', session: { id: 'session' }, turns: [], items: [],
    inputs: [
      { id: 'receipt-a', actor: { id: actorId('writer-0'), kind: 'human', issuer: 'fixture', subject: 'writer-0' }, provenance: { kind: 'authenticated' }, sequence: 1, status: 'accepted', accepted_at: 1, turn_ids: [], message_ids: ['message-a'] },
      { id: 'receipt-b', actor: { id: actorId('writer-1'), kind: 'human', issuer: 'fixture', subject: 'writer-1' }, provenance: { kind: 'authenticated' }, sequence: 2, status: 'accepted', accepted_at: 2, turn_ids: [], message_ids: ['message-b'] },
    ],
    pending_inputs: [
      { receipt_id: 'receipt-a', messages: [{ id: 'message-a', role: 'user', content: [{ type: 'input_text', text: 'perf-msg:a' }], actor: { id: actorId('writer-0') }, provenance: { kind: 'authenticated' } }] },
      { receipt_id: 'receipt-b', messages: [{ id: 'message-b', role: 'user', content: [{ type: 'input_text', text: 'perf-msg:b' }], actor: { id: actorId('writer-1') }, provenance: { kind: 'authenticated' } }] },
    ],
  } as unknown as SessionActivity;
  expect(inspectActivity(accepted, [{ correlation: 'perf-msg:a', writer: 0 }, { correlation: 'perf-msg:b', writer: 1 }])).toMatchObject({
    accepted: [{ correlation: 'perf-msg:a', messageId: 'message-a', receiptId: 'receipt-a' }, { correlation: 'perf-msg:b', messageId: 'message-b', receiptId: 'receipt-b' }], errors: [],
  });
  const materialized = structuredClone(accepted) as SessionActivity;
  (materialized as SessionActivity & { pending_inputs?: unknown[] }).pending_inputs = [];
  materialized.turns = [{ id: 'turn-shared', status: 'completed', usage: null } as SessionActivity['turns'][number]];
  materialized.inputs = materialized.inputs.map(receipt => ({ ...receipt, status: 'dispatched', turn_ids: ['turn-shared'] }));
  materialized.items = [
    { id: 'message-a', type: 'message', role: 'user', turn_id: 'turn-shared', content: [{ type: 'input_text', text: 'perf-msg:a' }] } as SessionActivity['items'][number],
    { id: 'message-b', type: 'message', role: 'user', turn_id: 'turn-shared', content: [{ type: 'input_text', text: 'perf-msg:b' }] } as SessionActivity['items'][number],
  ];
  expect(inspectActivity(materialized, [{ correlation: 'perf-msg:a', writer: 0 }, { correlation: 'perf-msg:b', writer: 1 }])).toMatchObject({
    accepted: [{ correlation: 'perf-msg:a', messageId: 'message-a', receiptId: 'receipt-a' }, { correlation: 'perf-msg:b', messageId: 'message-b', receiptId: 'receipt-b' }], errors: [],
  });
});
