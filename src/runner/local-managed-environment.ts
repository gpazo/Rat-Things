import { randomBytes, randomUUID } from 'node:crypto';
import type { AgentsStore } from '../core/agents-ports.js';
import type { EnvironmentService } from '../core/environment-service.js';
import type { AgentSession, AgentSessionItem, EnvironmentParam } from '../domain/agents-api.js';
import type { EnvironmentFileOperation } from '../core/environment-file-ports.js';
import { AgentsApiError } from '../domain/agents-api-validation.js';
import type { LocalRuntime, LocalStartRequest } from '../core/local-runtime-ports.js';
import { codexEnvironmentFiles } from '../adapters/codex-environment-files.js';
import { environmentToken } from '../credentials/environment.js';
import { planSessionLaunch } from './session-launch-planning.js';
import { hostedCodexArguments, hostedProcessEnvironment } from './hosted-environment-planning.js';
import type { CodexLaunchPlan } from './agent-planning.js';
import type { SessionState } from '../core/session-ports.js';
import { requireSessionMutable } from '../core/session-fork-planning.js';
import { localWorkspaceIdentity, sameLocalWorkspace, type LocalWorkspaceIntent } from '../domain/local-workspace.js';
import { workspaceDigests } from '../domain/workspace-checkpoint.js';
import { LocalRuntimeAdmissionError } from '../domain/local-native-admission.js';
import type { LocalCodexHostProvider } from './local-codex.js';

interface WorkerConnection { url: string; harnessKey: string }

/** The model harness stays on the host; only the executor runs in the Linux VM. */
export class LocalManagedEnvironment {
  private readonly connections = new Map<string, Promise<WorkerConnection>>();
  private readonly sessions = new Map<string, { owner: string; session: AgentSession }>();
  private readonly operations = new Map<string, Promise<unknown>>();
  private readonly heartbeat: NodeJS.Timeout;
  private checking = false;
  private closed: Promise<void> | undefined;
  public constructor(private readonly options: { runtime: LocalRuntime; store: AgentsStore; environments: EnvironmentService; maxSessions: number;
    hostCodex: LocalCodexHostProvider }) {
    this.heartbeat = setInterval(() => {
      if (this.checking) return;
      this.checking = true;
      void this.refresh().finally(() => { this.checking = false; });
    }, 15_000);
    this.heartbeat.unref();
  }
  public async prepare(owner: string, id: string, input: EnvironmentParam) {
    if (input.type !== 'openai_hosted') throw new AgentsApiError(400, 'Choose a managed Linux environment or No environment.', 'unsupported_environment');
    const status = await this.options.runtime.status();
    if (!status.ready) throw new AgentsApiError(503, status.checks.filter(check => !check.ready).map(check => `${check.message} ${check.action ?? ''}`).join(' '), 'local_runtime_unavailable');
    if (input.plugins?.length) throw new AgentsApiError(400, 'Plugins are not yet supported in local environments.', 'unsupported_environment');
    if (input.files?.some(file => file.type !== 'inline') || input.skills?.some(skill => skill.type !== 'inline')) throw new AgentsApiError(400, 'Use inline files and skills for local environments.', 'unsupported_environment');
    return this.options.environments.prepare(owner, id, input);
  }
  public async launch(owner: string, session: AgentSession, base: CodexLaunchPlan, history: AgentSessionItem[]) {
    const connection = await this.ensure(owner, session);
    if (session.environment.type !== 'openai_hosted') throw new Error('Expected managed environment');
    const configuration = (await this.options.environments.managedLaunch(owner, session.environment.id)).hostedConfiguration;
    const roots = [...session.environment.capability_directories,
      ...(configuration?.plugins ?? []).map(plugin => `/workspace/.capabilities/plugins/${plugin.name}`),
      ...(configuration?.skills ?? []).filter(skill => skill.type === 'inline').map(skill => `/workspace/.capabilities/skills/${skill.name}`)];
    const result = planSessionLaunch(base, { sessionId: session.id, turnId: '', agent: session.agent, input: [], history,
      environment: { type: 'self_hosted', id: session.environment.id, workspace_directory: '/workspace', capability_directories: [...new Set(roots)], remote_url: connection.url },
    }, connection.harnessKey);
    return { ...result, permissions: 'rat_managed', binaryArguments: hostedCodexArguments(base.binaryArguments, session.environment.network),
      sessionConfig: { ...result.sessionConfig, shell_environment_policy: { inherit: 'core', set: hostedProcessEnvironment(configuration?.env ?? {}, '/usr/local/bin:/usr/bin:/bin') } } };
  }
  public async initialize(owner: string, session: AgentSession) { if (session.environment.type === 'openai_hosted') await this.ensure(owner, session); }
  public async admitTurn(session: AgentSession) {
    if (session.environment.type !== 'openai_hosted') return;
    try { await this.options.runtime.admitTurn(session.id); }
    catch (error) { throw admissionError(error); }
  }
  public async files(owner: string, sessionId: string, operation: EnvironmentFileOperation) {
    const resource = await this.options.store.get<SessionState>(owner, 'sessions', sessionId);
    if (!resource) throw new AgentsApiError(404, 'Session not found.', 'resource_not_found');
    requireSessionMutable(resource.value, Math.floor(Date.now() / 1000));
    return this.serialize(sessionId, async () => {
      const host = this.options.hostCodex();
      const connection = await this.ensureWorker(owner, resource.value.session);
      if (resource.value.session.environment.type !== 'openai_hosted') throw new Error('Expected managed environment');
      return codexEnvironmentFiles({ registryURL: connection.url, environmentId: resource.value.session.environment.id,
        harnessKey: connection.harnessKey, workspace: '/workspace', operation, binary: host.binary, environment: host.environment });
    });
  }
  public async state(owner: string, session: AgentSession) {
    if (session.environment.type === 'none') return undefined;
    return this.options.environments.state(owner, session.environment.id);
  }
  public close(session: AgentSession) {
    return this.serialize(session.id, () => this.retire(session.id, () => this.options.runtime.stop(session.id)));
  }
  public shutdown() {
    this.closed ??= (async () => {
      clearInterval(this.heartbeat);
      await Promise.allSettled(this.operations.values());
      this.connections.clear(); this.sessions.clear();
      await this.options.runtime.close();
    })();
    return this.closed;
  }
  public snapshot(sessionId: string) {
    return this.serialize(sessionId, async () => {
      try {
        const files = await this.options.runtime.snapshot(sessionId);
        return await this.retire(sessionId, async () => files);
      } catch (error) {
        if (!await this.options.runtime.running(sessionId)) await this.retire(sessionId, async () => {});
        throw admissionError(error);
      }
    });
  }
  private ensure(owner: string, session: AgentSession) {
    return this.serialize(session.id, () => this.ensureWorker(owner, session));
  }
  private async ensureWorker(owner: string, session: AgentSession) {
    const existing = this.connections.get(session.id);
    if (existing && await this.options.runtime.running(session.id)) return existing;
    if (this.connections.size - Number(this.connections.has(session.id)) >= this.options.maxSessions) throw new AgentsApiError(503, 'All local worker slots are in use. Close an idle Session to free a slot.', 'local_capacity');
    const pending = this.prepareStart(owner, session).then(request => this.start(owner, session, request));
    this.connections.set(session.id, pending);
    void pending.catch(() => { if (this.connections.get(session.id) === pending) this.connections.delete(session.id); });
    return pending;
  }
  private async refresh() {
    for (const id of this.sessions.keys()) await this.serialize(id, async () => {
      const entry = this.sessions.get(id);
      if (!entry || entry.session.environment.type !== 'openai_hosted') return;
      if (!await this.options.runtime.running(id)) { await this.retire(id, () => this.options.runtime.stop(id)); return; }
      await this.options.environments.managedStatus(entry.owner, entry.session.environment.id, id, 'connected');
    }).catch(() => {});
  }
  private async markDisconnected(id: string) {
    const entry = this.sessions.get(id);
    if (entry?.session.environment.type === 'openai_hosted') await this.options.environments.managedStatus(entry.owner, entry.session.environment.id, id, 'disconnected');
  }
  private async retire<T>(id: string, operation: () => Promise<T>): Promise<T> {
    this.connections.delete(id);
    let statusFailure: unknown;
    try { await this.markDisconnected(id); } catch (error) { statusFailure = error; }
    const result = await operation();
    this.sessions.delete(id);
    if (statusFailure) throw statusFailure;
    return result;
  }
  private serialize<T>(id: string, operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Local environments are shutting down.'));
    const pending = (this.operations.get(id) ?? Promise.resolve()).catch(() => {}).then(operation);
    this.operations.set(id, pending);
    void pending.finally(() => { if (this.operations.get(id) === pending) this.operations.delete(id); }).catch(() => {});
    return pending;
  }
  private async prepareStart(owner: string, session: AgentSession): Promise<LocalStartRequest> {
    if (session.environment.type !== 'openai_hosted') throw new Error('Expected managed environment');
    const environmentId = session.environment.id;
    const prepared = await this.options.store.get(owner, 'local_prepared', session.id);
    const executorKey = environmentToken({ ownerId: owner, environmentId, role: 'executor' }, randomBytes(32).toString('hex'));
    const harnessKey = environmentToken({ ownerId: owner, environmentId, role: 'harness' }, randomBytes(32).toString('hex'));
    const launch = { sessionId: session.id, turnId: '', agent: session.agent, environment: session.environment, input: [], ...await this.options.environments.managedLaunch(owner, environmentId) };
    const workspace = workspaceClaim(prepared
      ? { kind: 'resume', saved: prepared.value }
      : { kind: 'create', generation: randomUUID() }, session.id, launch);
    return { workspace, worker: { ownerId: owner, sessionId: session.id, environmentId, executorKey, harnessKey, launch } };
  }
  private async start(owner: string, session: AgentSession, request: LocalStartRequest): Promise<WorkerConnection> {
    let started = false;
    try {
      const url = await this.options.runtime.start(request, async () => {
        await this.markDisconnected(session.id);
        await this.options.environments.attachManaged(owner, request.worker.environmentId, session.id);
        if (request.workspace.kind === 'create') await this.options.store.put({ ownerId: owner, collection: 'local_prepared', id: session.id,
          createdAt: session.created_at, revision: 1, value: request.workspace.identity }, 0);
        this.sessions.set(session.id, { owner, session });
      });
      started = true;
      await this.options.environments.managedReady(owner, request.worker.environmentId, session.id, { id: request.workspace.identity.generation, replaced: false });
      return { url, harnessKey: request.worker.harnessKey };
    } catch (error) {
      if (started) {
        try { await this.retire(session.id, () => this.options.runtime.stop(session.id)); }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Local worker start and cleanup failed'); }
      }
      throw admissionError(error);
    }
  }
}

type WorkspaceClaim =
  | { kind: 'resume'; saved: unknown }
  | { kind: 'create'; generation: string };

function workspaceClaim(claim: WorkspaceClaim, sessionId: string, launch: Parameters<typeof workspaceDigests>[0]): LocalWorkspaceIntent {
  if (claim.kind === 'create') {
    const setupDigest = workspaceDigests(launch).setupDigest;
    return { kind: 'create', identity: { version: 1, sessionId, generation: claim.generation, setupDigest } };
  }

  const identity = localWorkspaceIdentity(claim.saved);
  const setupDigest = workspaceDigests(launch).setupDigest;
  if (!sameLocalWorkspace(identity, { ...identity, sessionId, setupDigest })) throw new Error('Local workspace setup identity changed.');
  return { kind: 'resume', identity };
}

function admissionError(error: unknown) {
  return error instanceof LocalRuntimeAdmissionError && error.decision.kind === 'wait'
    ? new AgentsApiError(503, error.message, error.decision.code) : error;
}
