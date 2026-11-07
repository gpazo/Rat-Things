import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { arch, cpus, platform, release } from 'node:os';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { SessionActivity } from '../../src/core/session-activity.js';
import { createPerformanceFixture, actorId, errorCode, messageBody, type PerformanceFixture } from './fixture.js';
import { inspectActivity, observe, observerBytes, type ExpectedInput, type Observer } from './observer.js';
import { subtractCounts } from './counting-store.js';
import { parsePerformanceArguments, summarize, targetCheck, type LatencySample, type PerformanceConfig } from './statistics.js';

interface Submission extends ExpectedInput { round: number; key: string; startedAt?: number; acknowledgedAt?: number; failedAt?: number; httpStatus?: number; error?: string }
async function until(predicate: () => boolean, deadline: number, signal: AbortSignal) {
  while (!predicate() && performance.now() < deadline && !signal.aborted) await delay(10, undefined, { signal }).catch(() => {});
  return predicate();
}
function submissionSample(input: Submission, finishedAt: number): LatencySample {
  if (input.startedAt === undefined) return { correlation: input.correlation, status: 'not_started' };
  if (input.httpStatus === 204 && input.acknowledgedAt !== undefined) return { correlation: input.correlation, status: 'observed', milliseconds: input.acknowledgedAt - input.startedAt };
  const timedOut = input.httpStatus === undefined && ['TimeoutError', 'AbortError'].includes(input.error ?? 'TimeoutError');
  return { correlation: input.correlation, status: timedOut ? 'timeout' : 'error',
    ...(input.acknowledgedAt === undefined ? { lowerBoundMs: (input.failedAt ?? finishedAt) - input.startedAt } : { milliseconds: input.acknowledgedAt - input.startedAt }),
    detail: input.httpStatus === undefined ? input.error ?? 'request_timeout' : `HTTP_${input.httpStatus}` };
}
function viewerSample(input: Submission, observer: Observer, at: number | undefined, finishedAt: number, timeoutMs: number): LatencySample {
  const base = { correlation: input.correlation, viewer: observer.viewer };
  if (input.startedAt === undefined) return { ...base, status: 'not_started' };
  const milliseconds = at === undefined ? undefined : at - input.startedAt;
  if (milliseconds !== undefined && milliseconds <= timeoutMs) return { ...base, status: 'observed', milliseconds };
  if (input.httpStatus !== undefined && input.httpStatus !== 204 && at === undefined) return { ...base, status: 'not_accepted', detail: `HTTP_${input.httpStatus}` };
  return { ...base, status: observer.errors.length ? 'error' : 'timeout', lowerBoundMs: Math.min(finishedAt - input.startedAt, timeoutMs),
    ...(milliseconds === undefined ? {} : { lateObservationMs: milliseconds }), ...(observer.errors.length ? { detail: observer.errors[0]! } : {}) };
}
async function activity(fixture: PerformanceFixture, signal?: AbortSignal): Promise<SessionActivity> {
  const response = await fixture.request(`/v1/rat/sessions/${fixture.sessionId}/activity`, 'manager', signal ? { signal } : {});
  if (!response.ok) throw new Error(`Snapshot HTTP ${response.status}`);
  return response.json() as Promise<SessionActivity>;
}

export async function runScenario(config: PerformanceConfig, viewers: number, historyItems: number, mode: 'persistent' | 'desktop', index = 0, deadline = performance.now() + config.durationMs,
  fixtureFactory: typeof createPerformanceFixture = createPerformanceFixture) {
  const started = performance.now(); const startedAt = new Date().toISOString();
  const submissions: Submission[] = Array.from({ length: config.rounds * config.writers }, (_, n) => ({ correlation: `perf-msg:case${index}-r${Math.floor(n / config.writers)}-w${n % config.writers}`,
    writer: n % config.writers, round: Math.floor(n / config.writers), key: `round-${Math.floor(n / config.writers)}` }));
  const observers: Observer[] = [];
  const semanticErrors = new Set<string>();
  const errors: string[] = [];
  const signal = AbortSignal.timeout(Math.max(1, Math.ceil(deadline - performance.now())));
  let fixture: PerformanceFixture | undefined;
  let initialItems = 0;
  let initialBytes = 0;
  let workloadBytes = 0;
  let idle: unknown = null;
  let workloadStorage: unknown = null;
  let roleChecks: unknown = null;
  let cleanup: { completed: boolean; milliseconds: number; error?: string } = { completed: false, milliseconds: 0 };
  let finalAccepted = 0;
  const burstStarts: number[] = [];
  try {
    fixture = await fixtureFactory(config, viewers, historyItems);
    initialItems = (await activity(fixture)).items.length;
    for (let viewer = 0; viewer < viewers; viewer++) observers.push(observe(fixture, viewer, submissions, mode, signal));
    if (!await until(() => observers.every(observer => observer.ready), Math.min(deadline, performance.now() + config.timeoutMs), signal)) throw new Error('Viewer startup timed out');
    initialBytes = observers.reduce((sum, observer) => sum + observerBytes(observer), 0);
    const beforeIdle = fixture.counted.snapshot(); const idleStarted = performance.now();
    const idleBytes = observers.reduce((sum, observer) => sum + observerBytes(observer), 0);
    const idleRefreshes = observers.reduce((sum, observer) => sum + observer.authRefreshes, 0);
    await delay(Math.min(config.idleMs, Math.max(1, deadline - performance.now())), undefined, { signal });
    const idleDuration = performance.now() - idleStarted;
    const operations = subtractCounts(fixture.counted.snapshot(), beforeIdle);
    const calls = Object.values(operations.calls).reduce((sum, count) => sum + count, 0);
    idle = { durationMs: idleDuration, connectedViewers: observers.filter(observer => observer.errors.length === 0).length, storage: operations,
      apiCallsPerViewerSecond: calls / viewers / (idleDuration / 1000), responseBodyBytes: observers.reduce((sum, observer) => sum + observerBytes(observer), 0) - idleBytes,
      authorityRefreshes: observers.reduce((sum, observer) => sum + observer.authRefreshes, 0) - idleRefreshes };
    const beforeWorkload = fixture.counted.snapshot();
    const beforeWorkloadBytes = observers.reduce((sum, observer) => sum + observerBytes(observer), 0);
    for (let round = 0; round < config.rounds && !signal.aborted; round++) {
      const current = submissions.filter(input => input.round === round);
      burstStarts.push(performance.now() - started);
      await Promise.all(current.map(async input => {
        input.startedAt = performance.now();
        try {
          const response = await fixture!.request(`/v1/agents/sessions/${fixture!.sessionId}/events`, `writer-${input.writer}`, { body: messageBody(input.correlation), key: input.key,
            signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]) });
          input.httpStatus = response.status; await response.arrayBuffer(); input.acknowledgedAt = performance.now();
        } catch (error) { input.error = errorCode(error); input.failedAt = performance.now(); }
      }));
      const roundDeadline = Math.min(deadline, Math.max(...current.map(input => input.startedAt!)) + config.timeoutMs);
      await until(() => current.every(input => input.httpStatus !== 204 || observers.every(observer => observer.accepted.has(input.correlation) && observer.outputs.has(input.correlation))), roundDeadline, signal);
    }
    workloadStorage = subtractCounts(fixture.counted.snapshot(), beforeWorkload);
    workloadBytes = observers.reduce((sum, observer) => sum + observerBytes(observer), 0) - beforeWorkloadBytes;
    const final = await activity(fixture);
    const proof = inspectActivity(final, submissions);
    for (const error of proof.errors) semanticErrors.add(error);
    finalAccepted = proof.accepted.length;
    for (const input of submissions) {
      const accepted = proof.accepted.filter(value => value.correlation === input.correlation);
      if (input.httpStatus === 204 && accepted.length !== 1) semanticErrors.add(`acknowledged_input_missing:${input.correlation}`);
      if (accepted.length && fixture.executed.get(input.correlation)?.count !== 1) semanticErrors.add(`accepted_effect_count:${input.correlation}:${fixture.executed.get(input.correlation)?.count ?? 0}`);
      const invocationCount = fixture.mockInvocations.flatMap(invocation => invocation.correlations).filter(value => value === input.correlation).length;
      if (accepted.length && invocationCount !== 1) semanticErrors.add(`accepted_invocation_count:${input.correlation}:${invocationCount}`);
      const identities = new Set(observers.flatMap(observer => { const value = observer.accepted.get(input.correlation); return value ? [`${value.messageId}:${value.receiptId}`] : []; }));
      if (identities.size > 1) semanticErrors.add(`peer_identity_mismatch:${input.correlation}`);
    }
    // Probe the same public authorization and idempotency boundaries, outside the measured workload.
    const forbidden = await fixture.request(`/v1/agents/sessions/${fixture.sessionId}/events`, 'viewer-0', { body: messageBody('forbidden-viewer'), key: 'forbidden-viewer' });
    await forbidden.arrayBuffer();
    const revoked = await fixture.request(`/v1/rat/spaces/${fixture.spaceId}/bindings/${actorId('revoked-probe')}`, 'manager', { method: 'DELETE' }); await revoked.arrayBuffer();
    const afterRevocation = await fixture.request(`/v1/agents/sessions/${fixture.sessionId}/events`, 'revoked-probe', { body: messageBody('forbidden-revoked'), key: 'forbidden-revoked' }); await afterRevocation.arrayBuffer();
    const first = submissions.find(input => input.httpStatus === 204);
    let retryStatus: number | null = null;
    if (first) { const retry = await fixture.request(`/v1/agents/sessions/${fixture.sessionId}/events`, `writer-${first.writer}`, { body: messageBody(first.correlation), key: first.key }); retryStatus = retry.status; await retry.arrayBuffer(); }
    const after = await activity(fixture);
    const unchanged = after.inputs.length === final.inputs.length && inspectActivity(after, submissions).accepted.length === finalAccepted;
    roleChecks = { viewerWriteStatus: forbidden.status, revocationStatus: revoked.status, revokedWriteStatus: afterRevocation.status, idempotentRetryStatus: retryStatus, durableInputCountUnchanged: unchanged };
    if (forbidden.status !== 403 || revoked.status !== 200 || afterRevocation.status !== 403 || !unchanged || first && retryStatus !== 204) semanticErrors.add('authorization_or_retry_probe_failed');
  } catch (error) { errors.push(error instanceof Error ? error.message.slice(0, 300) : 'Unknown scenario failure'); }
  finally {
    const cleanupStart = performance.now();
    for (const observer of observers) observer.stop();
    await Promise.all(observers.map(observer => observer.done));
    if (fixture) {
      try { await fixture.close(); cleanup = { completed: true, milliseconds: performance.now() - cleanupStart }; }
      catch (error) { cleanup = { completed: false, milliseconds: performance.now() - cleanupStart, error: errorCode(error) }; }
    } else cleanup = { completed: false, milliseconds: performance.now() - cleanupStart, error: 'fixture_setup_cleanup_unconfirmed' };
  }
  const finished = performance.now();
  // Retain expected pairs even if observer creation or setup failed.
  const peerSamples = submissions.flatMap(input => Array.from({ length: viewers }, (_, viewer) => {
    const observer = observers[viewer]; return observer ? viewerSample(input, observer, observer.accepted.get(input.correlation)?.at, finished, config.timeoutMs)
      : { correlation: input.correlation, viewer, status: 'not_started' as const };
  }));
  const outputSamples = submissions.flatMap(input => Array.from({ length: viewers }, (_, viewer) => {
    const observer = observers[viewer]; return observer ? viewerSample(input, observer, observer.outputs.get(input.correlation), finished, config.timeoutMs)
      : { correlation: input.correlation, viewer, status: 'not_started' as const };
  }));
  const submissionSamples = submissions.map(input => submissionSample(input, finished));
  for (const observer of observers) for (const error of observer.semanticErrors) semanticErrors.add(error);
  return { index, config: { viewers, writers: config.writers, historyItems, rounds: config.rounds, streamMode: mode }, startedAt, endedAt: new Date().toISOString(), elapsedMs: finished - started,
    initialItems, burstStartsMs: burstStarts, rateLimit: { ownerRequestsPerMinute: 60, initialSessionRequests: 1, raised: false, retries: 'one explicit idempotency probe; no client submission retries' },
    submission: { summary: summarize(submissionSamples), samples: submissionSamples, httpStatuses: submissions.map(input => ({ correlation: input.correlation, status: input.httpStatus ?? null })) },
    peerVisibility: { summary: summarize(peerSamples), samples: peerSamples, boundary: 'submission start to exact attributed message+receipt in this viewer activity frame' },
    firstSyntheticOutput: { summary: summarize(outputSamples), samples: outputSamples, boundary: 'submission start to correlated typed assistant output in each viewer; deterministic mock, no model latency claim', syntheticDelayMs: config.syntheticDelayMs },
    syntheticExecution: { invocationCount: fixture?.mockInvocations.length ?? 0, inputOccurrences: fixture?.mockInvocations.flatMap(invocation => invocation.correlations) ?? [], boundary: 'one synthetic executor invocation may receive multiple messages; each accepted correlation must occur in exactly one invocation' },
    targets: { provisional: true, intendedLoad: { writers: 20, viewers: 50 }, intendedLoadExercised: config.writers === 20 && viewers === 50,
      submission: targetCheck(submissionSamples, 500, 1500), peerVisibility: targetCheck(peerSamples, 1000, 2000) },
    stream: { bytes: observers.reduce((sum, observer) => sum + observer.bytes, 0), byteMeaning: 'SSE body bytes only',
      totalResponseBodyBytes: observers.reduce((sum, observer) => sum + observerBytes(observer), 0), initialBytes, workloadBytes,
      viewers: observers.map(observer => ({ viewer: observer.viewer, bytes: observer.bytes, snapshotBytes: observer.snapshotBytes, runtimeBytes: observer.runtimeBytes, authorityBytes: observer.authorityBytes,
        frames: observer.frames, connections: observer.connections, snapshotRequests: observer.snapshotRequests, runtimeRequests: observer.runtimeRequests,
        authRefreshes: observer.authRefreshes, totalRequests: observer.connections + observer.snapshotRequests + observer.runtimeRequests + observer.authRefreshes, errors: observer.errors })) },
    storage: { units: 'AgentsStore API calls and attempted resource writes/conditions; not SQL statements, RCU/WCU, or billed cost', idle, workload: workloadStorage },
    correctness: { passed: semanticErrors.size === 0 && errors.length === 0 && observers.every(observer => observer.errors.length === 0) && cleanup.completed
      && peerSamples.every(sample => sample.status === 'observed') && outputSamples.every(sample => sample.status === 'observed') && submissionSamples.every(sample => sample.status === 'observed'),
      finalAccepted, errors: [...semanticErrors], roleChecks }, errors, workerErrors: fixture?.workerErrors ?? [], cleanup };
}

export async function runPerformance(config: PerformanceConfig) {
  const startedAt = new Date().toISOString(); const start = performance.now();
  let revision = 'unknown'; let dirty = true;
  try { revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); dirty = Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()); } catch { /* Artifact explicitly marks unknown revision. */ }
  const scenarios: Array<Awaited<ReturnType<typeof runScenario>>> = [];
  const notRun: Array<{ viewers: number; historyItems: number; streamMode: string; reason: string; notStartedSubmissions: number; notStartedViewerSamples: number }> = [];
  const modes = config.streamMode === 'both' ? ['persistent', 'desktop'] as const : [config.streamMode];
  for (const mode of modes) for (const historyItems of config.historyItems) for (const viewers of config.viewers) {
    if (performance.now() - start >= config.durationMs) { notRun.push({ viewers, historyItems, streamMode: mode, reason: 'global_duration_budget', notStartedSubmissions: config.writers * config.rounds, notStartedViewerSamples: config.writers * config.rounds * viewers }); continue; }
    scenarios.push(await runScenario(config, viewers, historyItems, mode, scenarios.length, start + config.durationMs));
  }
  return { schemaVersion: 1, harness: 'multiplayer-local-http-sqlite', revision, dirty, config, startedAt, endedAt: new Date().toISOString(), elapsedMs: performance.now() - start,
    platform: { node: process.version, platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model ?? 'unknown', logicalCpus: cpus().length },
    boundaries: { real: ['loopback HTTP', 'routeAgentsRequest', 'space roles and workload admission', 'encrypted SQLite WAL FULL transactions', 'SessionEventStore and runtime publication', 'activity SSE'],
      mocked: ['upstream OIDC verification: fixture bearer identities on loopback only', 'execution and model: deterministic typed assistant output', 'outbox wakeup: serialized in-process dispatcher'],
      excluded: ['network RTT outside host', 'AWS/IAM/JWT verification', 'real native execution', 'model/provider latency', 'transfer duration', 'billable cloud cost'],
      contention: 'HTTP clients, server, SQLite, and mock executor share one Node process; not independent load generators',
      setup: 'Synthetic history seeded by mock execution before timing; isolated space/database per matrix cell',
      desktop: 'Playback: GET activity + GET runtime when cursorless; one SSE activity event per connection, cursor resume after50ms,20s idle reset then1000ms wait, cursorless snapshot on next connection after15s, GET spaces immediately and every2000ms; not native UI',
      clock: 'performance.now monotonic in one process; wall-clock timestamps are metadata only',
      quantiles: 'nearest-rank empirical quantiles over observed samples only; censored samples force target failure; per-viewer samples share writers and are correlated; no statistical confidence claim' },
    scenarios, notRun, passed: notRun.length === 0 && scenarios.every(scenario => scenario.correctness.passed && scenario.targets.submission.passed && scenario.targets.peerVisibility.passed) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const config = parsePerformanceArguments(process.argv.slice(2));
  const result = await runPerformance(config);
  await mkdir(dirname(resolve(config.output)), { recursive: true }); await writeFile(config.output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ output: resolve(config.output), scenarios: result.scenarios.length, notRun: result.notRun.length, passed: result.passed, elapsedMs: result.elapsedMs }));
  if (!result.passed) process.exitCode = 1;
}
