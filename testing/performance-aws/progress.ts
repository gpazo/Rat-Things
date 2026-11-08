import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { createAgentsClient } from '../../src/agents-client.js';
import { oidcActorId } from '../../src/identity/principal.js';
import { createTeamIdentities, type TeamIdentityFixture, type TestTeamIdentity } from '../aws/team-identities.js';
import { digest, itemKey, observePeer, receiptFor, type Activity, type Workload } from './measurements.js';
import { observeActivity, type ObserverMeasurement } from './observer.js';

const MODES = ['persistent', 'desktop'] as const;
type Mode = typeof MODES[number];
type Side = 'before' | 'after';
const MAX_PAIRS = 5;
const WRITERS = 20;
const PERSISTENT_VIEWERS = 50;
const DESKTOP_VIEWERS = 20;
const OBSERVATION_MS = 30_000;
const RUN_LIMIT_MS = 60 * 60_000;
const MAX_BINDING_CONCURRENCY = 8;

export interface ProgressOptions {
  beforeUrl: string;
  afterUrl: string;
  operatorUrl: string;
  output: string;
  mode: Mode | 'both';
  pairs: number;
  beforeBundleSha256: string | null;
  afterBundleSha256: string | null;
}

export interface ProgressDependencies {
  /** Optional trusted fixture preparation, such as seeding old history directly in storage. */
  prepareSession?: (cell: { side: Side; mode: Mode; pair: number; spaceId: string; sessionId: string }) => Promise<void>;
}

export function parseArguments(args: readonly string[]): ProgressOptions {
  const known = ['--before-url', '--after-url', '--operator-url', '--output', '--mode', '--pairs', '--before-bundle-sha256', '--after-bundle-sha256'];
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]!;
    const value = args[index + 1];
    if (!known.includes(name) || value === undefined || value.startsWith('--') || values.has(name)) throw new Error('Invalid or duplicate progress-controller argument.');
    values.set(name, value);
  }
  const required = (name: string) => {
    const value = values.get(name);
    if (!value) throw new Error(`${name} is required.`);
    return value;
  };
  const mode = values.get('--mode') ?? 'persistent';
  if (mode !== 'persistent' && mode !== 'desktop' && mode !== 'both') throw new Error('Invalid --mode.');
  const pairsText = values.get('--pairs') ?? '5';
  const pairs = Number(pairsText);
  if (!/^\d+$/.test(pairsText) || !Number.isSafeInteger(pairs) || pairs < 1 || pairs > MAX_PAIRS) throw new Error(`--pairs must be between 1 and ${MAX_PAIRS}.`);
  const hash = (name: string) => {
    const value = values.get(name) ?? null;
    if (value !== null && !/^[a-f0-9]{64}$/i.test(value)) throw new Error(`Invalid ${name}.`);
    return value?.toLowerCase() ?? null;
  };
  return {
    beforeUrl: required('--before-url'), afterUrl: required('--after-url'), operatorUrl: required('--operator-url'),
    output: resolve(required('--output')), mode, pairs,
    beforeBundleSha256: hash('--before-bundle-sha256'), afterBundleSha256: hash('--after-bundle-sha256'),
  };
}

function endpoint(value: string, region: string, kind: 'web' | 'operator') {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port) throw new Error(`Invalid ${kind} endpoint URL.`);
  if (kind === 'web') {
    if (!url.hostname.endsWith(`.lambda-web.${region}.on.aws`) || !url.pathname.endsWith('/api/v1')) throw new Error('Use a deployed Lambda Web Function /api/v1 endpoint in the configured region.');
  } else if (!url.hostname.endsWith(`.execute-api.${region}.amazonaws.com`) || !url.pathname.endsWith('/v1')) {
    throw new Error('Use the IAM operator API Gateway /v1 endpoint in the configured region.');
  }
  return value.replace(/\/$/, '');
}

export function liveConfiguration(environment: NodeJS.ProcessEnv, options: ProgressOptions) {
  if (environment.AWS_E2E_PROGRESS !== 'true') throw new Error('Explicit AWS_E2E_PROGRESS=true is required.');
  if (environment.AWS_E2E_SHARED_SESSIONS !== 'true') throw new Error('Explicit AWS_E2E_SHARED_SESSIONS=true is required.');
  const region = environment.AWS_REGION;
  if (!region || !/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(region)) throw new Error('Missing or invalid AWS_REGION.');
  const model = environment.AWS_E2E_CODEX_MODEL_ID;
  if (!model || !/^[a-zA-Z0-9._:/-]{1,200}$/.test(model)) throw new Error('Missing or invalid AWS_E2E_CODEX_MODEL_ID.');
  if (/astra/i.test(model) || !/(?:^|[.:/-])gpt-(?:6|5\.6)-luna(?:$|[.:/-])/i.test(model)) throw new Error('Use an admitted Luna model ID; GPT-6 Astra is prohibited.');
  let fixture: TeamIdentityFixture;
  try { fixture = JSON.parse(environment.TEAM_OIDC_FIXTURE_JSON ?? '') as TeamIdentityFixture; }
  catch { throw new Error('Missing or invalid TEAM_OIDC_FIXTURE_JSON.'); }
  if (!fixture || typeof fixture !== 'object' || !fixture.user_pool_id || !fixture.issuer || !fixture.client_id || !fixture.login_origin || !fixture.redirect_uri) throw new Error('TEAM_OIDC_FIXTURE_JSON is incomplete.');
  if (!fixture.user_pool_id.startsWith(`${region}_`)) throw new Error('The configured identity pool must belong to AWS_REGION.');
  const beforeUrl = endpoint(options.beforeUrl, region, 'web');
  const afterUrl = endpoint(options.afterUrl, region, 'web');
  const operatorUrl = endpoint(options.operatorUrl, region, 'operator');
  if (beforeUrl === afterUrl) throw new Error('Before and after URLs must be different.');
  return { region, model, fixture, beforeUrl, afterUrl, operatorUrl };
}

type PeerState =
  | { state: 'pending' }
  | { state: 'observed'; latencyMs: number; acknowledgementToPeerMs: number | null; receiptId: string; messageIds: string[]; actorSubject: string }
  | { state: 'censored' | 'error' | 'notstarted'; reason: string; elapsedMs?: number };
interface InputSample {
  id: string; writer: string; textSha256: string; payloadBytes: number; startedMs: number | null; deadlineMs: number;
  acknowledgement: { state: 'pending' } | { state: 'accepted' | 'rejected'; httpStatus: number; latencyMs: number; acknowledgedAtMs: number }
    | { state: 'timeout' | 'error'; latencyMs: number; error: string } | { state: 'notstarted'; reason: string };
  peers: Array<{ peer: string; observation: PeerState }>;
  receiptMatches: number;
}
interface CellResult {
  id: string; side: Side; mode: Mode; pair: number; status: 'running' | 'passed' | 'failed'; phase: string;
  startedAt: string; finishedAt: string | null; spaceId?: string; agentId?: string; sessionId?: string;
  samples: InputSample[]; observers: ObserverMeasurement[];
  viewerMetrics: Array<{ peer: string; requests: number; decodedBytes: number; errors: number; occupancyMs: number }>;
  probes: Record<string, number | null>;
  cleanup: Record<string, string>; errors: string[];
}

const eventBody = (text: string) => ({ events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text }] }] }] });
const safeError = (error: unknown) => error && typeof error === 'object' && 'status' in error && typeof error.status === 'number'
  ? `http_${error.status}` : 'controller_failure';

async function mapBounded<T>(values: readonly T[], concurrency: number, task: (value: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < values.length) {
      const index = next++;
      await task(values[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
}

async function consumeResponse(response: Response, maximumBytes = 64 * 1024) {
  const reader = response.body?.getReader();
  if (!reader) return;
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return;
      bytes += chunk.value.byteLength;
      if (bytes > maximumBytes) throw new Error('response_body_limit');
    }
  } finally { await reader.cancel().catch(() => undefined); }
}

function sampleStatus(sample: InputSample, nowMs: number, observers: readonly ObserverMeasurement[]): InputSample {
  const failure = observers.find(observer => observer.errors.length > 0)?.errors[0];
  return { ...sample, acknowledgement: sample.acknowledgement.state === 'pending'
    ? { state: 'notstarted', reason: 'submission_not_started' } : sample.acknowledgement,
  peers: sample.peers.map(peer => {
    if (peer.observation.state !== 'pending') return peer;
    if (sample.startedMs === null) return { ...peer, observation: { state: 'notstarted', reason: 'submission_not_started' } };
    const reason = failure ? 'observer_error' : nowMs >= sample.deadlineMs ? 'observation_deadline' : 'cell_ended';
    return { ...peer, observation: { state: failure ? 'error' : 'censored', reason, elapsedMs: Math.max(0, Math.min(nowMs, sample.deadlineMs) - sample.startedMs) } };
  }) };
}

export async function run(
  options: ProgressOptions,
  environment: NodeJS.ProcessEnv = process.env,
  signal = new AbortController().signal,
  dependencies: ProgressDependencies = {},
) {
  // Validate explicit opt-ins and all endpoints before contacting AWS or deployed APIs.
  const configuration = liveConfiguration(environment, options);
  const runSignal = AbortSignal.any([signal, AbortSignal.timeout(RUN_LIMIT_MS)]);
  const modes: readonly Mode[] = options.mode === 'both' ? MODES : [options.mode];
  const plannedCells = options.pairs * modes.length * 2;
  const plannedSubmissions = plannedCells * WRITERS;
  if (plannedSubmissions > 400) throw new Error('Progress workload input cap is 400.');
  const started = performance.now();
  const now = () => performance.now() - started;
  const artifact = {
    schemaVersion: 1, kind: 'aws-web-function-peer-progress', status: 'running' as 'running' | 'passed' | 'failed',
    startedAt: new Date().toISOString(), finishedAt: null as string | null,
    plannedSubmissions, plannedSetupReceipts: plannedCells, attemptedSubmissions: 0, notStartedSubmissions: plannedSubmissions,
    plannedCells, maxWallTimeMs: RUN_LIMIT_MS, observationWindowMs: OBSERVATION_MS,
    workload: { writers: WRITERS, persistentViewers: PERSISTENT_VIEWERS, desktopViewers: DESKTOP_VIEWERS, maxConcurrentInputs: WRITERS, retries: 0,
      inputsPerCell: WRITERS, eachCellHasFreshSpaceAndSession: true, execution: 'outbox and reconciler must be disabled by deployment operator; controller makes no inference calls' },
    order: modes.flatMap(mode => Array.from({ length: options.pairs }, (_, index) => ({ mode, pair: index + 1, order: ['before', 'after'] as const }))),
    provenance: { beforeBundleSha256: options.beforeBundleSha256, afterBundleSha256: options.afterBundleSha256,
      provenanceSource: 'caller-supplied SHA-256; deployment and artifact identity must be verified externally',
      beforeEndpoint: configuration.beforeUrl, afterEndpoint: configuration.afterUrl, region: configuration.region,
      modelAdmission: configuration.model, modelCalls: 0 },
    clock: 'performance.now; controller-local monotonic milliseconds',
    metrics: ['input submission start to response body consumption', 'per-viewer exact receipt, message IDs and actor subject visibility',
      'per-viewer acknowledgement-to-peer delay', 'per-viewer decoded HTTP body bytes, connection occupancy and errors'],
    exclusions: ['assistant progress', 'assistant completion', 'model output', 'wire or TLS bytes', 'Lambda billed duration', 'CloudWatch cost'],
    cells: [] as CellResult[], cleanup: {} as Record<string, string>, errors: [] as string[],
    retainedResources: 'Space, Session or Agent cleanup failures remain explicit in each cell; the deployment owner tears down the disposable stack after evidence capture.',
  };
  let persistence = Promise.resolve();
  const save = (phase: string) => {
    const document = `${JSON.stringify({ ...artifact, phase }, null, 2)}\n`;
    persistence = persistence.catch(() => undefined).then(async () => {
      await mkdir(dirname(options.output), { recursive: true, mode: 0o700 });
      const temporary = `${options.output}.tmp`;
      await writeFile(temporary, document, { mode: 0o600 });
      await rename(temporary, options.output);
    });
    return persistence;
  };
  await save('configured');

  let identities: Awaited<ReturnType<typeof createTeamIdentities>> | undefined;
  let identitiesAttempted = false;
  try {
    identitiesAttempted = true;
    await save('identity_setup');
    identities = await createTeamIdentities(configuration.fixture, configuration.region,
      ['manager', ...Array.from({ length: WRITERS }, (_, index) => `writer-${index}`), ...Array.from({ length: PERSISTENT_VIEWERS }, (_, index) => `viewer-${index}`)]);
    const manager = identities.users[0]!;
    const writers = identities.users.slice(1, WRITERS + 1);
    const viewers = identities.users.slice(WRITERS + 1);
    const operator = createAgentsClient({ baseURL: configuration.operatorUrl, region: configuration.region }).withOptions({ maxRetries: 0, timeout: 30_000 });
    const request = async (baseUrl: string, identity: TestTeamIdentity, spaceId: string, path: string, method = 'GET', body?: unknown, requestSignal: AbortSignal = runSignal, extraHeaders: Record<string, string> = {}) => {
      const token = await identity.accessTokenForRequest();
      return fetch(`${baseUrl}${path}`, { method, redirect: 'error', signal: requestSignal,
        headers: { authorization: `Bearer ${token}`, 'X-Rat-Space': spaceId, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extraHeaders },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    };
    const json = async <T>(baseUrl: string, identity: TestTeamIdentity, spaceId: string, path: string, method = 'GET', body?: unknown): Promise<T> => {
      const response = await request(baseUrl, identity, spaceId, path, method, body, AbortSignal.any([runSignal, AbortSignal.timeout(30_000)]));
      if (!response.ok) { const status = response.status; await response.body?.cancel(); throw Object.assign(new Error('request_failed'), { status }); }
      return (response.status === 204 ? undefined : await response.json()) as T;
    };

    for (const mode of modes) for (let pair = 1; pair <= options.pairs; pair += 1) for (const side of ['before', 'after'] as const) {
      if (runSignal.aborted) throw new Error('Run interrupted or exceeded 60 minutes.');
      const baseUrl = side === 'before' ? configuration.beforeUrl : configuration.afterUrl;
      const cellViewers = viewers.slice(0, mode === 'persistent' ? PERSISTENT_VIEWERS : DESKTOP_VIEWERS);
      const cell: CellResult = { id: `progress-${mode}-${pair}-${side}-${randomUUID()}`, side, mode, pair, status: 'running', phase: 'space_setup',
        startedAt: new Date().toISOString(), finishedAt: null, samples: [], observers: [], viewerMetrics: [], probes: {}, cleanup: {}, errors: [] };
      artifact.cells.push(cell);
      const phase = async (value: string) => { cell.phase = value; await save(`${cell.id}:${value}`); };
      const watches: ReturnType<typeof observeActivity>[] = [];
      const works = new Map<string, Workload>();
      const observationsAt = new Map<string, Map<string, number>>();
      let sessionId: string | undefined;
      let agentId: string | undefined;
      let spaceId: string | undefined;
      try {
        const space = await operator.post<{ id: string }>('/rat/spaces', { body: { name: cell.id,
          manager: { issuer: manager.issuer, subject: manager.subject, label: 'Peer progress manager' } } });
        spaceId = cell.spaceId = space.id;
        const memberships = [
          ...writers.map(person => ({ person, role: 'collaborator' as const })),
          ...cellViewers.map(person => ({ person, role: 'viewer' as const })),
        ];
        await mapBounded(memberships, MAX_BINDING_CONCURRENCY, async ({ person, role }) => {
          await json(baseUrl, manager, spaceId!, `/rat/spaces/${spaceId}/bindings`, 'POST', { issuer: person.issuer, subject: person.subject, role, label: role });
        });
        await json(baseUrl, manager, spaceId, `/rat/spaces/${spaceId}/execution-roles/default`, 'PUT', { name: 'Web peer progress measurement',
          models: [configuration.model], tools: [], environments: [{ type: 'none' }], vault_ids: [], capability_profile_ids: [], connection_grant_ids: [] });
        await phase('space_ready');

        const createdAgent = await json<{ id: string }>(baseUrl, manager, spaceId, '/agents', 'POST', {
          name: cell.id, model: configuration.model, tools: [], reasoning: { effort: 'low', summary: null },
          instructions: 'This measurement must not invoke a model. Execution is disabled by the deployment operator.',
        });
        agentId = cell.agentId = createdAgent.id;
        await json(baseUrl, manager, spaceId, `/rat/agents/${agentId}/workload`, 'PUT', { execution_role_id: 'default' });
        const createdSession = await json<{ id: string }>(baseUrl, manager, spaceId, '/agents/sessions', 'POST', {
          agent_id: agentId, environment: { type: 'none' }, input: 'Reserved setup receipt. Do not execute during this measurement.',
        });
        sessionId = cell.sessionId = createdSession.id;
        if (dependencies.prepareSession) await dependencies.prepareSession({ side, mode, pair, spaceId, sessionId });
        await phase('session_ready');

        const workById = works;
        for (const [index, identity] of cellViewers.entries()) {
          const peer = `viewer-${index}`;
          const watch = observeActivity({ peer, sessionId, mode, now, signal: runSignal,
            request: async (path, requestSignal, extra) => request(baseUrl, identity, spaceId!, path, 'GET', undefined, requestSignal, extra),
            onActivity: (activity, receivedAtMs) => {
              for (const [id, work] of workById) {
                const matches = receiptFor(activity, work);
                const sample = cell.samples.find(candidate => candidate.id === id);
                if (!sample || matches.length === 0) continue;
                sample.receiptMatches = Math.max(sample.receiptMatches, matches.length);
                if (matches.length !== 1 || sample.startedMs === null || receivedAtMs > sample.deadlineMs) continue;
                const receipt = matches[0]!;
                const previous = sample.peers[index]!.observation;
                if (previous.state === 'pending') {
                  const elapsed = Math.max(0, receivedAtMs - sample.startedMs);
                  const ackAt = sample.acknowledgement.state === 'accepted' || sample.acknowledgement.state === 'rejected'
                    ? sample.acknowledgement.acknowledgedAtMs : null;
                  sample.peers[index]!.observation = { state: 'observed', latencyMs: elapsed,
                    acknowledgementToPeerMs: ackAt === null ? null : receivedAtMs - ackAt,
                    receiptId: receipt.id, messageIds: [...receipt.message_ids], actorSubject: receipt.actor.subject ?? '' };
                  let times = observationsAt.get(id);
                  if (!times) { times = new Map(); observationsAt.set(id, times); }
                  times.set(peer, receivedAtMs);
                }
                // Keep the shared pure measurement contract aligned; progress remains intentionally unreported.
                const sharedObservation = observePeer({ peer, input: { state: 'pending' }, progress: { state: 'pending' } }, activity, work, receivedAtMs);
                if (sharedObservation.input.state !== 'observed' || sharedObservation.input.receiptId !== receipt.id) sample.receiptMatches = 0;
              }
            } });
          watches.push(watch);
          cell.observers.push(watch.measure);
        }
        const readyTimeout = AbortSignal.timeout(30_000);
        await Promise.race([Promise.all(watches.map(watch => watch.ready)), new Promise<never>((_resolve, reject) => {
          readyTimeout.addEventListener('abort', () => reject(new Error('observer_ready_timeout')), { once: true });
        })]);
        const baselines = watches.map(watch => watch.latest()).filter((activity): activity is Activity => Boolean(activity));
        if (baselines.length !== cellViewers.length) throw new Error('observer_snapshot_missing');
        const baseline = baselines[0]!;
        await phase('observers_ready');

        const entries = writers.map((identity, index) => {
          const id = randomUUID();
          const text = `Peer progress fixture ${id}.`;
          const body = JSON.stringify(eventBody(text));
          const work: Workload = { id, subject: identity.subject, text, startedMs: 0, deadlineMs: OBSERVATION_MS,
            baselineTurns: baseline.turns.map(turn => turn.id), baselineItems: baseline.items.map(itemKey) };
          works.set(id, work);
          const sample: InputSample = { id, writer: `writer-${index}`, textSha256: digest(text), payloadBytes: Buffer.byteLength(body),
            startedMs: null, deadlineMs: 0, acknowledgement: { state: 'pending' }, receiptMatches: 0,
            peers: cellViewers.map((_viewer, viewerIndex) => ({ peer: `viewer-${viewerIndex}`, observation: { state: 'pending' } })) };
          cell.samples.push(sample);
          return { identity, sample, work, body };
        });
        const tokens = await Promise.all(entries.map(entry => entry.identity.accessTokenForRequest()));
        await phase('inputs_prepared');
        const submitStart = now();
        await Promise.all(entries.map(async ({ sample, work, body }, index) => {
          sample.startedMs = work.startedMs = now();
          sample.deadlineMs = work.deadlineMs = sample.startedMs + OBSERVATION_MS;
          artifact.attemptedSubmissions += 1;
          artifact.notStartedSubmissions = plannedSubmissions - artifact.attemptedSubmissions;
          const timeout = AbortSignal.timeout(30_000);
          try {
            const response = await fetch(`${baseUrl}/agents/sessions/${sessionId}/events`, { method: 'POST', redirect: 'error',
              signal: AbortSignal.any([runSignal, timeout]), headers: { authorization: `Bearer ${tokens[index]!}`, 'X-Rat-Space': spaceId!,
                'content-type': 'application/json', 'idempotency-key': sample.id }, body });
            const status = response.status;
            await consumeResponse(response);
            const ackAt = now();
            sample.acknowledgement = { state: response.ok ? 'accepted' : 'rejected', httpStatus: status, latencyMs: ackAt - sample.startedMs!, acknowledgedAtMs: ackAt };
            // Attach ack-relative values to receipts that arrived before the POST response completed.
            const observedAt = observationsAt.get(sample.id);
            if (observedAt) for (const peer of sample.peers) if (peer.observation.state === 'observed') {
              const peerAt = observedAt.get(peer.peer);
              if (peerAt !== undefined) peer.observation = { ...peer.observation, acknowledgementToPeerMs: peerAt - ackAt };
            }
          } catch {
            sample.acknowledgement = { state: timeout.aborted ? 'timeout' : 'error', latencyMs: now() - sample.startedMs!, error: runSignal.aborted ? 'interrupted' : timeout.aborted ? 'request_timeout' : 'transport_error' };
          }
        }));
        await phase('inputs_acknowledged');
        const deadline = Math.max(submitStart + OBSERVATION_MS, ...cell.samples.map(sample => sample.deadlineMs));
        while (now() < deadline && !runSignal.aborted && !cell.samples.every(sample => sample.peers.every(peer => peer.observation.state !== 'pending'))) {
          await delay(Math.min(100, deadline - now()), undefined, { signal: runSignal }).catch(() => undefined);
        }
        await Promise.all(watches.map(watch => watch.stop()));
        cell.samples = cell.samples.map(sample => sampleStatus(sample, now(), cell.observers));
        const allAccepted = cell.samples.every(sample => sample.acknowledgement.state === 'accepted');
        const allVisible = cell.samples.every(sample => sample.peers.every(peer => peer.observation.state === 'observed'));
        const exact = cell.samples.every(sample => sample.receiptMatches === 1
          && sample.peers.every(peer => peer.observation.state !== 'observed' || peer.observation.actorSubject === writers[Number(sample.writer.slice('writer-'.length))]?.subject));
        cell.status = allAccepted && allVisible && exact && cell.observers.every(observer => observer.errors.length === 0) ? 'passed' : 'failed';
        await phase('observed');

        // Check viewer write denial and membership revocation after measurement; any admitted probe input is retained as a failed security probe.
        const probeViewer = viewers[0]!;
        const probeBody = eventBody(`Peer progress authorization probe ${randomUUID()}.`);
        const statusOnly = async (operation: () => Promise<Response>) => {
          try {
            const response = await operation();
            const status = response.status;
            await response.body?.cancel().catch(() => undefined);
            return status;
          } catch (error) {
            return error && typeof error === 'object' && 'status' in error ? Number(error.status) : 0;
          }
        };
        cell.probes.viewerWriteStatus = await statusOnly(() => request(baseUrl, probeViewer, spaceId!, `/agents/sessions/${sessionId}/events`, 'POST', probeBody, AbortSignal.timeout(10_000), { 'idempotency-key': randomUUID() }));
        cell.probes.revocationStatus = await statusOnly(() => request(baseUrl, manager, spaceId!, `/rat/spaces/${spaceId}/bindings/${oidcActorId(probeViewer.issuer, probeViewer.subject)}`, 'DELETE', undefined, AbortSignal.timeout(10_000)));
        cell.probes.revokedWriteStatus = await statusOnly(() => request(baseUrl, probeViewer, spaceId!, `/agents/sessions/${sessionId}/events`, 'POST', eventBody(`Revoked peer probe ${randomUUID()}.`), AbortSignal.timeout(10_000), { 'idempotency-key': randomUUID() }));
        if (cell.probes.viewerWriteStatus !== 403 || cell.probes.revocationStatus !== 200 || cell.probes.revokedWriteStatus !== 403) cell.status = 'failed';
        await phase('probed');
      } catch (error) {
        cell.status = 'failed';
        cell.errors.push(safeError(error));
        cell.samples = cell.samples.map(sample => sampleStatus(sample, now(), cell.observers));
        for (const writer of writers) if (!cell.samples.some(sample => sample.writer === `writer-${writers.indexOf(writer)}`)) {
          cell.samples.push({ id: randomUUID(), writer: `writer-${writers.indexOf(writer)}`, textSha256: '', payloadBytes: 0, startedMs: null,
            deadlineMs: now(), acknowledgement: { state: 'notstarted', reason: 'cell_setup_failed' }, receiptMatches: 0,
          peers: cellViewers.map((_viewer, index) => ({ peer: `viewer-${index}`, observation: { state: 'notstarted', reason: 'submission_not_started' } })) });
          artifact.notStartedSubmissions -= 1;
        }
      } finally {
        await Promise.all(watches.map(watch => watch.stop().catch(() => undefined)));
        cell.viewerMetrics = cell.observers.map(observer => ({ peer: observer.peer, requests: observer.connections.length,
          decodedBytes: observer.connections.reduce((sum, connection) => sum + connection.bytes, 0),
          errors: observer.errors.length + observer.auxiliaryErrors.length + observer.connections.filter(connection => connection.outcome === 'failed' || connection.outcome === 'network_error').length,
          occupancyMs: observer.connections.reduce((sum, connection) => sum + (connection.occupancyMs ?? 0), 0) }));
        cell.cleanup.observers = 'complete';
        const cleanupSignal = AbortSignal.timeout(30_000);
        for (const [name, path] of [['session', sessionId ? `/agents/sessions/${sessionId}` : ''], ['agent', agentId ? `/agents/${agentId}` : '']] as const) {
          if (!path) { cell.cleanup[name] = 'not_created'; continue; }
          try {
            const response = await request(baseUrl, manager, spaceId!, path, 'DELETE', undefined, cleanupSignal);
            cell.cleanup[name] = response.ok ? 'complete' : `http_${response.status}`;
            await response.body?.cancel();
          } catch (error) { cell.cleanup[name] = safeError(error); }
        }
        cell.cleanup.space = 'retained_for_deployment_teardown';
        cell.finishedAt = new Date().toISOString();
        cell.observers.forEach(observer => { if (observer.errors.length || observer.auxiliaryErrors.length) cell.status = 'failed'; });
        await phase('finished').catch(() => { cell.status = 'failed'; });
      }
      if (cell.status !== 'passed') artifact.errors.push(`${cell.id}:cell_failed`);
      await save(`${cell.id}:complete`);
    }
  } catch (error) {
    artifact.status = 'failed';
    artifact.errors.push(safeError(error));
  } finally {
    try { await identities?.close(); artifact.cleanup.identities = 'complete'; }
    catch { artifact.cleanup.identities = identitiesAttempted ? 'failed' : 'not_started'; artifact.status = 'failed'; }
    if (identitiesAttempted && !identities) { artifact.cleanup.identities = 'unconfirmed'; artifact.status = 'failed'; }
    if (artifact.cells.length !== plannedCells || artifact.cells.some(cell => cell.status !== 'passed')) artifact.status = 'failed';
    artifact.notStartedSubmissions = Math.max(0, plannedSubmissions - artifact.attemptedSubmissions);
    artifact.finishedAt = new Date().toISOString();
    await save('finished');
  }
  return artifact;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  try {
    const result = await run(parseArguments(process.argv.slice(2)), process.env, controller.signal);
    process.exitCode = result.status === 'passed' ? 0 : 1;
  } catch {
    process.exitCode = 1;
  }
}
