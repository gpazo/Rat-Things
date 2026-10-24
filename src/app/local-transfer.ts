import { randomUUID } from 'node:crypto';
import { toFile } from 'openai';
import type { AgentsStore } from '../core/agents-ports.js';
import type { SessionService } from '../core/session-service.js';
import type { EnvironmentService } from '../core/environment-service.js';
import type { AgentSession } from '../domain/agents-api.js';
import type { SessionImport, SessionImportCapabilities } from '../domain/session-transfer.js';
import { archiveWorkspace, restoreWorkspaceCommand, type PortableFile } from '../domain/workspace-transfer.js';
import { AgentsApiError, parseAgentsContract } from '../domain/agents-api-validation.js';
import { createAgentsClient, createAgentsFetch } from '../agents-client.js';
import { modelCatalogFromResponse } from '../core/model-catalog.js';

const CHUNK_BYTES = 3 * 1024 * 1024; // Fits the existing Lambda request envelope, including multipart/base64 overhead.
export interface TransferPlan {
  id: string; source_session_id: string; destination: { baseURL: string; region: string };
  status: 'preparing' | 'ready' | 'uploading' | 'importing' | 'complete' | 'failed';
  files: number; bytes: number; history_items: number; uploaded_parts: number; total_parts: number;
  destination_session_id: string | null; error: string | null;
  source_model?: string; model?: string;
}
interface TransferRecord { plan: TransferPlan; snapshot?: { request: SessionImport; archive: string; sha256: string }; fileIds: string[]; importRequest?: SessionImport }

/** Snapshots and retry receipts stay encrypted in the local store; public responses contain only progress. */
export class LocalTransferService {
  private readonly active = new Map<string, Promise<void>>();
  public constructor(private readonly options: {
    store: AgentsStore; sessions: SessionService; environments: EnvironmentService; owner: string;
    snapshot: (id: string) => Promise<PortableFile[]>;
    client?: typeof createAgentsClient;
    modelsFetch?: typeof createAgentsFetch;
  }) {}
  public async models(raw: unknown) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || Object.keys(raw).some(key => !['endpoint', 'region'].includes(key))) throw new AgentsApiError(400, 'Choose an AWS endpoint and region.');
    const destination = transferDestination(raw);
    return { destination, models: await this.readModels(destination) };
  }
  public async create(raw: unknown): Promise<TransferPlan> {
    const value = raw as { session_id?: unknown; endpoint?: unknown; region?: unknown; model?: unknown };
    if (!value || typeof value.session_id !== 'string' || typeof value.endpoint !== 'string' || typeof value.region !== 'string') throw new AgentsApiError(400, 'Choose a Session, AWS endpoint and region.');
    if (value.model !== undefined && (typeof value.model !== 'string' || !value.model || value.model.trim() !== value.model || /[\u0000-\u001f\u007f]/.test(value.model))) throw new AgentsApiError(400, 'Choose a destination model ID.', 'invalid_request', 'model');
    const destination = transferDestination(value);
    const source = await this.options.sessions.retrieve(this.options.owner, value.session_id);
    const plan: TransferPlan = { id: randomUUID(), source_session_id: value.session_id, destination,
      source_model: source.agent.model, model: value.model ?? source.agent.model,
      status: 'preparing', files: 0, bytes: 0, history_items: 0, uploaded_parts: 0, total_parts: 0, destination_session_id: null, error: null };
    await this.options.store.put({ ownerId: this.options.owner, collection: 'local_transfers', id: plan.id, createdAt: Math.floor(Date.now() / 1000), revision: 1, value: { plan, fileIds: [] } satisfies TransferRecord }, 0);
    this.schedule(plan.id, false);
    return plan;
  }
  public async retrieve(id: string) {
    const { value } = await this.required(id);
    return transferForRead(value.plan, this.active.has(id));
  }
  public async list(raw: unknown = {}) {
    const value = raw as { limit?: unknown; after?: unknown } | null;
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['limit', 'after'].includes(key))
      || value.limit !== undefined && (typeof value.limit !== 'number' || !Number.isInteger(value.limit) || value.limit < 1 || value.limit > 20)
      || value.after !== undefined && (typeof value.after !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.after))) {
      throw new AgentsApiError(400, 'Choose a limit from 1 to 20 and an optional saved copy ID.', 'invalid_request');
    }
    const page = await this.options.store.list<TransferRecord>(this.options.owner, 'local_transfers', {
      limit: value.limit ?? 20, order: 'desc', ...(value.after === undefined ? {} : { after: value.after }),
    });
    const data = page.data.map(record => transferForRead(record.value.plan, this.active.has(record.id)));
    return { object: 'list' as const, data, has_more: Boolean(page.has_more), last_id: data.at(-1)?.id ?? null };
  }
  public async execute(id: string) {
    const { value } = await this.required(id);
    if (value.plan.status === 'complete' || this.active.has(id)) return value.plan;
    await this.update(id, record => ({ ...record, plan: { ...record.plan, status: record.importRequest ? 'importing' : record.snapshot ? 'uploading' : 'preparing', error: null } }));
    this.schedule(id, Boolean(value.snapshot));
    return this.retrieve(id);
  }
  public async close() { await Promise.allSettled(this.active.values()); }
  private async readModels(destination: TransferPlan['destination']) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('Destination catalog deadline exceeded')); }, 20_000);
      timer.unref();
    });
    try {
      return await Promise.race([timeout, (async () => {
        const response = await (this.options.modelsFetch ?? createAgentsFetch)(destination)(`${destination.baseURL}/models`, {
          method: 'GET', redirect: 'error', signal: controller.signal,
        });
        const length = response.headers.get('content-length');
        if (!response.ok || length !== null && Number(length) > 1024 * 1024) {
          void response.body?.cancel().catch(() => {});
          throw new Error('Destination catalog unavailable');
        }
        const reader = response.body?.getReader();
        if (!reader) throw new Error('Destination catalog is empty');
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            bytes += next.value.byteLength;
            if (bytes > 1024 * 1024) throw new Error('Destination catalog exceeds the response limit');
            chunks.push(next.value);
          }
          const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
          const models = modelCatalogFromResponse(value);
          if (!models) throw new Error('Invalid destination catalog');
          return models;
        } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
      })()]);
    } catch {
      throw new AgentsApiError(502, 'The destination model catalog is unavailable. Check the endpoint, region and AWS identity, then try again.', 'destination_catalog_unavailable');
    } finally { clearTimeout(timer); controller.abort(); }
  }
  private client(plan: TransferPlan) { return (this.options.client ?? createAgentsClient)(plan.destination).withOptions({ timeout: 120_000, maxRetries: 0 }); }
  private schedule(id: string, upload: boolean) {
    const work = (upload ? this.copy(id) : this.prepare(id)).catch(async (error: unknown) => {
      await this.update(id, record => ({ ...record, plan: { ...record.plan, status: 'failed', error: error instanceof AgentsApiError ? `${error.message}${error.param ? ` Field: ${error.param}.` : ''}` : 'Transfer could not finish. Check the destination connection, model configuration and workspace limits, then retry. The local Session is retained.' } }));
    }).finally(() => { this.active.delete(id); });
    this.active.set(id, work);
    void work.catch(() => {});
  }
  private async preflight(plan: TransferPlan, model: string) {
    const client = this.client(plan);
    const capabilities = await client.get<SessionImportCapabilities>('/agents/sessions/import');
    parseAgentsContract('SessionImportCapabilities', capabilities);
    if (capabilities.version !== 1 || capabilities.credentials !== 'destination') throw new Error('Destination needs Session import support');
    const models = await this.readModels(plan.destination);
    if (!models.data.some(entry => entry.id === model)) throw new AgentsApiError(400, 'The destination has not configured the selected model. Choose a model from its catalog and create a new transfer plan.', 'model_not_available', 'model');
    return capabilities;
  }
  private async prepare(id: string) {
    const { plan } = (await this.required(id)).value;
    await this.update(id, record => ({ ...record, plan: { ...record.plan, status: 'preparing', error: null } }));
    const source = await this.options.sessions.retrieve(this.options.owner, plan.source_session_id);
    const model = plan.model ?? source.agent.model;
    const capabilities = await this.preflight(plan, model);
    const snapshot = await this.options.sessions.snapshotForTransfer(this.options.owner, source.id, async session => {
      const configuration = session.environment.type === 'openai_hosted' ? (await this.options.environments.managedLaunch(this.options.owner, session.environment.id)).hostedConfiguration : undefined;
      const files = session.environment.type === 'openai_hosted' ? await this.options.snapshot(session.id) : [];
      return { configuration, ...archiveWorkspace(files) };
    });
    if (snapshot.session.vault_ids.length || snapshot.session.agent.tools.some(tool => !['function', 'web_search', 'programmatic_tool_calling'].includes(tool.type))) throw new Error('Reconnect credential-backed tools at the destination');
    if (Buffer.byteLength(JSON.stringify(snapshot.history)) > capabilities.max_history_bytes) throw new Error('History exceeds destination limits');
    const { id: _agentId, name: _agentName, multi_agent, ...settings } = snapshot.session.agent;
    const agent = { ...settings, model, multi_agent: { enabled: multi_agent.enabled, ...(multi_agent.max_concurrent_subagents !== null ? { max_concurrent_subagents: multi_agent.max_concurrent_subagents } : {}) } };
    const { env: _env, ...configuration } = snapshot.workspace.configuration ?? {};
    const request: SessionImport = { version: 1, transfer_id: id, source_session_id: source.id, history: snapshot.history,
      session: { agent, metadata: snapshot.session.metadata, environment: source.environment.type === 'none' ? { type: 'none' } : {
        ...configuration, type: 'openai_hosted', files: [], setup_commands: [],
        packages: { system: snapshot.workspace.configuration?.packages?.system ?? [] },
      } } };
    if (agent.tools.some(tool => tool.type === 'function' && tool.defer_loading)) request.session.agent = { ...agent, tools: [...agent.tools, { type: 'tool_search' }] };
    parseAgentsContract('SessionImport', request);
    if (Buffer.byteLength(JSON.stringify(request)) > 3 * 1024 * 1024) throw new Error('Session settings exceed the transfer request limit');
    const { archive, sha256, files, bytes } = snapshot.workspace;
    await this.update(id, record => ({ ...record, snapshot: { request, archive: Buffer.from(archive).toString('base64'), sha256 },
      plan: { ...record.plan, source_model: snapshot.session.agent.model, model, status: 'ready', files, bytes, history_items: snapshot.history.length, total_parts: source.environment.type === 'none' ? 0 : Math.ceil(archive.length / CHUNK_BYTES), error: null } }));
  }
  private async copy(id: string) {
    let record = (await this.required(id)).value;
    if (!record.snapshot) throw new Error('A reviewed snapshot is required');
    const snapshot = record.snapshot;
    for (const request of [snapshot.request, record.importRequest]) {
      const environment = request?.session.environment;
      if (environment?.type === 'openai_hosted' && Object.keys(environment.env ?? {}).length) {
        throw new AgentsApiError(400, 'This saved copy includes local environment values. Create a new transfer plan to keep those values on this computer.', 'transfer_plan_outdated');
      }
    }
    const client = this.client(record.plan);
    let request = record.importRequest;
    if (!request) {
      await this.preflight(record.plan, snapshot.request.session.agent!.model!);
      await this.update(id, value => ({ ...value, plan: { ...value.plan, status: 'uploading', error: null } }));
      const archive = Buffer.from(snapshot.archive, 'base64');
      for (let index = record.fileIds.length; index < record.plan.total_parts; index++) {
        const file = await client.files.create({ purpose: 'user_data', file: await toFile(archive.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES), `rat-transfer-${id}-${index}`) });
        record = await this.update(id, value => ({ ...value, fileIds: [...value.fileIds, file.id], plan: { ...value.plan, uploaded_parts: index + 1 } }));
      }
      const environment = snapshot.request.session.environment;
      request = { ...snapshot.request, session: { ...snapshot.request.session, environment: environment.type === 'openai_hosted' ? {
        ...environment, files: record.fileIds.map((file_id, index) => ({ type: 'file_id', file_id, path: `/workspace/.rat-transfer/part-${index}` })),
        setup_commands: [{ command: restoreWorkspaceCommand(snapshot.sha256, record.plan.total_parts), cwd: '/workspace' }],
      } : environment } };
    }
    const importRequest = request;
    await this.update(id, value => ({ ...value, importRequest, plan: { ...value.plan, status: 'importing', error: null } }));
    const session = await client.post<AgentSession>('/agents/sessions/import', { body: request });
    parseAgentsContract('Session', session);
    await this.update(id, value => ({ ...value, plan: { ...value.plan, status: 'complete', destination_session_id: session.id, error: null } }));
  }
  private async required(id: string) {
    const record = await this.options.store.get<TransferRecord>(this.options.owner, 'local_transfers', id);
    if (!record) throw new AgentsApiError(404, 'Transfer not found.', 'resource_not_found');
    return record;
  }
  private async update(id: string, change: (record: TransferRecord) => TransferRecord) {
    const current = await this.required(id); const value = change(current.value);
    await this.options.store.put({ ...current, revision: current.revision + 1, value }, current.revision);
    return value;
  }
}

function transferDestination(raw: unknown): TransferPlan['destination'] {
  const value = raw as { endpoint?: unknown; region?: unknown } | null;
  let url: URL;
  try {
    if (!value || typeof value.endpoint !== 'string' || typeof value.region !== 'string') throw new Error('Missing destination');
    url = new URL(value.endpoint);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || !['', '/', '/v1', '/v1/'].includes(url.pathname) || !/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(value.region)) throw new Error('Invalid destination');
    return { baseURL: `${url.origin}/v1`, region: value.region };
  } catch { throw new AgentsApiError(400, 'Use an HTTPS Agents API URL and AWS region.', 'invalid_request'); }
}

function transferForRead(plan: TransferPlan, active: boolean): TransferPlan {
  const interrupted = !active && ['preparing', 'uploading', 'importing'].includes(plan.status);
  return {
    id: plan.id, source_session_id: plan.source_session_id,
    destination: { baseURL: plan.destination.baseURL, region: plan.destination.region },
    status: interrupted ? 'failed' : plan.status,
    files: plan.files, bytes: plan.bytes, history_items: plan.history_items,
    uploaded_parts: plan.uploaded_parts, total_parts: plan.total_parts,
    destination_session_id: plan.destination_session_id,
    error: interrupted ? 'Transfer interrupted. Retry to resume from the saved snapshot.' : plan.error,
    ...(plan.source_model === undefined ? {} : { source_model: plan.source_model }),
    ...(plan.model === undefined ? {} : { model: plan.model }),
  };
}
