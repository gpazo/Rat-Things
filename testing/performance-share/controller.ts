import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { unzipSync } from 'fflate';
import { LocalShareService } from '../../src/app/local-share.js';
import type { SessionActivity } from '../../src/core/session-activity.js';
import type { SessionShareManifest, ShareStageRequest, ShareStatus } from '../../src/core/session-share-types.js';
import { createAgentsClient } from '../../src/agents-client.js';
import { createTeamIdentities } from '../aws/team-identities.js';
import { cleanupActions, liveConfiguration } from '../performance-aws/controller.js';
import { createSource, generatedWorkspace, sha256, shareMetric } from './source.js';

export interface Options { output: string; sizesMiB: number[]; timeoutMs: number; verifyDownload: boolean; deploymentRevision: string | null }
export function parseArguments(args: string[]): Options {
  const { values } = parseArgs({ args, options: Object.fromEntries(['output', 'sizes-mib', 'timeout-ms', 'verify-download', 'deployment-revision'].map(name => [name, { type: 'string' as const }])) });
  if (!values.output) throw new Error('--output is required.');
  const sizesMiB = String(values['sizes-mib'] ?? '1,10,40').split(',').map(Number);
  if (!sizesMiB.length || new Set(sizesMiB).size !== sizesMiB.length || sizesMiB.some(size => ![1, 10, 40].includes(size))) throw new Error('Sizes must be distinct entries from 1,10,40.');
  const timeoutMs = Number(values['timeout-ms'] ?? 600_000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 900_000) throw new Error('Invalid timeout.');
  const verify = String(values['verify-download'] ?? 'true');
  if (!['true', 'false'].includes(verify)) throw new Error('Invalid download verification choice.');
  const deploymentRevision = values['deployment-revision'] === undefined ? null : String(values['deployment-revision']);
  if (deploymentRevision !== null && !/^[a-f0-9]{40}$/.test(deploymentRevision)) throw new Error('Deployment revision requires full Git SHA.');
  return { output: resolve(String(values.output)), sizesMiB, timeoutMs, verifyDownload: verify === 'true', deploymentRevision };
}

export async function bounded<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('timeout')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
const safeError = (error: unknown) => error instanceof Error && /^(timeout|interrupted|share_failed|source_setup_cleanup_unconfirmed|http_\d{3})$/.test(error.message) ? error.message : 'verification_or_controller_failure';
interface RequestSpan { phase: 'upload' | 'stage' | 'activate' | 'other'; startedMs: number; durationMs?: number; requestBytes: number; status?: number; outcome?: string }
interface Cell {
  mib: number; status: 'pending' | 'running' | 'passed' | 'failed'; phase: string; startedAt: string | null; finishedAt: string | null;
  source?: { directory: string; sessionId: string; agentId: string; historySha256: string };
  payload?: ReturnType<typeof generatedWorkspace>['evidence']; spaceId?: string; shareId?: string;
  transfer?: { startedMs: number; completedMs?: number; durationMs?: number; censoredMs?: number; deadlineExceeded?: boolean; pollIntervalMs: number };
  states: { state: string; atMs: number; atUtc: string }[];
  requests: RequestSpan[]; metrics: NonNullable<ReturnType<typeof shareMetric>>[];
  workspace?: SessionShareManifest['workspace']; uploadedFiles: { id: string; bytes: number }[];
  destinationShare?: { status: ShareStatus['status'] | 'unknown'; checkedAtUtc: string; httpStatus?: number };
  destinationSessionDeleteStatus?: number;
  verification?: { sameSession: true; sameAgent: true; sameHistory: true; sourceFenced: true; sourceExecutorClosed: true; archiveDownloaded: boolean; archiveBytes: number | null };
  cleanup: Record<string, string>; uploadedFileCleanup?: Record<string, string>; error?: string; failurePhase?: string;
}

export async function run(options: Options, environment: NodeJS.ProcessEnv = process.env, signal = new AbortController().signal) {
  const config = liveConfiguration(environment);
  const origin = performance.now(); const now = () => performance.now() - origin;
  const artifact = {
    schemaVersion: 1, kind: 'fixture-source-to-real-aws-share-performance', status: 'running', startedAt: new Date().toISOString(), finishedAt: null as string | null,
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()),
    deploymentRevision: options.deploymentRevision, deploymentProvenance: 'caller supplied; independently verify deployed artifacts',
    node: process.version, region: config.region, endpoint: config.baseURL, model: config.model, options,
    boundaries: {
      real: ['LocalShareService', 'encrypted SQLite', 'AgentService/SessionService', 'EnvironmentTemplateService/EnvironmentService', 'ZIP archive and chunk upload', 'Cognito authentication', 'AWS shared API staging/release/activation', 'downloaded upload integrity when enabled'],
      fixtures: ['completed source execution', 'in-memory portable snapshot from pre-generated random bytes'],
      excluded: ['native VM workspace export', 'guest extraction/continuation readiness', 'model latency or token cost', 'native desktop UI', 'USD/billed cost'],
      timing: 'monotonic create call through first observed complete; includes archive, production local persistence, uploads and control operations plus nominal 25ms polling, event-loop scheduling and observer overhead. Payload generation and verification are outside this timer.',
      warmCold: 'unclassified; no inference from scenario order',
    },
    cells: options.sizesMiB.map(mib => ({ mib, status: 'pending', phase: 'not_started', startedAt: null, finishedAt: null, states: [], requests: [], metrics: [], uploadedFiles: [], cleanup: {} } satisfies Cell)) as Cell[],
    cleanup: {} as Record<string, string>, errors: [] as string[],
    retained: 'Spaces, Share records and any failed destination cleanup require deployment teardown. Failed local cleanup retains its private source directory.',
  };
  let writes = Promise.resolve();
  const save = () => {
    const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
    writes = writes.catch(() => undefined).then(async () => { await mkdir(dirname(options.output), { recursive: true, mode: 0o700 });
      await writeFile(`${options.output}.tmp`, serialized, { mode: 0o600 }); await rename(`${options.output}.tmp`, options.output); });
    return writes;
  };
  await save();
  let identities: Awaited<ReturnType<typeof createTeamIdentities>> | undefined;
  let identityAttempted = false;
  try {
    identityAttempted = true;
    identities = await createTeamIdentities(config.fixture, config.region, ['share-performance-manager']);
    const manager = identities.users[0]!;
    const operator = createAgentsClient({ baseURL: config.operatorURL, region: config.region }).withOptions({ maxRetries: 0, timeout: 30_000 });
    for (const cell of artifact.cells) {
      if (signal.aborted) throw new Error('interrupted');
      cell.startedAt = new Date().toISOString(); cell.status = 'running';
      let source: Awaited<ReturnType<typeof createSource>> | undefined;
      let share: LocalShareService | undefined;
      let sourceAttempted = false;
      let transferStarted: number | undefined;
      let shareDigest: string | undefined;
      const originalInfo = console.info;
      const request = async (path: string, method = 'GET', body?: unknown, requestSignal = signal) => fetch(`${config.baseURL}${path}`, {
        method, signal: AbortSignal.any([requestSignal, AbortSignal.timeout(120_000)]), redirect: 'error',
        headers: { authorization: `Bearer ${await manager.accessTokenForRequest()}`, 'X-Rat-Space': cell.spaceId!, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const json = async <T>(path: string, method = 'GET', body?: unknown, requestSignal?: AbortSignal): Promise<T> => {
        const response = await request(path, method, body, requestSignal);
        if (!response.ok) { await response.body?.cancel(); throw new Error(`http_${response.status}`); }
        return (response.status === 204 ? undefined : await response.json()) as T;
      };
      const phase = async (name: string) => { cell.phase = name; cell.states.push({ state: name, atMs: now(), atUtc: new Date().toISOString() }); await save(); };
      try {
        await phase('generating_source');
        const workspace = generatedWorkspace(cell.mib); cell.payload = workspace.evidence;
        sourceAttempted = true; source = await createSource(config.model);
        cell.source = { directory: source.directory, sessionId: source.session.id, agentId: source.agent.id, historySha256: sha256(JSON.stringify(source.history.items)) };
        const space = await operator.post<{ id: string }>('/rat/spaces', { body: { name: `share-performance-${randomUUID()}`, manager: { issuer: manager.issuer, subject: manager.subject } } });
        cell.spaceId = space.id; await phase('destination_setup');
        await json(`/rat/spaces/${space.id}/execution-roles/portable`, 'PUT', { name: 'Portable fixture workspace', models: [config.model], tools: [],
          environments: [{ type: 'openai_hosted', network: { access: 'disabled' } }], vault_ids: [], capability_profile_ids: [], connection_grant_ids: [] });
        const baseURL = `${new URL(config.baseURL).origin}/v1`;
        assert.equal(config.baseURL, baseURL, 'Share expects the deployment /v1 API URL.');
        const transport: typeof fetch = async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          const stage = url.pathname.endsWith('/rat/shares') && init?.method === 'POST';
          if (stage) {
            const staged = JSON.parse(String(init?.body)) as ShareStageRequest;
            shareDigest = staged.digest;
            cell.workspace = staged.manifest.workspace;
            assert.deepEqual(staged.workspace_file_ids, cell.uploadedFiles.map(file => file.id));
          }
          if (init?.method === 'DELETE' && url.pathname.includes('/rat/shares/')) shareDigest = (JSON.parse(String(init.body)) as { digest: string }).digest;
          const file = init?.body instanceof FormData ? init.body.get('file') : null;
          const span: RequestSpan = { phase: file instanceof Blob ? 'upload' : stage ? 'stage' : url.pathname.endsWith('/activate') ? 'activate' : 'other',
            startedMs: now(), requestBytes: file instanceof Blob ? file.size : typeof init?.body === 'string' ? Buffer.byteLength(init.body) : 0 };
          cell.requests.push(span);
          const headers = new Headers(init?.headers); headers.set('authorization', `Bearer ${await manager.accessTokenForRequest()}`); headers.set('X-Rat-Space', space.id);
          try {
            const response = await fetch(input, { ...init, headers, signal: AbortSignal.any([...(init?.method === 'DELETE' ? [] : [signal]), ...(init?.signal ? [init.signal] : [])]), redirect: 'error' });
            span.status = response.status;
            if (response.ok && file instanceof Blob) {
              const uploaded = await response.clone().json() as { id: string };
              assert.match(uploaded.id, /^file[_-][a-zA-Z0-9_-]+$/);
              cell.uploadedFiles.push({ id: uploaded.id, bytes: file.size });
            }
            span.outcome = response.ok ? 'success' : 'http_error'; return response;
          } catch (error) { span.outcome = 'transport_or_verification_error'; throw error; }
          finally { span.durationMs = now() - span.startedMs; void save().catch(() => { artifact.errors.push('artifact_write_failed'); }); }
        };
        console.info = (...args: unknown[]) => {
          if (args.length === 1 && typeof args[0] === 'string') {
            try { const value = shareMetric(JSON.parse(args[0])); if (value) cell.metrics.push(value); } catch { /* Ignore other logs. */ }
          }
          originalInfo(...args);
        };
        share = new LocalShareService({ store: source.store, sessions: source.sessions, environments: source.environments, owner: source.owner,
          snapshot: async () => workspace.files, connection: async () => ({ baseURL, fetch: transport }) });
        cell.shareId = randomUUID(); await phase('transfer_prepared');
        transferStarted = now(); cell.phase = 'transferring'; cell.transfer = { startedMs: transferStarted, pollIntervalMs: 25 };
        const plan = await share.create({ id: cell.shareId, session_id: source.session.id, endpoint: new URL(config.baseURL).origin, space_id: space.id, connection_id: 'performance-memory-only', region: config.region });
        let status = plan.status;
        while (true) {
          if (signal.aborted) throw new Error('interrupted');
          const current = await share.retrieve(plan.id);
          if (current.status !== status) { status = current.status; cell.states.push({ state: status, atMs: now(), atUtc: new Date().toISOString() }); void save().catch(() => { artifact.errors.push('artifact_write_failed'); }); }
          if (current.status === 'failed') throw new Error('share_failed');
          if (current.status === 'complete') {
            const completed = now(); cell.transfer.completedMs = completed; cell.transfer.durationMs = completed - transferStarted;
            if (cell.transfer.durationMs > options.timeoutMs) { cell.transfer.deadlineExceeded = true; throw new Error('timeout'); }
            assert.equal(current.destination_session_id, source.session.id); assert.equal(current.can_abort, false); break;
          }
          if (now() - transferStarted >= options.timeoutMs) throw new Error('timeout');
          await delay(25, undefined, { signal });
        }
        await bounded(share.close(), 30_000);
        console.info = originalInfo;
        await phase('verification');
        const hosted = await json<SessionActivity>(`/rat/sessions/${source.session.id}/activity`);
        assert.equal(hosted.session.id, source.session.id); assert.deepEqual(hosted.session.agent, source.history.session.agent);
        assert.deepEqual(hosted.turns, source.history.turns); assert.deepEqual(hosted.items, source.history.items);
        await assert.rejects(source.sessions.events(source.owner, source.session.id, { events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: 'This source must remain fenced.' }] }] }] }), (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'session_shared'));
        assert.equal(source.executorClosed(), true);
        let archiveBytes: number | null = null;
        if (options.verifyDownload) {
          assert(cell.workspace); const parts: Buffer[] = [];
          for (const [index, file] of cell.uploadedFiles.entries()) {
            const response = await request(`/files/${file.id}/content`);
            if (!response.ok) { await response.body?.cancel(); throw new Error(`http_${response.status}`); }
            const bytes = Buffer.from(await response.arrayBuffer());
            assert.equal(bytes.length, cell.workspace.parts[index]!.bytes); assert.equal(sha256(bytes), cell.workspace.parts[index]!.sha256); parts.push(bytes);
          }
          const archive = Buffer.concat(parts); archiveBytes = archive.length;
          assert.equal(sha256(archive), cell.workspace.sha256);
          const restored = unzipSync(archive);
          assert.deepEqual(Object.keys(restored), ['payload.bin']);
          assert.equal(restored['payload.bin']!.length, cell.payload.bytes); assert.equal(sha256(restored['payload.bin']!), cell.payload.sha256);
        }
        cell.verification = { sameSession: true, sameAgent: true, sameHistory: true, sourceFenced: true, sourceExecutorClosed: true, archiveDownloaded: options.verifyDownload, archiveBytes };
        cell.status = 'passed';
      } catch (error) {
        cell.status = 'failed'; cell.failurePhase = cell.phase; cell.error = safeError(error);
        if (transferStarted !== undefined && cell.transfer?.completedMs === undefined) cell.transfer!.censoredMs = now() - transferStarted;
      } finally {
        await phase('cleanup').catch(() => { cell.status = 'failed'; artifact.errors.push('artifact_write_failed'); });
        if (cell.status !== 'passed' && share && cell.shareId) {
          Object.assign(cell.cleanup, await cleanupActions([['pendingShareAbort', async () => {
            if ((await share!.retrieve(cell.shareId!)).can_abort) await bounded(share!.abort(cell.shareId!), 30_000);
          }]]));
        }
        const local = await cleanupActions([['shareService', async () => { if (share) await bounded(share.close(), 30_000); }]]);
        console.info = originalInfo;
        Object.assign(cell.cleanup, local);
        // Aborting fetch only closes the client. An already-admitted Lambda may still activate later.
        // Only a terminal Share record makes a subsequent Session absence authoritative.
        let destinationStatus: ShareStatus['status'] | 'unknown' = 'unknown';
        if (cell.spaceId && cell.source && cell.shareId) {
          cell.destinationShare = { status: 'unknown', checkedAtUtc: new Date().toISOString() };
          try {
            const response = await request(`/rat/shares/${cell.shareId}`, 'GET', undefined, AbortSignal.timeout(30_000));
            cell.destinationShare.httpStatus = response.status;
            if (response.ok) {
              const state = await response.json() as ShareStatus;
              assert.equal(state.id, cell.shareId); assert.equal(state.session_id, cell.source.sessionId);
              assert(shareDigest !== undefined); assert.equal(state.digest, shareDigest);
              assert(['staged', 'activating', 'active', 'aborted'].includes(state.status));
              destinationStatus = state.status; cell.destinationShare.status = destinationStatus;
            } else await response.body?.cancel();
          } catch { /* Unknown is retained; never infer remote cancellation from a client abort. */ }
          cell.cleanup.destinationActivation = ['active', 'aborted'].includes(destinationStatus) && local.shareService === 'complete' ? 'complete' : 'unconfirmed';
        }
        const remote: (readonly [string, () => Promise<unknown>])[] = [];
        const remove = async (path: string) => { const response = await request(path, 'DELETE', undefined, AbortSignal.timeout(30_000));
          await response.body?.cancel(); if (!response.ok && response.status !== 404) throw new Error('cleanup_failed'); return response.status; };
        if (cell.spaceId && cell.source) {
          remote.push(['destinationSession', async () => { cell.destinationSessionDeleteStatus = await remove(`/agents/sessions/${cell.source!.sessionId}`); }]);
          remote.push(['destinationAgent', () => remove(`/agents/${cell.source!.agentId}`)]);
        }
        Object.assign(cell.cleanup, await cleanupActions(remote));
        if (cell.cleanup.destinationActivation === 'unconfirmed') {
          if (cell.cleanup.destinationSession === 'complete') cell.cleanup.destinationSession = 'unconfirmed';
          if (cell.cleanup.destinationAgent === 'complete') cell.cleanup.destinationAgent = 'unconfirmed';
        }
        const filesRetired = local.shareService === 'complete' && (destinationStatus === 'aborted'
          || destinationStatus === 'active' && cell.cleanup.destinationSession === 'complete');
        if (filesRetired) {
          const files = await cleanupActions(cell.uploadedFiles.map(file => [file.id, () => remove(`/files/${file.id}`)] as const));
          cell.uploadedFileCleanup = files;
          cell.cleanup.uploadedFiles = cell.requests.some(span => span.phase === 'upload' && span.outcome !== 'success') ? 'unconfirmed'
            : Object.values(files).some(value => value !== 'complete') ? 'failed' : 'complete';
        } else if (cell.uploadedFiles.length || cell.requests.some(span => span.phase === 'upload')) cell.cleanup.uploadedFiles = 'unconfirmed';
        if (source && local.shareService === 'complete') Object.assign(cell.cleanup, await cleanupActions([['source', () => bounded(source!.close(), 30_000)]]));
        else cell.cleanup.source = sourceAttempted ? 'unconfirmed' : 'not_created';
        if (Object.values(cell.cleanup).some(value => !['complete', 'not_created'].includes(value))) cell.status = 'failed';
        cell.finishedAt = new Date().toISOString(); await save();
      }
    }
    artifact.status = artifact.cells.every(cell => cell.status === 'passed') && artifact.errors.length === 0 ? 'passed' : 'failed';
  } catch (error) { artifact.status = 'failed'; artifact.errors.push(safeError(error)); }
  finally {
    artifact.cleanup = await cleanupActions([['identities', async () => { if (identities) await bounded(identities.close(), 120_000); }]]);
    if (identityAttempted && !identities) artifact.cleanup.identities = 'unconfirmed';
    if (Object.values(artifact.cleanup).some(value => value !== 'complete')) artifact.status = 'failed';
    artifact.finishedAt = new Date().toISOString(); await save();
  }
  return artifact;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const stop = new AbortController(); const interrupt = () => stop.abort();
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    const result = await run(parseArguments(process.argv.slice(2)), process.env, stop.signal);
    console.log(JSON.stringify({ output: result.options.output, status: result.status, cells: result.cells.map(cell => ({ mib: cell.mib, status: cell.status, transfer: cell.transfer })) }));
    if (result.status !== 'passed') process.exitCode = 1;
  } catch { console.error('Share performance controller could not finish; inspect retained evidence and cleanup.'); process.exitCode = 1; }
  finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
}
