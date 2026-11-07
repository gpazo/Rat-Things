import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { AgentsStore } from '../core/agents-ports.js';
import type { SessionService } from '../core/session-service.js';
import type { EnvironmentService } from '../core/environment-service.js';
import type { SessionShareManifest, ShareStageRequest, ShareStatus } from '../core/session-share-types.js';
import { releaseDigest, shareDigest } from '../core/session-share-service.js';
import { sessionInputs } from '../core/session-activity.js';
import { archiveWorkspace, type PortableFile } from '../domain/workspace-transfer.js';
import { AgentsApiError, resourceNotFound } from '../domain/agents-api-validation.js';
import { orderedTurnItems } from '../core/session-planning.js';
import { CODEX_RUNTIME } from '../domain/session-runtime.js';
import { canonicalJson } from '../domain/json.js';

export interface ShareDestination { baseURL: string; space_id: string; connection_id?: string; region?: string }
export interface LocalSharePlan {
  id: string;
  source_session_id: string;
  destination: ShareDestination;
  status: 'quiescing' | 'staging' | 'released' | 'complete' | 'failed' | 'aborted';
  destination_session_id: string | null;
  files: number;
  bytes: number;
  error: string | null;
  can_abort?: boolean;
}
export type ShareConnectionFactory = (input: { connection_id: string; endpoint: string; space_id: string }) => Promise<{ fetch: typeof fetch; baseURL: string }>;
interface ShareRecord {
  plan: LocalSharePlan;
  releaseToken: string;
  manifest?: SessionShareManifest;
  digest?: string;
  archive?: string;
  artifactData?: Record<string, string>;
  workspaceFileIds: string[];
  artifactFileIds: Record<string, string>;
  staged?: boolean;
}
const CHUNK_BYTES = 3 * 1024 * 1024;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const bytesDigest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export class LocalShareService {
  private readonly active = new Map<string, Promise<void>>();
  private readonly cancellations = new Map<string, AbortController>();
  private readonly stopped = new AbortController();
  public constructor(private readonly options: {
    store: AgentsStore; sessions: SessionService; environments: EnvironmentService; owner: string;
    snapshot: (id: string) => Promise<PortableFile[]>;
    connection: ShareConnectionFactory;
  }) {}

  public async create(raw: unknown): Promise<LocalSharePlan> {
    const input = raw as Record<string, unknown>;
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['id', 'session_id', 'endpoint', 'region', 'space_id', 'connection_id'].includes(key))
      || typeof input.session_id !== 'string' || typeof input.endpoint !== 'string' || typeof input.space_id !== 'string' || !input.space_id
      || typeof input.connection_id !== 'string' || !input.connection_id || input.id !== undefined && (typeof input.id !== 'string' || !uuid.test(input.id))
      || input.region !== undefined && typeof input.region !== 'string') throw new AgentsApiError(400, 'Choose a Session and a signed-in space.', 'invalid_request');
    let endpoint: URL;
    try { endpoint = new URL(input.endpoint); } catch { throw new AgentsApiError(400, 'Invalid destination endpoint.', 'invalid_request'); }
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !['', '/', '/v1', '/v1/'].includes(endpoint.pathname)) throw new AgentsApiError(400, 'Use an HTTPS Agents API endpoint.', 'invalid_request');
    const destination: ShareDestination = { baseURL: `${endpoint.origin}/v1`, space_id: input.space_id, connection_id: input.connection_id, ...(typeof input.region === 'string' ? { region: input.region } : {}) };
    const id = input.id as string | undefined ?? randomUUID();
    const previous = await this.options.store.get<ShareRecord>(this.options.owner, 'local_shares', id);
    if (previous) {
      if (previous.value.plan.source_session_id !== input.session_id || canonicalJson(previous.value.plan.destination) !== canonicalJson(destination)) throw new AgentsApiError(409, 'This Share ID belongs to a different request.', 'idempotency_conflict');
      if (!['complete', 'aborted'].includes(previous.value.plan.status)) {
        await this.options.sessions.beginShare(this.options.owner, previous.value.plan.source_session_id, id);
        this.schedule(id);
      }
      return this.retrieve(id);
    }
    await this.options.connection({ connection_id: input.connection_id, endpoint: destination.baseURL, space_id: destination.space_id });
    const session = await this.options.sessions.retrieve(this.options.owner, input.session_id);
    if (session.vault_ids.length || session.environment.type === 'self_hosted' || session.agent.tools.some(tool => !['function', 'web_search', 'programmatic_tool_calling'].includes(tool.type))) throw new AgentsApiError(400, 'This Session has source credentials or tools that cannot be shared.', 'share_incompatible');
    if (session.environment.type === 'openai_hosted') {
      const configuration = (await this.options.environments.managedLaunch(this.options.owner, session.environment.id)).hostedConfiguration;
      if (Object.keys(configuration?.env ?? {}).length) throw new AgentsApiError(400, 'This Session uses local environment values. Share requires a Session without source environment credentials or values.', 'share_incompatible');
    }
    const plan: LocalSharePlan = { id, source_session_id: input.session_id, destination, status: 'quiescing', destination_session_id: null, files: 0, bytes: 0, error: null };
    const resource = { ownerId: this.options.owner, collection: 'local_shares', id, createdAt: Math.floor(Date.now() / 1000), revision: 1,
      value: { plan, releaseToken: randomBytes(32).toString('hex'), workspaceFileIds: [], artifactFileIds: {} } satisfies ShareRecord };
    try { await this.options.sessions.beginShare(this.options.owner, plan.source_session_id, id, { resource, expectedRevision: 0 }); }
    catch (error) {
      if (await this.options.store.get(this.options.owner, 'local_shares', id)) return this.create(raw);
      throw error;
    }
    this.schedule(id);
    return this.retrieve(id);
  }

  public async retrieve(id: string): Promise<LocalSharePlan> {
    const { plan } = (await this.required(id)).value;
    const source = await this.options.store.get<import('../core/session-ports.js').SessionState>(this.options.owner, 'sessions', plan.source_session_id);
    return { ...plan, can_abort: source?.value.share?.operationId === id && source.value.share.phase !== 'released' && !['complete', 'aborted'].includes(plan.status) };
  }
  public async list() {
    const page = await this.options.store.list<ShareRecord>(this.options.owner, 'local_shares', { limit: 100, order: 'desc' });
    return { object: 'list' as const, data: await Promise.all(page.data.map(record => this.retrieve(record.id))), has_more: page.has_more };
  }
  public async execute(id: string) {
    const resource = await this.required(id);
    if (!['complete', 'aborted'].includes(resource.value.plan.status)) this.schedule(id);
    return this.retrieve(id);
  }
  public async abort(id: string) {
    this.cancellations.get(id)?.abort();
    await this.active.get(id);
    const resource = await this.required(id);
    if (resource.value.plan.status === 'aborted') return resource.value.plan;
    const plan = { ...resource.value.plan, status: 'aborted' as const, error: null };
    await this.options.sessions.abortShare(this.options.owner, plan.source_session_id, id, {
      resource: { ...resource, revision: resource.revision + 1, value: { ...resource.value, releaseToken: '', plan } }, expectedRevision: resource.revision,
    });
    return this.retrieve(id);
  }
  public async close() { this.stopped.abort(); await Promise.allSettled(this.active.values()); }

  private schedule(id: string) {
    if (this.active.has(id) || this.stopped.signal.aborted) return;
    const cancel = new AbortController();
    this.cancellations.set(id, cancel);
    const signal = AbortSignal.any([this.stopped.signal, cancel.signal]);
    const work = this.run(id, signal).catch(async error => {
      await this.update(id, value => ({ ...value, plan: { ...value.plan, status: 'failed',
        error: error instanceof AgentsApiError ? error.message : 'Share is interrupted. Retry to continue. Local execution remains fenced.' } }));
    }).finally(() => { this.active.delete(id); this.cancellations.delete(id); });
    this.active.set(id, work);
    void work.catch(() => {});
  }

  private async run(id: string, signal: AbortSignal) {
    let record = (await this.required(id)).value;
    if (!record.manifest) {
      await this.options.sessions.beginShare(this.options.owner, record.plan.source_session_id, id);
      await this.update(id, value => ({ ...value, plan: { ...value.plan, status: 'quiescing', error: null } }));
      while (!signal.aborted) {
        try { await this.snapshot(id); break; }
        catch (error) {
          if (!(error instanceof AgentsApiError) || error.code !== 'session_busy') throw error;
          await delay(200, undefined, { signal });
        }
      }
      record = (await this.required(id)).value;
    }
    signal.throwIfAborted();
    if (!record.manifest || !record.digest) throw new Error('Share snapshot is unavailable');
    const manifest = record.manifest;
    const digest = record.digest;
    const { destination } = record.plan;
    const connection = await this.options.connection({ connection_id: destination.connection_id!, endpoint: destination.baseURL, space_id: destination.space_id });
    if (connection.baseURL.replace(/\/$/, '') !== destination.baseURL) throw new Error('Destination connection changed');
    if (!record.staged) {
      await this.update(id, value => ({ ...value, plan: { ...value.plan, status: 'staging', error: null } }));
      const archive = Buffer.from(record.archive!, 'base64');
      for (let index = record.workspaceFileIds.length; index < manifest.workspace.parts.length; index++) {
        const file = await this.upload(connection, archive.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES), `share-${id}-${index}`, signal);
        record = await this.update(id, value => ({ ...value, workspaceFileIds: [...value.workspaceFileIds, file] }));
      }
      for (const artifact of manifest.artifacts) {
        if (record.artifactFileIds[artifact.artifact.id]) continue;
        const file = await this.upload(connection, Buffer.from(record.artifactData![artifact.artifact.id]!, 'base64'), `share-${id}-${artifact.artifact.id}`, signal);
        record = await this.update(id, value => ({ ...value, artifactFileIds: { ...value.artifactFileIds, [artifact.artifact.id]: file } }));
      }
      const request: ShareStageRequest = { manifest, digest, workspace_file_ids: record.workspaceFileIds, artifact_file_ids: record.artifactFileIds };
      const status = await this.request<ShareStatus>(connection, '/rat/shares', { method: 'POST', body: JSON.stringify(request), headers: { 'content-type': 'application/json' } }, signal);
      this.checkStatus(record, status);
      record = await this.update(id, value => ({ ...value, staged: true }));
    }
    signal.throwIfAborted();
    await this.options.sessions.releaseShare(this.options.owner, record.plan.source_session_id, id, record.digest!, { endpoint: destination.baseURL, spaceId: destination.space_id });
    record = await this.update(id, value => ({ ...value, plan: { ...value.plan, status: 'released', error: null } }));
    const status = await this.request<ShareStatus>(connection, `/rat/shares/${id}/activate`, { method: 'POST', body: JSON.stringify({ digest: record.digest, release_token: record.releaseToken }), headers: { 'content-type': 'application/json' } }, signal);
    this.checkStatus(record, status);
    if (status.status !== 'active') throw new Error('Destination has not activated');
    await this.update(id, value => ({ ...value, plan: { ...value.plan, status: 'complete', destination_session_id: status.session_id, error: null } }));
  }

  private checkStatus(record: ShareRecord, status: ShareStatus) {
    if (status.id !== record.plan.id || status.digest !== record.digest || status.session_id !== record.plan.source_session_id) throw new Error('Destination Share acknowledgement does not match');
  }
  private async snapshot(id: string) {
    const record = (await this.required(id)).value;
    const snapshot = await this.options.sessions.snapshotForShare(this.options.owner, record.plan.source_session_id, id, async session => {
      const configuration = session.environment.type === 'openai_hosted' ? (await this.options.environments.managedLaunch(this.options.owner, session.environment.id)).hostedConfiguration : undefined;
      if (Object.keys(configuration?.env ?? {}).length) throw new AgentsApiError(400, 'Source environment values cannot migrate through Share.', 'share_incompatible');
      const files = session.environment.type === 'openai_hosted' ? await this.options.snapshot(session.id) : [];
      const { env: _env, setup_commands: _setup, files: _files, ...safeConfiguration } = configuration ?? {};
      return { environment: session.environment.type === 'none' ? { type: 'none' as const } : { ...safeConfiguration, type: 'openai_hosted' as const }, ...archiveWorkspace(files) };
    });
    const state = snapshot.state;
    const artifacts = [...state.turns.flatMap(turn => turn.savedArtifacts ?? []), ...(state.subagents ?? []).flatMap(subagent => subagent.artifacts ?? [])];
    const artifactData: Record<string, string> = {};
    const artifactManifest: SessionShareManifest['artifacts'] = [];
    for (const entry of artifacts) {
      const stream = await this.options.sessions.artifactContent(this.options.owner, state.session.id, entry.artifact.id);
      const data = new Uint8Array(await new Response(stream).arrayBuffer());
      if (data.length > CHUNK_BYTES) throw new AgentsApiError(400, 'A Session artifact exceeds the Share upload limit.', 'share_incompatible');
      artifactData[entry.artifact.id] = Buffer.from(data).toString('base64');
      artifactManifest.push({ artifact: entry.artifact, sha256: bytesDigest(data) });
    }
    const parts: SessionShareManifest['workspace']['parts'] = [];
    if (state.session.environment.type !== 'none') for (let offset = 0; offset < snapshot.workspace.archive.length; offset += CHUNK_BYTES) {
      const part = snapshot.workspace.archive.subarray(offset, offset + CHUNK_BYTES);
      parts.push({ bytes: part.length, sha256: bytesDigest(part) });
    }
    const manifest: SessionShareManifest = { version: 1, operation_id: id, release_hash: releaseDigest(record.releaseToken),
      session: state.session, ...(snapshot.sourceAgent ? { source_agent: snapshot.sourceAgent } : {}), runtime: state.runtime ?? CODEX_RUNTIME,
      turns: state.turns.map(({ savedArtifacts: _artifacts, cancelRequested: _cancel, ...turn }) => ({ ...turn, savedItems: orderedTurnItems(state, turn, turn.savedItems ?? []) })),
      subagents: (state.subagents ?? []).map(({ artifacts: _artifacts, ...subagent }) => subagent),
      imported_history: [...state.fork?.history ?? [], ...state.importedHistory ?? []], inputs: sessionInputs(state),
      artifacts: artifactManifest, deleted_artifacts: state.deletedArtifacts, admission: snapshot.admission,
      environment: snapshot.workspace.environment,
      workspace: { sha256: snapshot.workspace.sha256, files: snapshot.workspace.files, bytes: snapshot.workspace.bytes, parts },
    };
    await this.update(id, value => ({ ...value, manifest, digest: shareDigest(manifest), archive: Buffer.from(snapshot.workspace.archive).toString('base64'), artifactData,
      plan: { ...value.plan, files: manifest.workspace.files, bytes: manifest.workspace.bytes, status: 'staging' } }));
  }

  private async upload(connection: Awaited<ReturnType<ShareConnectionFactory>>, bytes: Uint8Array, filename: string, signal: AbortSignal) {
    const form = new FormData();
    form.set('purpose', 'user_data');
    form.set('file', new Blob([Buffer.from(bytes)]), filename);
    const file = await this.request<{ id: string }>(connection, '/files', { method: 'POST', body: form }, signal);
    if (typeof file.id !== 'string') throw new Error('Upload acknowledgement is invalid');
    return file.id;
  }
  private async request<T>(connection: Awaited<ReturnType<ShareConnectionFactory>>, path: string, init: RequestInit, operationSignal: AbortSignal): Promise<T> {
    const signal = AbortSignal.any([operationSignal, AbortSignal.timeout(120_000)]);
    const response = await connection.fetch(`${connection.baseURL}${path}`, { ...init, signal, redirect: 'error' });
    if (!response.ok) {
      const body = await response.json().catch(() => undefined) as { error?: { message?: string } } | undefined;
      throw new AgentsApiError(response.status, body?.error?.message ?? 'The destination could not accept this Share.', 'share_destination_error');
    }
    return response.json() as Promise<T>;
  }
  private async required(id: string) { return await this.options.store.get<ShareRecord>(this.options.owner, 'local_shares', id) ?? resourceNotFound(); }
  private async update(id: string, update: (value: ShareRecord) => ShareRecord) {
    const resource = await this.required(id);
    const value = update(resource.value);
    await this.options.store.put({ ...resource, revision: resource.revision + 1, value }, resource.revision);
    return value;
  }
}
