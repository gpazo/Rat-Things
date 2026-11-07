import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import OpenAI from 'openai';
import { createAgentsClient } from '../../src/agents-client.js';
import { createTeamIdentities, type TeamIdentityFixture, type TestTeamIdentity } from '../aws/team-identities.js';
import { actualProgress, digest, finishSample, itemKey, observePeer, receiptFor, settled, summarize, type Activity, type Sample, type Workload } from './measurements.js';
import { observeActivity, type ObserverMeasurement } from './observer.js';

const matrix = [{ writers: 1, viewers: 1 }, { writers: 10, viewers: 10 }, { writers: 20, viewers: 20 }, { writers: 20, viewers: 50 }];
export interface Options {
  output: string; scenarios: typeof matrix; rounds: number; timeoutMs: number; streamMode: 'persistent' | 'desktop';
  lambdaMemoryMb: number | null; deploymentRevision: string | null; bundleSha256: string | null;
}
export function parseArguments(args: readonly string[]): Options {
  const values = new Map<string, string>();
  const known = ['--output', '--scenario', '--rounds', '--timeout-ms', '--stream-mode', '--lambda-memory-mb', '--deployment-revision', '--bundle-sha256'];
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]!; const value = args[index + 1];
    if (!known.includes(name) || value === undefined || value.startsWith('--') || values.has(name)) throw new Error('Invalid or duplicate controller argument.');
    values.set(name, value);
  }
  if (!values.get('--output')) throw new Error('--output is required.');
  const integer = (name: string, fallback: number, max: number, min = 1) => {
    const text = values.get(name); const value = text === undefined ? fallback : Number(text);
    if (text !== undefined && !/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}.`);
    return value;
  };
  const selected = values.get('--scenario')?.split(',') ?? matrix.map(value => `${value.writers}x${value.viewers}`);
  if (new Set(selected).size !== selected.length) throw new Error('Duplicate scenario.');
  const scenarios = selected.map(name => {
    const scenario = matrix.find(value => `${value.writers}x${value.viewers}` === name);
    if (!scenario) throw new Error('Scenario must be 1x1, 10x10, 20x20, or 20x50.');
    return { ...scenario };
  });
  const streamMode = values.get('--stream-mode') ?? 'persistent';
  if (streamMode !== 'persistent' && streamMode !== 'desktop') throw new Error('Invalid stream mode.');
  const deploymentRevision = values.get('--deployment-revision') ?? null;
  const bundleSha256 = values.get('--bundle-sha256') ?? null;
  if (deploymentRevision !== null && !/^[a-f0-9]{40}$/.test(deploymentRevision)) throw new Error('Deployment revision requires a full Git SHA.');
  if (bundleSha256 !== null && !/^[a-f0-9]{64}$/.test(bundleSha256)) throw new Error('Bundle hash requires hexadecimal SHA-256.');
  return { output: resolve(values.get('--output')!), scenarios, rounds: integer('--rounds', 1, 10), timeoutMs: integer('--timeout-ms', 420_000, 900_000, 1_000),
    streamMode, lambdaMemoryMb: values.has('--lambda-memory-mb') ? integer('--lambda-memory-mb', 128, 10_240, 128) : null, deploymentRevision, bundleSha256 };
}

export function liveConfiguration(environment: NodeJS.ProcessEnv) {
  for (const name of ['AWS_E2E', 'AWS_E2E_SHARED_SESSIONS', 'AWS_E2E_REAL_CODEX']) {
    if (environment[name] !== 'true') throw new Error(`Explicit ${name}=true is required.`);
  }
  const required = (name: string) => { const value = environment[name]; if (!value) throw new Error(`Missing ${name}.`); return value; };
  const region = required('AWS_REGION');
  if (!/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(region)) throw new Error('Invalid AWS region.');
  const baseURL = required('SHARED_AGENTS_API_BASE_URL').replace(/\/$/, '');
  const endpoint = new URL(baseURL);
  if (endpoint.protocol !== 'https:' || !endpoint.hostname.endsWith(`.lambda-url.${region}.on.aws`) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('Use the disposable application-authenticated Lambda URL.');
  }
  const operatorURL = required('RAT_THINGS_AGENTS_API_URL');
  const operator = new URL(operatorURL);
  if (operator.protocol !== 'https:' || operator.username || operator.password || operator.search || operator.hash) throw new Error('Invalid operator endpoint.');
  const model = required('AWS_E2E_CODEX_MODEL_ID');
  if (!/^[a-zA-Z0-9._:/-]{1,200}$/.test(model)) throw new Error('Invalid model identifier.');
  const fixture = JSON.parse(required('TEAM_OIDC_FIXTURE_JSON')) as TeamIdentityFixture;
  return { region, baseURL, operatorURL, model, fixture };
}

export async function cleanupActions(actions: readonly (readonly [string, () => Promise<unknown>])[]): Promise<Record<string, 'complete' | 'failed'>> {
  const results: Record<string, 'complete' | 'failed'> = {};
  for (const [name, action] of actions) {
    try { await action(); results[name] = 'complete'; } catch { results[name] = 'failed'; }
  }
  return results;
}

interface ScenarioResult {
  id: string; writers: number; viewers: number; status: 'running' | 'passed' | 'failed'; phase: string;
  startedAt: string; finishedAt: string | null;
  spaceId?: string; agentId?: string; sessionId?: string;
  samples: Sample[]; observers: ObserverMeasurement[]; summary?: ReturnType<typeof summarize>;
  phases: { phase: string; atMs: number; atUtc: string }[];
  errors: { phase: string; kind: string }[];
  cleanup: Record<string, string>;
  turns: { id: string; status: string; baseline: boolean; usage: Activity['turns'][number]['usage'] }[];
  initialSession?: { acknowledgementMs: number | null; firstProgressMs: number | null; completedMs: number | null; startedAt: string; observedUntilMs: number; boundary: string };
  cost?: { streamConnectionMs: number; streamBytes: number; snapshotBytes: number; observerHttpConnectionMs: number; lambdaMemoryMb: number | null; usd: null };
}

const eventBody = (text: string) => ({ events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text }] }] }] });
const safeFailure = (error: unknown) => {
  if (error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' && Number.isInteger(error.status) && error.status >= 100 && error.status <= 599) return `http_${error.status}`;
  return error instanceof Error && /^(http_\d{3}|timeout|interrupted|observer_failure|turn_failed|receipt_mismatch)$/.test(error.message) ? error.message : 'controller_failure';
};

export async function run(options: Options, environment: NodeJS.ProcessEnv = process.env, signal = new AbortController().signal) {
  // Validate opt-ins before any identity, API, or SDK operation.
  const configuration = liveConfiguration(environment);
  const origin = performance.now(); const now = () => performance.now() - origin;
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { encoding: 'utf8' }).trim().length > 0;
  const artifact = {
    schemaVersion: 1, kind: 'real-aws-shared-session-performance', status: 'running', startedAt: new Date().toISOString(), finishedAt: null as string | null,
    plannedSubmissions: options.scenarios.reduce((sum, size) => sum + size.writers * options.rounds, 0),
    attemptedSubmissions: 0, notStartedSubmissions: options.scenarios.reduce((sum, size) => sum + size.writers * options.rounds, 0),
    phase: 'configured', revision, dirty, nodeVersion: process.versions.node, platform: process.platform, architecture: process.arch,
    deploymentRevision: options.deploymentRevision, bundleSha256: options.bundleSha256,
    provenanceSource: 'deployment revision and artifact hash are caller-supplied, not independently verified by this controller',
    region: configuration.region, endpoint: configuration.baseURL, model: configuration.model,
    clock: 'performance.now; client monotonic milliseconds from controller start; no server clock subtraction',
    options, execution: { tools: [], environment: 'none', reply: 'tiny acknowledgement', warmCold: 'unclassified',
      classificationEvidence: 'No per-invocation platform initialization evidence is available; baseline completion does not classify later requests as warm.' },
    boundaries: ['Submission starts immediately before fetch after token preparation; acknowledgement is response headers.',
      'Peer visibility requires receipt actor subject plus exact fixture message through message_ids.',
      'Progress requires new assistant text or tool Item in a receipt-linked Turn absent from the pre-round baseline. Shared-Turn attribution is ambiguous.',
      'Connection occupancy is client request-to-close time, not Lambda billed duration. Stream byte counts are decoded HTTP body bytes, not wire/TLS bytes.',
      'Desktop mode models activity HTTP cadence and authority polling; it is not a native UI test or complete UI workload.',
      'Each scenario has a distinct space; explicit rounds can reach the unchanged owner rate limit. No submission retries.',
      'Percentiles exclude censored/error samples; retained counts and individual samples are required context.'],
    provisionalTargets: { durableAcknowledgementP95Ms: 500, durableAcknowledgementP99Ms: 1500, peerInputP95Ms: 1000, peerInputP99Ms: 2000 },
    desktopPlayback: options.streamMode === 'desktop' ? { activityFrameLimit: 1, reconnectMs: 50, streamTimeoutMs: 20_000, idleSnapshotDelayMs: 1_000,
      forcedSnapshotMs: 15_000, authorityRefreshMs: 2_000, runtimeOnSnapshot: true, source: 'desktop/src/api.rs and desktop/src/app.rs at recorded revision' } : null,
    scenarios: [] as ScenarioResult[], cleanup: {} as Record<string, string>, errors: [] as { phase: string; kind: string }[],
    retained: 'Spaces and stack resources require the deployment owner teardown; this controller deletes Sessions, Agents and Cognito users.',
  };
  let persistence = Promise.resolve();
  const save = (phase: string) => {
    artifact.phase = phase;
    const text = `${JSON.stringify(artifact, null, 2)}\n`;
    persistence = persistence.catch(() => undefined).then(async () => {
      await mkdir(dirname(options.output), { recursive: true, mode: 0o700 });
      const temporary = `${options.output}.tmp`;
      await writeFile(temporary, text, { mode: 0o600 }); await rename(temporary, options.output);
    });
    return persistence;
  };
  await save('configured');
  let identities: Awaited<ReturnType<typeof createTeamIdentities>> | undefined;
  let identitiesAttempted = false;
  try {
    identitiesAttempted = true; await save('identity_setup');
    const maxWriters = Math.max(...options.scenarios.map(value => value.writers));
    const maxViewers = Math.max(...options.scenarios.map(value => value.viewers));
    identities = await createTeamIdentities(configuration.fixture, configuration.region,
      ['manager', ...Array.from({ length: maxWriters }, (_, index) => `writer-${index}`), ...Array.from({ length: maxViewers }, (_, index) => `viewer-${index}`)]);
    const manager = identities.users[0]!;
    const writers = identities.users.slice(1, maxWriters + 1);
    const viewers = identities.users.slice(maxWriters + 1);
    const operator = createAgentsClient({ baseURL: configuration.operatorURL, region: configuration.region }).withOptions({ maxRetries: 0, timeout: 30_000 });
    for (const size of options.scenarios) {
      if (signal.aborted) throw new Error('interrupted');
      const result: ScenarioResult = { id: `aws-performance-${randomUUID()}`, ...size, status: 'running', phase: 'setup', startedAt: new Date().toISOString(), finishedAt: null, samples: [], observers: [], phases: [], errors: [], cleanup: {}, turns: [] };
      artifact.scenarios.push(result);
      const phase = async (name: string) => { result.phase = name; result.phases.push({ phase: name, atMs: now(), atUtc: new Date().toISOString() }); await save(`${size.writers}x${size.viewers}:${name}`); };
      const watches: ReturnType<typeof observeActivity>[] = [];
      const works = new Map<string, Workload>();
      let latest: Activity | undefined;
      let baselineTurnIds: string[] = [];
      const request = async (identity: TestTeamIdentity, path: string, method = 'GET', body?: unknown, requestSignal: AbortSignal = signal, headers: Record<string, string> = {}) => fetch(`${configuration.baseURL}${path}`, {
        method, redirect: 'error', signal: requestSignal,
        headers: { authorization: `Bearer ${await identity.accessTokenForRequest()}`, 'X-Rat-Space': result.spaceId!, 'content-type': 'application/json', ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const json = async <T>(identity: TestTeamIdentity, path: string, method = 'GET', body?: unknown, requestSignal?: AbortSignal): Promise<T> => {
        const response = await request(identity, path, method, body, AbortSignal.any([requestSignal ?? signal, AbortSignal.timeout(30_000)]));
        if (!response.ok) { await response.body?.cancel(); throw new Error(`http_${response.status}`); }
        return (response.status === 204 ? undefined : await response.json()) as T;
      };
      const client = new OpenAI({ baseURL: configuration.baseURL, apiKey: manager.accessTokenForRequest, maxRetries: 0, timeout: 30_000,
        defaultHeaders: { 'X-Rat-Space': '' } });
      const headers = () => ({ 'X-Rat-Space': result.spaceId! });
      const read = async (requestSignal?: AbortSignal) => { latest = await json<Activity>(manager, `/rat/sessions/${result.sessionId}/activity`, 'GET', undefined, requestSignal); return latest; };
      const drain = async (deadlineMs: number, predicate: (value: Activity) => boolean, requestSignal = signal) => {
        while (now() < deadlineMs) {
          if (requestSignal.aborted) throw new Error('interrupted');
          const activity = await read(AbortSignal.any([requestSignal, AbortSignal.timeout(Math.max(1, Math.ceil(deadlineMs - now())))]));
          if (now() > deadlineMs) throw new Error('timeout');
          if (predicate(activity)) return activity;
          await delay(500, undefined, { signal: requestSignal });
        }
        throw new Error('timeout');
      };
      try {
        await phase('setup');
        const space = await operator.post<{ id: string }>('/rat/spaces', { body: { name: result.id,
          manager: { issuer: manager.issuer, subject: manager.subject, label: 'Performance manager' } } });
        result.spaceId = space.id; await phase('space_created');
        for (const [people, role] of [[writers.slice(0, size.writers), 'collaborator'], [viewers.slice(0, size.viewers), 'viewer']] as const) {
          for (const person of people) await json(manager, `/rat/spaces/${space.id}/bindings`, 'POST', { issuer: person.issuer, subject: person.subject, role, label: role });
        }
        await json(manager, `/rat/spaces/${space.id}/execution-roles/default`, 'PUT', { name: 'Performance capabilities', models: [configuration.model], tools: [],
          environments: [{ type: 'none' }], vault_ids: [], capability_profile_ids: [], connection_grant_ids: [] });
        const agent = await client.beta.agents.create({ name: result.id, model: configuration.model, tools: [], instructions: 'Reply with exactly OK. Do not repeat the input. Keep every response to one word.' }, { headers: headers() });
        result.agentId = agent.id; await phase('agent_created');
        await json(manager, `/rat/agents/${agent.id}/workload`, 'PUT', { execution_role_id: 'default' });
        const initialStart = now();
        result.initialSession = { acknowledgementMs: null, firstProgressMs: null, completedMs: null, startedAt: new Date().toISOString(), observedUntilMs: 0,
          boundary: 'create request start to manager-observed progress; snapshots polled every 500ms plus request time; cold/warm unclassified' };
        const session = await client.beta.agents.sessions.create({ agent_id: agent.id, environment: { type: 'none' }, input: 'Initialize. Reply OK.' }, { headers: headers() });
        result.initialSession.acknowledgementMs = now() - initialStart;
        result.sessionId = session.id; await phase('session_created');
        const baseline = await drain(now() + options.timeoutMs, activity => {
          result.initialSession!.observedUntilMs = now() - initialStart;
          if (activity.items.some(actualProgress)) result.initialSession!.firstProgressMs ??= now() - initialStart;
          return activity.turns.length > 0 && settled(activity);
        });
        result.initialSession.completedMs = now() - initialStart;
        baselineTurnIds = baseline.turns.map(turn => turn.id);
        if (baseline.turns.some(turn => turn.status !== 'completed')) throw new Error('turn_failed');
        await phase('baseline_complete');
        await phase('observers_connecting');
        for (const [index, identity] of viewers.slice(0, size.viewers).entries()) {
          const peer = `viewer-${index}`;
          const watch = observeActivity({ peer, sessionId: session.id, mode: options.streamMode, now, signal,
            request: (path, requestSignal, extra) => request(identity, path, 'GET', undefined, requestSignal, extra),
            onActivity: (activity, receivedMs) => {
              for (const sample of result.samples) {
                const work = works.get(sample.id); if (!work) continue;
                sample.peers = sample.peers.map(previous => previous.peer === peer ? observePeer(previous, activity, work, receivedMs) : previous);
              }
            } });
          watches.push(watch); result.observers.push(watch.measure);
        }
        let readyTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([Promise.all(watches.map(watch => watch.ready)), new Promise<never>((_resolve, reject) => {
            readyTimer = setTimeout(() => reject(new Error('timeout')), Math.min(30_000, options.timeoutMs));
          })]);
        } finally { clearTimeout(readyTimer); }
        await phase('observers_ready');
        for (let round = 1; round <= options.rounds; round += 1) {
          const before = await read();
          const tokens = await Promise.all(writers.slice(0, size.writers).map(identity => identity.accessTokenForRequest()));
          const entries = writers.slice(0, size.writers).map((identity, index) => {
            const id = randomUUID(); const text = `Sample ${id}. Reply OK.`;
            const body = JSON.stringify(eventBody(text));
            const work: Workload = { id, subject: identity.subject, text, startedMs: 0, baselineTurns: before.turns.map(turn => turn.id), baselineItems: before.items.map(itemKey) };
            const sample: Sample = { id, writer: `writer-${index}`, round, startedMs: 0, payloadBytes: Buffer.byteLength(body), textSha256: digest(text), acknowledgement: { state: 'pending' },
              peers: result.observers.map(observer => ({ peer: observer.peer, input: { state: 'pending' }, progress: { state: 'pending' } })) };
            works.set(id, work); result.samples.push(sample);
            return { sample, work, body, token: tokens[index]! };
          });
          await phase(`round_${round}_prepared`);
          const roundStart = now();
          await Promise.all(entries.map(async ({ sample, work, body, token }) => {
            sample.startedMs = work.startedMs = now();
            artifact.attemptedSubmissions += 1;
            artifact.notStartedSubmissions = artifact.plannedSubmissions - artifact.attemptedSubmissions;
            sample.deadlineMs = work.deadlineMs = roundStart + options.timeoutMs;
            const timeout = AbortSignal.timeout(Math.min(180_000, options.timeoutMs));
            try {
              const response = await fetch(`${configuration.baseURL}/agents/sessions/${session.id}/events`, { method: 'POST', redirect: 'error',
                signal: AbortSignal.any([signal, timeout]), headers: { authorization: `Bearer ${token}`, 'X-Rat-Space': space.id, 'content-type': 'application/json', 'idempotency-key': sample.id }, body });
              sample.acknowledgement = { state: response.ok ? 'accepted' : 'rejected', latencyMs: now() - sample.startedMs, httpStatus: response.status };
              await response.body?.cancel();
            } catch { sample.acknowledgement = { state: timeout.aborted ? 'timeout' : 'error', latencyMs: now() - sample.startedMs, error: signal.aborted ? 'interrupted' : timeout.aborted ? 'request_timeout' : 'transport_error' }; }
          }));
          await phase(`round_${round}_acknowledged`);
          await drain(roundStart + options.timeoutMs, activity => {
            if (watches.some(watch => watch.measure.errors.length)) throw new Error('observer_failure');
            if (settled(activity) && (activity.turns.some(turn => turn.status !== 'completed') || activity.inputs.some(input => input.status === 'failed'))) throw new Error('turn_failed');
            if (entries.some(({ work }) => receiptFor(activity, work).length > 1)) throw new Error('receipt_mismatch');
            return settled(activity)
              && entries.every(({ sample, work }) => sample.acknowledgement.state !== 'accepted' || receiptFor(activity, work).length === 1)
              && entries.every(({ sample }) => sample.acknowledgement.state !== 'accepted'
                || sample.peers.every(peer => peer.input.state === 'observed' && peer.progress.state === 'observed'));
          });
          if (latest!.turns.some(turn => turn.status !== 'completed') || latest!.inputs.some(input => input.status === 'failed')) throw new Error('turn_failed');
          if (watches.some(watch => watch.measure.errors.length)) throw new Error('observer_failure');
          result.samples = result.samples.map(sample => finishSample(sample, now(), latest, sample.acknowledgement.state === 'rejected' ? 'submission_rejected' : 'submission_not_confirmed'));
          await phase(`round_${round}_complete`);
        }
        result.status = result.samples.every(sample => sample.acknowledgement.state === 'accepted') ? 'passed' : 'failed';
      } catch (error) { result.status = 'failed'; result.errors.push({ phase: result.phase, kind: safeFailure(error) }); }
      finally {
        await phase('cleanup').catch(() => { result.status = 'failed'; result.errors.push({ phase: 'cleanup', kind: 'artifact_write_failed' }); });
        await Promise.all(watches.map(watch => watch.stop()));
        result.samples = result.samples.map(sample => finishSample(sample, now(), latest, signal.aborted ? 'interrupted' : 'scenario_ended_before_observation'));
        result.cleanup.observers = 'complete';
        if (watches.some(watch => watch.measure.errors.length || watch.measure.auxiliaryErrors.length)) result.status = 'failed';
        const cleanupSignal = AbortSignal.timeout(60_000);
        const actions: (readonly [string, () => Promise<unknown>])[] = [];
        if (result.sessionId && result.status !== 'passed') {
          actions.push(['cancel', () => json(manager, `/agents/sessions/${result.sessionId}/events`, 'POST', { events: [{ type: 'agent.session.input.cancel' }] }, cleanupSignal)]);
          actions.push(['drain', () => drain(now() + 30_000, settled, cleanupSignal)]);
        }
        if (result.sessionId) actions.push(['session', () => client.beta.agents.sessions.delete(result.sessionId!, { headers: headers(), signal: cleanupSignal })]);
        if (result.agentId) actions.push(['agent', () => client.beta.agents.delete(result.agentId!, { headers: headers(), signal: AbortSignal.timeout(30_000) })]);
        Object.assign(result.cleanup, await cleanupActions(actions));
        if (Object.values(result.cleanup).includes('failed')) result.status = 'failed';
        result.turns = latest?.turns.map(turn => ({ id: turn.id, status: turn.status, baseline: baselineTurnIds.includes(turn.id), usage: turn.usage })) ?? [];
        result.summary = summarize(result.samples, size.writers * options.rounds);
        const connections = result.observers.flatMap(observer => observer.connections);
        result.cost = { streamConnectionMs: connections.filter(connection => connection.kind === 'stream').reduce((sum, value) => sum + (value.occupancyMs ?? 0), 0),
          streamBytes: connections.filter(connection => connection.kind === 'stream').reduce((sum, value) => sum + value.bytes, 0),
          snapshotBytes: connections.filter(connection => connection.kind === 'snapshot').reduce((sum, value) => sum + value.bytes, 0),
          observerHttpConnectionMs: connections.reduce((sum, value) => sum + (value.occupancyMs ?? 0), 0), lambdaMemoryMb: options.lambdaMemoryMb, usd: null };
        result.finishedAt = new Date().toISOString(); await phase('finished');
      }
    }
    artifact.status = artifact.scenarios.every(scenario => scenario.status === 'passed') ? 'passed' : 'failed';
  } catch (error) { artifact.status = 'failed'; artifact.errors.push({ phase: artifact.phase, kind: safeFailure(error) }); }
  finally {
    const cleanup = await cleanupActions([['identities', async () => { await identities?.close(); }]]);
    artifact.cleanup = { ...cleanup, ...(identitiesAttempted && !identities ? { identities: 'unconfirmed' } : {}) };
    if (Object.values(artifact.cleanup).some(value => value !== 'complete')) artifact.status = 'failed';
    artifact.finishedAt = new Date().toISOString(); await save('finished');
  }
  return artifact;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const stop = new AbortController();
  const interrupt = () => stop.abort();
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    const result = await run(parseArguments(process.argv.slice(2)), process.env, stop.signal);
    console.log(JSON.stringify({ status: result.status, output: result.options.output, scenarios: result.scenarios.map(value => ({ writers: value.writers, viewers: value.viewers, status: value.status, summary: value.summary })) }));
    if (result.status !== 'passed') process.exitCode = 1;
  } catch { console.error('AWS performance controller could not finish. Check arguments, opt-ins, and retained evidence.'); process.exitCode = 1; }
  finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
}
