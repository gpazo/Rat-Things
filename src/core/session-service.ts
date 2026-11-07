import { feedbackCollection, feedbackDigest, feedbackWindow, planFeedbackBatch, type SessionFeedback, type FeedbackEvent } from './session-feedback-planning.js';
import { SessionSteerRejectedError } from '../domain/session-errors.js';
import { performanceCount, performancePhase } from './performance.js';
import { planRejectedSteer } from './session-steer-planning.js';
import { importedSessionMessage, importedSessionReceipts, participantContext } from './session-attribution.js';
import { restoreWorkspaceCommand } from '../domain/workspace-transfer.js';
import { requireSessionCallerUnexpired, validateSessionCaller, type SessionCaller } from './session-caller.js';
import { activityRevision, sessionActivity, sessionInputs, type SessionFollowOptions } from './session-activity.js';
import { ConfigurationHistory, commitConfiguration, configurationRef, ensureSessionConfiguration, planConfigurationRevision, sessionConfigurationSnapshot } from './configuration-history.js';
import type { ConfigurationMutation } from '../domain/configuration-history.js';
import { THREAD_RELEASE_TOOL, withThreadReleaseTool } from './thread-release-tool.js';
import { planIntegrationSteerRecovery, releaseThreadSubscription } from './session-integration-planning.js';
import type { SessionIntegrationState, ThreadSubscription } from '../domain/session-integrations.js';
import { CODEX_RUNTIME, assertRuntimeUnchanged, validateRuntimeInput, resolveRuntime, piModel, validateRuntimeAgent, type PiModelDescriptor } from '../domain/session-runtime.js';
import { planRuntimeClosure } from './session-runtime-store.js';
import { projectSessionTraces } from './session-trace-planning.js';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { AgentSession, AgentSessionDeleted, AgentSessionInputParam, SessionArtifactDeleted } from '../domain/agents-api.js';
import { AgentsApiError, invalid, parseAgentsContract, resourceNotFound, validateAgentMetadata } from '../domain/agents-api-validation.js';
import { canonicalJson } from '../domain/json.js';
import type { AgentService } from './agent-service.js';
import type { AgentResource, AgentsClock, AgentsIds, AgentsStore } from './agents-ports.js';
import type { SessionExecution, SessionObservation, SessionState } from './session-ports.js';
import { cancelledStartTurn, cursorPage, initialMessages, observeSession, orderedTurnItems, planSessionInput, terminalTurn, updateSessionAgent } from './session-planning.js';
import { planSessionPreparation, preparationTools, requireActivePreparation, type SessionPreparation } from './session-preparation-planning.js';
import { planSessionStream, type SessionStreamSnapshot } from './session-stream.js';
import { sessionEventBatchId, type SessionEventBatch } from './session-event-store.js';
import { planSessionFork, requireSessionMutable } from './session-fork-planning.js';
import { SessionActivityPolling } from './session-activity-polling.js';
import type { SessionFork } from '../domain/session-fork.js';

export interface SessionServiceOptions {
  rateLimit?: import('./owner-rate-limiter.js').OwnerRateLimit;
  piManagedStorage?: boolean;
  store: AgentsStore;
  agents: Pick<AgentService, 'retrieve'> & Partial<Pick<AgentService, 'configuration'>>;
  execution: SessionExecution;
  clock?: AgentsClock;
  ids?: AgentsIds;
  streamIntervalMs?: number;
  nowMs?: () => number;
  piCatalog?: readonly PiModelDescriptor[];
}

/** Sessions own configuration and an outbox. Execution acknowledgements are separate writes. */
export class SessionService {
  private readonly clock: AgentsClock;
  private readonly ids: AgentsIds;
  private readonly activityPolling = new SessionActivityPolling();

  public constructor(private readonly options: SessionServiceOptions) {
    this.clock = options.clock ?? { now: () => Math.floor(Date.now() / 1000) };
    this.ids = options.ids ?? { next: (prefix) => `${prefix}_${randomUUID().replaceAll('-', '')}` };
  }

  public async create(ownerId: string, raw: unknown, integrationId?: string, runtimePin?: import('../domain/session-runtime.js').RuntimePin, restored?: Pick<SessionState, 'importedHistory' | 'importedFrom'>, caller?: SessionCaller): Promise<AgentSession> {
    // Only trusted integration code supplies this identity; it is never an HTTP parameter.
    if (integrationId) {
      const previous = await this.options.store.get<SessionState>(ownerId, 'sessions', integrationId);
      if (previous) return previous.value.session;
    }
    const input = parseAgentsContract('SessionCreate', raw);
    validateAgentMetadata(input.metadata);
    const messages = initialMessages(input.input);
    if (input.environment.type === 'none' && !messages.length && !restored?.importedHistory?.length) invalid('Sessions without an environment require initial input', 'input');
    const id = integrationId ?? this.ids.next('sess');
    await this.options.rateLimit?.admit(ownerId, `session:${id}`);
    let preparation = integrationId ? (await this.options.store.get<SessionPreparation>(ownerId, 'session_preparations', id))?.value : undefined;
    if (!preparation) {
      const savedConfiguration = input.agent_id ? await this.options.agents.configuration?.(ownerId, input.agent_id) : undefined;
      const saved = savedConfiguration?.agent ?? (input.agent_id ? await this.options.agents.retrieve(ownerId, input.agent_id) : undefined);
      preparation = planSessionPreparation(input, this.ids.next('agent'), this.clock.now(), saved, this.options.execution.placement?.(ownerId, input.agent_id ?? undefined) ?? 'microvm', this.options.piCatalog);
      if (caller?.admission !== undefined) preparation = { ...preparation, workloadAdmission: caller.admission };
      if (savedConfiguration) preparation = { ...preparation, sourceAgent: savedConfiguration.revision };
      const integration = integrationId ? await this.options.store.get<SessionIntegrationState>(ownerId, 'session_integrations', id) : undefined;
      if (integration?.value.threadSubscriptionId && integration.value.inputs[0]?.source.kind !== 'api') preparation = { ...preparation, agent: withThreadReleaseTool(preparation.agent) };
      if (runtimePin) {
        assertRuntimeUnchanged(runtimePin, input.metadata);
        validateRuntimeAgent(runtimePin, preparation.agent, input.environment);
        preparation = { ...preparation, runtime: runtimePin };
      }
      try {
        await validateSessionCaller(caller);
        const prepared = { ownerId, id, collection: 'session_preparations', createdAt: preparation.now, revision: 1, value: preparation };
        if (caller?.observations?.length) await this.options.store.commit([{ resource: prepared, expectedRevision: 0 }], caller.observations);
        else await this.options.store.put(prepared, 0);
      } catch (error) {
        // A concurrent winner or a lost acknowledgement may have committed.
        // Use that snapshot before performing any preparation effects.
        const committed = await this.options.store.get<SessionPreparation>(ownerId, 'session_preparations', id).catch(() => undefined);
        if (!committed) throw error;
        preparation = committed.value;
      }
    }
    if (preparation.created) return (await this.required(ownerId, id)).value.session;
    requireActivePreparation(preparation, this.clock.now());
    const { agent, now } = preparation;
    this.requireRuntimeAllowed(preparation.runtime ?? CODEX_RUNTIME, agent);
    validateRuntimeAgent(preparation.runtime ?? CODEX_RUNTIME, agent, input.environment);
    validateRuntimeInput(preparation.runtime ?? CODEX_RUNTIME, agent, messages);
    if (preparation.runtime?.kind === 'pi' && input.environment.type === 'openai_hosted' && !this.options.piManagedStorage) invalid('Pi managed environments require S3 Files and Session checkpoints', 'environment');
    const vaultIds = [...new Set(input.vault_ids ?? [])];
    const tools = preparationTools(preparation, input);
    const environment = await this.options.execution.prepare(ownerId, id, input.environment, agent, vaultIds, tools, Boolean(integrationId), preparation.placement ?? 'microvm', preparation.runtime?.kind ?? 'codex');
    const session: AgentSession = {
      id, object: 'agent.session', agent, created_at: now, last_active_at: now,
      environment, error: null, metadata: input.metadata ?? {}, status: 'idle',
      required_actions: [], usage: null, vault_ids: vaultIds,
    };
    const admitted = configurationRef({ kind: 'session', id }, 1);
    const empty: SessionState = { ...(preparation.workloadAdmission !== undefined ? { workloadAdmission: preparation.workloadAdmission } : {}), configuration: { admitted, current: admitted }, session, runtime: preparation.runtime ?? CODEX_RUNTIME, placement: preparation.placement ?? 'microvm', turns: [], receipts: {}, deletedArtifacts: [], ...restored };
    const events: AgentSessionInputParam[] = messages.length ? [{ type: 'agent.session.input.message', input: messages }] : [];
    const state = events.length ? this.plan(empty, { session, turns: [] }, events, 'initial', undefined, caller) : empty;
    try {
      const resource = { id, ownerId, collection: 'sessions', createdAt: now, revision: 1, value: state };
      const prepared = await this.options.store.get<SessionPreparation>(ownerId, 'session_preparations', id) ?? resourceNotFound();
      if (prepared.value.created) return (await this.required(ownerId, id)).value.session;
      requireActivePreparation(prepared.value, this.clock.now());
      const history = planConfigurationRevision(ownerId, admitted, sessionConfigurationSnapshot(state, preparation.sourceAgent ? { sourceAgent: preparation.sourceAgent } : {}), null, now, 'created', callerConfiguration(caller));
      await commitConfiguration(this.options.store, [{ resource, expectedRevision: 0 }, { resource: { ...prepared, revision: prepared.revision + 1, value: { ...prepared.value, created: true } }, expectedRevision: prepared.revision }, history], [history]);
    }
    catch (error) {
      const committed = await this.options.store.get<SessionState>(ownerId, 'sessions', id).catch(() => undefined);
      if (!committed) throw error;
      return committed.value.session;
    }
    return (await this.observe(ownerId, state)).session;
  }

  /** Import is idempotent and idle. A later ordinary message admits new execution. */
  public async import(ownerId: string, raw: unknown): Promise<AgentSession> {
    const input = parseAgentsContract('SessionImport', raw);
    if (input.version !== 1 || !/^[a-f0-9-]{36}$/.test(input.transfer_id) || !/^sess_[a-zA-Z0-9_-]+$/.test(input.source_session_id)) invalid('Invalid transfer identity');
    if (input.history.length > 10_000 || Buffer.byteLength(JSON.stringify(input.history)) > 2 * 1024 * 1024) invalid('Transfer history exceeds 2 MiB');
    if (initialMessages(input.session.input).length || input.session.agent_id || input.session.vault_ids?.length || input.session.environment.type === 'self_hosted') invalid('Transfers require inline settings, destination credentials and no initial input');
    if (input.session.agent?.tools?.some(tool => !['function', 'web_search', 'programmatic_tool_calling', 'tool_search'].includes(tool.type))) invalid('Reconnect credential-backed tools at the destination before using them');
    const digest = hash(canonicalJson(input));
    const id = `sess_${hash(canonicalJson([ownerId, input.transfer_id])).slice(0, 32)}`;
    const prior = await this.options.store.get<{ digest: string }>(ownerId, 'session_imports', id);
    if (prior && prior.value.digest !== digest) throw new AgentsApiError(409, 'This transfer ID already belongs to different content.', 'idempotency_conflict');
    if (!prior) {
      try { await this.options.store.put({ ownerId, id, collection: 'session_imports', createdAt: this.clock.now(), revision: 1, value: { digest } }, 0); }
      catch (error) {
        const winner = await this.options.store.get<{ digest: string }>(ownerId, 'session_imports', id);
        if (!winner || winner.value.digest !== digest) throw error;
      }
    }
    return this.create(ownerId, { ...input.session, input: undefined, stream: false }, id, undefined, {
      importedHistory: input.history, importedFrom: { sessionId: input.source_session_id, transferId: input.transfer_id },
    });
  }

  public async snapshotForTransfer<T>(ownerId: string, id: string, readWorkspace: (session: AgentSession) => Promise<T>) {
    await this.flushFeedback(ownerId, id, true);
    await this.completeReadyTurns(ownerId, id);
    const resource = await this.configuredMutable(ownerId, id);
    const observation = await this.observe(ownerId, resource.value);
    if (observation.session.status !== 'idle' || observation.session.required_actions.length) throw new AgentsApiError(409, 'Wait for the Session to finish before transferring it.', 'session_busy');
    if ((await this.options.execution.environment?.(ownerId, observation.session))?.status === 'pending') throw new AgentsApiError(409, 'Wait for environment setup to finish before transferring it.', 'session_busy');
    const lockId = randomUUID();
    await this.replace(resource, { ...resource.value, forkLock: { id: lockId, expiresAt: this.clock.now() + 300 } });
    try {
      if (await this.hasPendingFeedback(ownerId, id) || Object.values(resource.value.receipts).some(receipt => !receipt.dispatched)) throw new AgentsApiError(409, 'Wait for accepted input before transferring it.', 'session_busy');
      const history = [...resource.value.fork?.history ?? [], ...await this.allItems(ownerId, resource.value)];
      // Stop writers before reading workspace content; never snapshot a live agent.
      await this.options.execution.close?.(ownerId, observation.session);
      const workspace = await readWorkspace(observation.session);
      const current = await this.required(ownerId, id);
      if (current.value.forkLock?.id !== lockId || current.value.forkLock.expiresAt <= this.clock.now()) throw new AgentsApiError(409, 'The transfer snapshot expired. Retry.', 'session_busy');
      return { session: observation.session, history, workspace };
    } finally {
      const current = await this.options.store.get<SessionState>(ownerId, 'sessions', id);
      if (current?.value.forkLock?.id === lockId) {
        const { forkLock: _lock, ...value } = current.value;
        await this.replace(current, value);
      }
    }
  }

  public async beginShare(ownerId: string, id: string, operationId: string, companion?: { resource: AgentResource<unknown>; expectedRevision: number }) {
    const resource = await this.configuredMutable(ownerId, id).catch(async error => {
      const current = await this.required(ownerId, id);
      if (current.value.share?.operationId !== operationId) throw error;
      return current;
    });
    if (resource.value.share) {
      if (companion) throw new AgentsApiError(409, 'This Session already belongs to a Share operation.', 'share_conflict');
      return;
    }
    const updated = { ...resource, revision: resource.revision + 1, value: { ...resource.value, share: { operationId, phase: 'quiescing' as const } } };
    await this.options.store.commit([{ resource: updated, expectedRevision: resource.revision }, ...(companion ? [companion] : [])]);
  }

  public async snapshotForShare<T>(ownerId: string, id: string, operationId: string, readWorkspace: (session: AgentSession) => Promise<T>) {
    await this.beginShare(ownerId, id, operationId);
    await this.flushFeedback(ownerId, id, true);
    await this.completeReadyTurns(ownerId, id);
    let resource = await this.required(ownerId, id);
    if (resource.value.share?.operationId !== operationId || !['quiescing', 'frozen'].includes(resource.value.share.phase)) throw new AgentsApiError(409, 'The source Session cannot be snapshotted.', 'session_shared');
    const observation = await this.observe(ownerId, resource.value);
    if (observation.session.status !== 'idle' || observation.session.required_actions.length || observation.turns.some(({ turn }) => !terminalTurn(turn))
      || Object.values(resource.value.receipts).some(receipt => !receipt.dispatched) || await this.hasPendingFeedback(ownerId, id)) throw new AgentsApiError(409, 'Waiting for accepted work to finish.', 'session_busy');
    if ((await this.options.execution.environment?.(ownerId, observation.session))?.status === 'pending') throw new AgentsApiError(409, 'Waiting for environment setup to finish.', 'session_busy');
    if (!this.options.execution.close) throw new AgentsApiError(503, 'The source executor cannot confirm shutdown.', 'share_unavailable');
    if (resource.value.share.phase !== 'frozen') resource = await this.replace(resource, { ...resource.value, share: { operationId, phase: 'frozen' } });
    await this.options.execution.close(ownerId, observation.session);
    await this.completeReadyTurns(ownerId, id);
    resource = await this.required(ownerId, id);
    const state = resource.value;
    const history = new ConfigurationHistory(this.options.store);
    const admitted = await history.retrieve(ownerId, { kind: 'session', id }, state.configuration!.admitted.revision);
    const current = await history.retrieve(ownerId, { kind: 'session', id }, state.configuration!.current.revision);
    const sourceAgent = await this.options.agents.retrieve(ownerId, state.session.agent.id).catch(error => {
      if (error instanceof AgentsApiError && error.status === 404) return undefined;
      throw error;
    });
    return { state: { ...state, session: observation.session }, admission: { admitted, current, ...(state.workloadAdmission !== undefined ? { workload: state.workloadAdmission } : {}) }, sourceAgent, workspace: await readWorkspace(observation.session) };
  }

  public async beginAbortShare(ownerId: string, id: string, operationId: string, companion: { resource: AgentResource<unknown>; expectedRevision: number }) {
    const resource = await this.required(ownerId, id);
    if (resource.value.share?.operationId !== operationId || resource.value.share.phase === 'released') throw new AgentsApiError(409, 'Released Shares cannot return to local execution.', 'session_shared');
    await this.options.store.commit([{ resource: { ...resource, revision: resource.revision + 1,
      value: { ...resource.value, share: { ...resource.value.share, phase: 'aborting' as const } } }, expectedRevision: resource.revision }, companion]);
  }

  public async abortShare(ownerId: string, id: string, operationId: string, companion: { resource: AgentResource<unknown>; expectedRevision: number }) {
    const resource = await this.required(ownerId, id);
    if (resource.value.share?.operationId !== operationId || resource.value.share.phase !== 'aborting') throw new AgentsApiError(409, 'Share cancellation is not fenced.', 'session_shared');
    const { share: _share, ...value } = resource.value;
    await this.options.store.commit([{ resource: { ...resource, revision: resource.revision + 1, value }, expectedRevision: resource.revision }, companion]);
  }

  public async releaseShare(ownerId: string, id: string, operationId: string, digest: string, destination: { endpoint: string; spaceId: string }) {
    const resource = await this.required(ownerId, id);
    const share = resource.value.share;
    if (share?.operationId !== operationId || !['frozen', 'released'].includes(share.phase) || share.digest && share.digest !== digest) throw new AgentsApiError(409, 'Share release does not match the frozen source.', 'share_conflict');
    if (share.phase === 'released') return;
    await this.replace(resource, { ...resource.value, share: { operationId, digest, destination, phase: 'released' } });
  }

  public async activateShare(ownerId: string, request: import('./session-share-types.js').ShareStageRequest, artifacts: import('./session-ports.js').SavedSessionArtifact[], evidence: unknown) {
    const { manifest, digest } = request;
    const id = manifest.session.id;
    this.requireRuntimeAllowed(manifest.runtime, manifest.session.agent);
    validateRuntimeAgent(manifest.runtime, manifest.session.agent, manifest.environment);
    const existing = await this.options.store.get<SessionState>(ownerId, 'sessions', id);
    if (existing) {
      if (existing.value.sharedFrom?.operationId !== manifest.operation_id || existing.value.sharedFrom.digest !== digest) throw new AgentsApiError(409, 'This Session identity already exists.', 'share_conflict');
      return existing.value.session;
    }
    const environmentInput = manifest.environment.type === 'none' ? manifest.environment : {
      ...manifest.environment, files: request.workspace_file_ids.map((file_id, index) => ({ type: 'file_id' as const, file_id, path: `/workspace/.rat-transfer/part-${index}` })),
      setup_commands: [{ command: restoreWorkspaceCommand(manifest.workspace.sha256, request.workspace_file_ids.length) }],
    };
    const placement = this.options.execution.placement?.(ownerId) ?? 'microvm';
    const environment = await this.options.execution.prepare(ownerId, id, environmentInput, manifest.session.agent, [], manifest.session.agent.tools, true, placement, manifest.runtime.kind);
    const session = { ...manifest.session, environment, status: 'idle' as const, required_actions: [], vault_ids: [] };
    const admitted = configurationRef({ kind: 'session', id }, 1);
    const value: SessionState = {
      configuration: { admitted, current: admitted }, sharedFrom: { operationId: manifest.operation_id, digest, admission: { source: { provenance: { kind: 'imported', operation_id: manifest.operation_id }, evidence: manifest.admission }, destination: evidence } },
      session, runtime: manifest.runtime, placement, workloadAdmission: evidence,
      turns: manifest.turns.map(turn => ({ ...turn, input: turn.input.map(message => importedSessionMessage(message, manifest.operation_id)), savedArtifacts: artifacts.filter(artifact => artifact.artifact.turn_id === turn.turn.id) })),
      subagents: manifest.subagents.map(subagent => ({ ...subagent, artifacts: artifacts.filter(artifact => subagent.turns.some(turn => turn.id === artifact.artifact.turn_id)) })),
      importedHistory: manifest.imported_history, receipts: {}, deletedArtifacts: manifest.deleted_artifacts,
      archivedInputs: importedSessionReceipts(manifest.inputs, manifest.operation_id), inputSequence: manifest.inputs.length,
    };
    const revision = planConfigurationRevision(ownerId, admitted, sessionConfigurationSnapshot(value), null, this.clock.now(), 'created');
    await commitConfiguration(this.options.store, [{ resource: { ownerId, id, collection: 'sessions', createdAt: session.created_at, revision: 1, value }, expectedRevision: 0 }, revision], [revision]);
    return session;
  }

  public async traces(ownerId: string, id: string, raw: unknown = {}) {
    const query = parseAgentsContract('TraceList', raw);
    const { value } = await this.required(ownerId, id);
    const observation = await this.observe(ownerId, value);
    const roots = await Promise.all(value.turns.map(async binding => ({
      turn: observation.turns.find(entry => entry.turn.id === binding.turn.id)?.turn ?? binding.turn,
      steps: [...new Map([...(binding.savedTraceSteps ?? []), ...await this.options.execution.traceSteps?.(ownerId, value.session, binding.turn.id) ?? []].map(step => [step.id, step])).values()],
      model: binding.modelSettings?.model ?? value.session.agent.model,
    })));
    const children = await this.subagentSnapshots(ownerId, value);
    const traces = projectSessionTraces(value.session, [...roots, ...children.flatMap(entry => entry.traceTurns ?? entry.turns.map(turn => ({ turn, steps: [], parentAgentId: entry.subagent.parent_agent_id })))], ownerId);
    const page = cursorPage(traces, query);
    return { ...page, first_id: page.data[0]?.id ?? null, last_id: page.data.at(-1)?.id ?? null };
  }

  public async runtimePinFor(ownerId: string, agentId: string, runtime?: import('../domain/session-runtime.js').SessionRuntime) {
    const saved = await this.options.agents.retrieve(ownerId, agentId);
    return resolveRuntime(runtime ? { rat_things_runtime: runtime } : undefined, saved.metadata, this.options.piCatalog ?? []);
  }

  public async runtime(ownerId: string, id: string) {
    const { value } = await this.required(ownerId, id);
    const pin = value.runtime ?? CODEX_RUNTIME;
    return pin.kind === 'codex' ? { runtime: 'codex' as const, model: value.session.agent.model }
      : { runtime: 'pi' as const, version: pin.engine, catalog_digest: pin.catalogDigest, model: value.session.agent.model };
  }

  private requireRuntimeAllowed(runtime: import('../domain/session-runtime.js').RuntimePin, agent: AgentSession['agent']): void {
    if (runtime.kind !== 'pi') return;
    const model = piModel(runtime, agent.model);
    if (!this.options.piCatalog?.some(current => canonicalJson(current) === canonicalJson(model))) invalid('This Pi model has been revoked by the deployment', 'agent.model');
  }

  public async lineage(ownerId: string, id: string) {
    const fork = (await this.required(ownerId, id)).value.fork;
    return { forked_from: fork ? { session_id: fork.sourceSessionId, turn_id: fork.checkpoint.lastRootTurnId, created_at: fork.createdAt } : null };
  }

  public async fork(ownerId: string, sourceId: string, raw: unknown = {}, caller?: SessionCaller): Promise<AgentSession> {
    const resource = await this.configuredMutable(ownerId, sourceId);
    const observesSource = (entry: import('./agents-ports.js').AgentObservation) => entry.ownerId === ownerId && entry.collection === 'sessions' && entry.id === sourceId;
    if (caller?.observations?.some(entry => observesSource(entry) && entry.revision !== resource.revision)) throw new AgentsApiError(409, 'The source Session changed after admission.', 'conflict');
    const acceptedCaller = caller?.observations ? { ...caller, observations: caller.observations.filter(entry => !observesSource(entry)) } : caller;
    const workloadAdmission = caller?.admission ?? resource.value.workloadAdmission;
    const observation = await this.observe(ownerId, resource.value);
    const input = planSessionFork(observation.session, raw);
    const runtime = resource.value.runtime ?? CODEX_RUNTIME;
    assertRuntimeUnchanged(runtime, input.metadata);
    this.requireRuntimeAllowed(runtime, observation.session.agent);
    if (!observation.turns.some(entry => entry.turn.subagent_id === null && terminalTurn(entry.turn))) invalid('Complete a root Turn before forking this Session', 'session_id');
    if (!this.options.execution.prepareFork) throw new AgentsApiError(503, 'Session forks are not configured.', 'fork_unavailable');
    const now = this.clock.now();
    const id = this.ids.next('sess');
    await this.options.rateLimit?.admit(ownerId, `session:${id}`);
    const placement = resource.value.placement ?? 'microvm';
    const agent = { ...observation.session.agent, tools: observation.session.agent.tools.filter(tool => tool.type !== 'function' || tool.name !== THREAD_RELEASE_TOOL.name) };
    await this.replace(resource, { ...resource.value, forkLock: { id, expiresAt: now + 300 } }, acceptedCaller);
    let fork: SessionFork | undefined;
    let committed = false;
    let commitAttempted = false;
    try {
      if (await this.hasPendingFeedback(ownerId, sourceId) || Object.values(resource.value.receipts).some(receipt => !receipt.dispatched)) throw new AgentsApiError(409, 'Wait for accepted input before forking it.', 'session_busy');
      // Credentials are prepared against a durable child identity before any secret creation.
      const preparation: SessionPreparation = { workloadAdmission, runtime, agent, placement, now, deadline: now + 300,
        requestDigest: hash(canonicalJson([sourceId, input])), inheritedTools: [] };
      await this.options.store.put({ ownerId, id, collection: 'session_preparations', createdAt: now, revision: 1, value: preparation }, 0);
      const prepared = await this.options.execution.prepareFork(ownerId, id, observation.session, input.network, input.vaultIds, placement);
      fork = { ...prepared.fork, createdAt: now, history: [...resource.value.fork?.history ?? [], ...await this.allItems(ownerId, resource.value)] };
      const latest = observation.turns.filter(entry => entry.turn.subagent_id === null).at(-1)?.turn;
      if (fork.checkpoint.lastRootTurnId !== (latest?.id ?? null)) throw new AgentsApiError(409, 'Source changed during checkpoint preparation.', 'session_busy');
      const session: AgentSession = { id, object: 'agent.session', agent, created_at: now, last_active_at: now,
        environment: prepared.environment, error: null, metadata: input.metadata, status: 'idle', required_actions: [], usage: null, vault_ids: input.vaultIds };
      const admitted = configurationRef({ kind: 'session', id }, 1);
      const empty: SessionState = { workloadAdmission, configuration: { admitted, current: admitted }, session, runtime, placement, fork, turns: [], receipts: {}, deletedArtifacts: [] };
      const messages = initialMessages(input.input);
      const state = messages.length ? this.plan(empty, { session, turns: [] }, [{ type: 'agent.session.input.message', input: messages }], 'initial', undefined, caller) : empty;
      const current = await this.required(ownerId, sourceId);
      if (current.value.forkLock?.id !== id || current.value.forkLock.expiresAt <= this.clock.now()) throw new AgentsApiError(409, 'Fork preparation expired.', 'session_busy');
      const preparedResource = await this.options.store.get<SessionPreparation>(ownerId, 'session_preparations', id) ?? resourceNotFound();
      requireActivePreparation(preparedResource.value, this.clock.now());
      const history = planConfigurationRevision(ownerId, admitted, sessionConfigurationSnapshot(state, { sourceSession: resource.value.configuration.current }), null, now, 'created', callerConfiguration(caller));
      commitAttempted = true;
      await commitConfiguration(this.options.store, [
        { resource: { ownerId, id, collection: 'sessions', createdAt: now, revision: 1, value: state }, expectedRevision: 0 },
        { resource: { ...current, revision: current.revision + 1 }, expectedRevision: current.revision },
        { resource: { ...preparedResource, revision: preparedResource.revision + 1, value: { ...preparedResource.value, created: true } }, expectedRevision: preparedResource.revision }, history,
      ], [history]);
      committed = true;
      return session;
    } catch (error) {
      const winner = await this.options.store.get<SessionState>(ownerId, 'sessions', id).catch(() => {
        // An ambiguous successful commit may already have dispatched the child.
        // Keep its lease intact until a subsequent read or expiry resolves it.
        committed = commitAttempted;
        return undefined;
      });
      if (winner) { committed = true; return winner.value.session; }
      throw error;
    } finally {
      if (!committed) {
        if (fork) await this.options.execution.releaseFork?.(ownerId, fork).catch(() => {});
        const current = await this.options.store.get<SessionState>(ownerId, 'sessions', sourceId);
        if (current && current.value.forkLock?.id === id) {
          const { forkLock: _lock, ...value } = current.value;
          await this.replace(current, value).catch(() => {});
        }
      }
    }
  }

  public async retrieve(ownerId: string, id: string): Promise<AgentSession> {
    return (await this.observe(ownerId, (await this.required(ownerId, id)).value)).session;
  }

  public async streamSnapshot(ownerId: string, id: string): Promise<SessionStreamSnapshot> {
    const { value } = await this.required(ownerId, id);
    const committed = await this.options.store.get<SessionStreamSnapshot>(ownerId, 'session_observations', id);
    if (committed) return { ...committed.value, eventRevision: committed.revision };
    const observation = await this.observe(ownerId, value);
    const environment = await this.options.execution.environment?.(ownerId, value.session);
    const subagents = await this.subagentSnapshots(ownerId, value);
    return {
      inputs: sessionInputs(value),
      session: observation.session, turns: observation.turns.map(({ turn }) => turn), items: [...await this.allItems(ownerId, value), ...subagents.flatMap((entry) => entry.items)],
      subagents: subagents.map((entry) => entry.subagent),
      failures: Object.entries(value.receipts).flatMap(([id, receipt]) => receipt.failure ? [{ id, ...receipt.failure }] : []),
      ...(environment ? { environment } : {}),
    };
  }

  public async activity(ownerId: string, id: string, caller?: SessionCaller) {
    await validateSessionCaller(caller);
    const pending = await this.pendingFeedback(ownerId, id);
    const snapshot = await this.streamSnapshot(ownerId, id);
    if (snapshot.eventRevision === undefined) throw new AgentsApiError(503, 'Durable activity is unavailable.', 'activity_unavailable');
    const visible = pending.filter(input => !(snapshot.inputs ?? []).some(receipt => receipt.id === input.id));
    const activity = sessionActivity(snapshot, snapshot.eventRevision, caller?.permissions);
    await validateSessionCaller(caller);
    return { ...activity,
      cursor: `${activity.cursor}.${feedbackDigest(visible.map(input => [input.id, input.value.digest])).slice(0, 16)}`,
      pending_inputs: visible.map(input => ({ receipt_id: input.id, messages: input.value.messages })),
      inputs: [...activity.inputs, ...visible.map((input, index) => ({ id: input.id, actor: input.value.actor,
        provenance: { kind: 'authenticated' as const }, sequence: Math.max(0, ...activity.inputs.map(receipt => receipt.sequence)) + index + 1,
        status: 'accepted' as const, accepted_at: input.value.acceptedAtMs / 1_000, turn_ids: [], message_ids: input.value.messages.map(message => message.id),
      }))],
    };
  }

  /** Activity is a latest-state feed. Public Agents events remain individually replayable. */
  public async *activityEvents(ownerId: string, id: string, signal: AbortSignal, options: SessionFollowOptions = {}) {
    await options.revalidate?.();
    const interval = Math.min(this.options.streamIntervalMs ?? 500, 2_000);
    const polling = this.activityPolling.subscribe(JSON.stringify([ownerId, id]), interval, () => this.activity(ownerId, id));
    try {
    let current = await polling.read();
    if (options.after !== undefined && activityRevision(id, options.after) > activityRevision(id, current.cursor)) throw new AgentsApiError(400, 'Activity cursor is ahead of this Session.', 'invalid_cursor');
    let cursor = options.after;
    while (!signal.aborted) {
      if (cursor !== current.cursor) {
        await options.revalidate?.();
        cursor = current.cursor;
        performanceCount('ActivityEventCount');
        yield { type: 'rat.session.activity' as const, event_id: current.cursor, activity: current };
      }
      try { await delay(interval, undefined, { signal }); }
      catch (error) { if (signal.aborted) return; throw error; }
      await options.revalidate?.();
      performanceCount('ActivityPollCount');
      current = await polling.read();
    }
    } finally { polling.release(); }
  }

  public async *stream(ownerId: string, id: string, signal: AbortSignal, created = false, baseline?: SessionStreamSnapshot, options: SessionFollowOptions = {}) {
    await options.revalidate?.();
    const subscription = baseline ?? await this.streamSnapshot(ownerId, id);
    if (subscription.eventRevision !== undefined) {
      yield* this.committedStream(ownerId, id, signal, created, subscription, options);
      return;
    }
    let previous = baseline;
    let first = true;
    let initialTurn: string | undefined;
    while (!signal.aborted) {
      await options.revalidate?.();
      const current = await this.streamSnapshot(ownerId, id);
      if (first && !created && !previous) previous = current;
      if (first && created) initialTurn = current.turns[0]?.id;
      for (const event of planSessionStream(previous, current, first && created)) {
        await options.revalidate?.();
        yield { ...event, event_id: this.ids.next('evt') };
      }
      previous = current;
      first = false;
      if (created && (!initialTurn || current.turns.some((turn) => turn.id === initialTurn && terminalTurn(turn)))) return;
      try { await delay(Math.min(this.options.streamIntervalMs ?? 500, 2_000), undefined, { signal }); }
      catch (error) { if (signal.aborted) return; throw error; }
    }
  }

  private async *committedStream(ownerId: string, id: string, signal: AbortSignal, created: boolean, baseline: SessionStreamSnapshot, options: SessionFollowOptions) {
    const cursor = options.after?.match(new RegExp(`^evt_${id}_(\\d{16})_(\\d+)$`));
    if (options.after && !cursor) throw new AgentsApiError(400, 'Invalid stream cursor.', 'invalid_cursor');
    let revision = cursor ? Number(cursor[1]) - 1 : created ? 0 : baseline.eventRevision!;
    if (revision >= baseline.eventRevision! && cursor) throw new AgentsApiError(400, 'Stream cursor is ahead of this Session.', 'invalid_cursor');
    const initialTurn = created ? baseline.turns.find((turn) => turn.subagent_id === null)?.id : undefined;
    let completed = false;
    while (!signal.aborted) {
      await options.revalidate?.();
      await this.required(ownerId, id);
      const head = await this.options.store.get<SessionStreamSnapshot>(ownerId, 'session_observations', id) ?? resourceNotFound();
      while (revision < head.revision && !signal.aborted) {
        const batch = await this.options.store.get<SessionEventBatch>(ownerId, 'session_event_batches', sessionEventBatchId(id, revision + 1));
        if (!batch) throw new AgentsApiError(409, 'Stream history expired. Reconnect and retrieve saved state.', 'stream_history_expired');
        for (const event of batch.value.events) {
          if (signal.aborted) return;
          if (cursor && revision + 1 === Number(cursor[1]) && Number(event.event_id.split('_').at(-1)) <= Number(cursor[2])) continue;
          await options.revalidate?.();
          yield event;
          if (created && 'turn' in event && event.turn.id === initialTurn && terminalTurn(event.turn)) completed = true;
        }
        revision++;
        if (created && (completed || !initialTurn)) return;
      }
      try { await delay(Math.min(this.options.streamIntervalMs ?? 500, 2_000), undefined, { signal }); }
      catch (error) { if (signal.aborted) return; throw error; }
    }
  }

  public async update(ownerId: string, id: string, raw: unknown, mutation: ConfigurationMutation = {}): Promise<AgentSession> {
    const input = parseAgentsContract('SessionUpdate', raw);
    validateAgentMetadata(input.metadata);
    const resource = await this.configuredMutable(ownerId, id);
    const observation = await this.observe(ownerId, resource.value);
    const session = {
      ...observation.session,
      agent: updateSessionAgent(resource.value.session.agent, input.agent, resource.value.runtime ?? CODEX_RUNTIME),
      metadata: input.metadata === undefined ? resource.value.session.metadata : input.metadata ?? {},
    };
    assertRuntimeUnchanged(resource.value.runtime ?? CODEX_RUNTIME, input.metadata);
    this.requireRuntimeAllowed(resource.value.runtime ?? CODEX_RUNTIME, session.agent);
    const ref = configurationRef({ kind: 'session', id }, resource.revision + 1);
    const before = await new ConfigurationHistory(this.options.store).retrieve(ownerId, { kind: 'session', id }, resource.value.configuration.current.revision);
    const provenance = before.snapshot?.kind === 'session' ? before.snapshot.configuration : undefined;
    const value = { ...resource.value, session, configuration: { admitted: resource.value.configuration.admitted, current: ref } };
    const history = planConfigurationRevision(ownerId, ref, sessionConfigurationSnapshot(value, { ...(provenance?.sourceAgent ? { sourceAgent: provenance.sourceAgent } : {}), ...(provenance?.sourceSession ? { sourceSession: provenance.sourceSession } : {}) }), before.snapshot, this.clock.now(), 'updated', mutation);
    await commitConfiguration(this.options.store, [{ resource: { ...resource, revision: resource.revision + 1, value }, expectedRevision: resource.revision }, history], [history]);
    return session;
  }

  public async list(ownerId: string, raw: unknown = {}) {
    const query = parseAgentsContract('SessionList', raw);
    const limit = pageLimit(query.limit);
    let after = query.after;
    const selected: AgentResource<SessionState>[] = [];
    // Apply the filter before cutting the page; a sparse agent filter must not strand later matches.
    do {
      const page = await this.options.store.list<SessionState>(ownerId, 'sessions', { limit: 100, ...(query.order ? { order: query.order } : {}), ...(after ? { after } : {}) });
      selected.push(...page.data.filter(({ value }) => !query.agent_id || value.session.agent.id === query.agent_id));
      if (selected.length > limit || !page.has_more) break;
      after = page.data.at(-1)?.id;
    } while (after);
    const data = await Promise.all(selected.slice(0, limit).map(({ value }) => this.observe(ownerId, value).then((item) => item.session)));
    return { object: 'list' as const, data, has_more: selected.length > limit, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null };
  }

  public async delete(ownerId: string, id: string): Promise<AgentSessionDeleted> {
    let resource: AgentResource<SessionState> = await ensureSessionConfiguration(this.options.store, await this.required(ownerId, id), this.clock.now());
    if (!resource.value.closing) {
      requireSessionMutable(resource.value, this.clock.now());
      const runtime = await this.options.store.get<import('./session-runtime-store.js').StoredSessionRuntime>(ownerId, 'session_runtime', id);
      const closing = { ...resource, revision: resource.revision + 1, value: { ...resource.value, closing: true } };
      const integration = await this.options.store.get<SessionIntegrationState>(ownerId, 'session_integrations', id);
      const subscription = integration?.value.threadSubscriptionId ? await this.options.store.get<ThreadSubscription>(ownerId, 'thread_subscriptions', integration.value.threadSubscriptionId) : undefined;
      const released = subscription ? releaseThreadSubscription(subscription.value, id, 'session_deleted') : undefined;
      await this.options.store.commit([{ resource: closing, expectedRevision: resource.revision },
        ...(subscription && released !== subscription.value ? [{ resource: { ...subscription, revision: subscription.revision + 1, value: released }, expectedRevision: subscription.revision }] : []),
        { resource: planRuntimeClosure(ownerId, id, this.clock.now(), runtime), expectedRevision: runtime?.revision ?? 0 }]);
      resource = closing;
    }
    // Closing the whole harness also revokes queued input. It must remain possible
    // when a Turn never reached the worker or the observation channel is unavailable.
    if (this.options.execution.close) await this.options.execution.close(ownerId, resource.value.session);
    else {
      const observation = await this.observe(ownerId, resource.value);
      for (const { turn } of observation.turns.filter(({ turn }) => !terminalTurn(turn))) {
        await this.options.execution.cancel(ownerId, observation.session, turn.id);
      }
    }
    await this.options.store.delete(resource);
    return { id, object: 'agent.session.deleted', deleted: true };
  }

  public async events(ownerId: string, id: string, raw: unknown, idempotencyKey?: string, response?: { waitForConnection: boolean; signal?: AbortSignal; caller?: SessionCaller }): Promise<void> {
    const acceptedStarted = performance.now();
    const { events } = parseAgentsContract('SessionEvents', raw);
    if (idempotencyKey !== undefined && (!idempotencyKey || idempotencyKey.length > 256)) invalid('Idempotency-Key must contain 1–256 characters', 'Idempotency-Key');
    const caller = response?.caller;
    const requestKey = idempotencyKey ?? this.ids.next('request');
    const key = hash(caller ? canonicalJson([caller.actor.id, requestKey]) : requestKey);
    const digest = hash(canonicalJson(events));
    if (caller && events.length && events.every((event): event is FeedbackEvent => event.type === 'agent.session.input.message')) {
      const environmentType = await this.acceptFeedback(ownerId, id, events, key, digest, caller);
      performanceCount('SubmissionAcceptedDuration', performance.now() - acceptedStarted);
      if (response?.waitForConnection && environmentType === 'self_hosted') {
        await this.flushFeedback(ownerId, id, true);
        await performancePhase('InputConnectionDuration', () => this.waitForInputConnection(ownerId, id, key, response.signal));
      }
      return;
    }
    if (events.some(event => event.type === 'agent.session.input.cancel')) await this.flushFeedback(ownerId, id, true);
    for (let attempt = 0; attempt < 10; attempt++) {
      let resource = await this.required(ownerId, id);
      requireSessionMutable(resource.value, this.clock.now());
      if (!resource.value.receipts[key]) {
        resource = await ensureSessionConfiguration(this.options.store, resource, this.clock.now());
        requireSessionMutable(resource.value, this.clock.now());
      }
      const previous = resource.value.receipts[key];
      if (previous) {
        await validateSessionCaller(caller);
        if (previous.digest !== digest) throw new AgentsApiError(409, 'This Idempotency-Key was used with different events.', 'idempotency_conflict');
        break;
      }
      const observation = await this.observe(ownerId, resource.value);
      const items = await this.allItems(ownerId, resource.value);
      const anchors = Object.fromEntries(resource.value.turns.map(({ turn }) => [turn.id, items.filter((item) => item.turn_id === turn.id).at(-1)?.id ?? null]));
      const planned = this.plan(resource.value, observation, events, key, anchors, caller);
      const messages = events.filter(event => event.type === 'agent.session.input.message').length;
      if (messages) await this.options.rateLimit?.admit(ownerId, `input:${id}:${key}`, messages);
      try { await this.replace(resource, planned, caller); break; }
      catch (error) {
        // Background dispatch/history writes share this revision. Re-read and
        // replan only a rejected CAS; ambiguous writes retain the same receipt
        // for a caller retry, and a deletion must remain a 404.
        if (!(error instanceof AgentsApiError) || error.status !== 409 || error.code !== 'conflict') throw error;
        performanceCount('SubmissionConflicts');
        if (attempt === 9) throw error;
      }
    }
    performanceCount('SubmissionAcceptedDuration', performance.now() - acceptedStarted);
    if (response?.waitForConnection) await this.waitForInputConnection(ownerId, id, key, response.signal);
  }

  private async waitForInputConnection(ownerId: string, id: string, key: string, signal?: AbortSignal): Promise<void> {
    if (!this.options.execution.checkInputConnection) return;
    while (true) {
      signal?.throwIfAborted();
      const { value } = await this.required(ownerId, id);
      const receipt = value.receipts[key];
      if (!receipt) { await delay(Math.min(this.options.streamIntervalMs ?? 500, 2_000), undefined, { signal }); continue; }
      if (receipt.failure) throw new AgentsApiError(receipt.failure.code === 'environment_connection_timeout' ? 408 : 400, receipt.failure.message, receipt.failure.code);
      if (value.session.environment.type !== 'self_hosted') return;
      try {
        for (const command of (receipt.batchLeader ? value.receipts[receipt.batchLeader]?.commands : receipt.commands) ?? []) {
          if (command.type !== 'start') continue;
          const binding = value.turns.find(({ turn }) => turn.id === command.turnId) ?? resourceNotFound();
          if (!binding.cancelRequested && !terminalTurn(binding.turn)) await this.options.execution.checkInputConnection(ownerId, value.session, binding.turn);
        }
        return;
      } catch (error) {
        if (!(error instanceof AgentsApiError) || error.code !== 'environment_unavailable' || error.status !== 503) throw error;
      }
      await delay(Math.min(this.options.streamIntervalMs ?? 500, 2_000), undefined, { signal });
    }
  }

  public async hasPendingFeedback(ownerId: string, id: string): Promise<boolean> {
    return (await this.options.store.list(ownerId, feedbackCollection(id), { limit: 1 })).data.length > 0;
  }

  private async pendingFeedback(ownerId: string, id: string) {
    const result: AgentResource<SessionFeedback>[] = [];
    let after: string | undefined;
    do {
      const page = await this.options.store.list<SessionFeedback>(ownerId, feedbackCollection(id), { order: 'asc', limit: 100, ...(after ? { after } : {}) });
      result.push(...page.data);
      if (!page.has_more) break;
      after = page.data.at(-1)?.id;
    } while (after);
    return result;
  }

  private async acceptFeedback(ownerId: string, id: string, events: FeedbackEvent[], key: string, digest: string, caller: SessionCaller) {
    const acceptedAtMs = this.options.nowMs?.() ?? Date.now();
    const input: AgentResource<SessionFeedback> = { ownerId, collection: feedbackCollection(id), id: key, createdAt: acceptedAtMs, revision: 1,
      value: { sessionId: id, digest, events, actor: caller.actor, acceptedAtMs,
        messages: events.flatMap(event => event.input.map(message => ({ ...message, id: this.ids.next('msg'), actor: caller.actor, provenance: { kind: 'authenticated' as const } }))),
        turnId: this.ids.next('turn'), operationId: this.ids.next('event') } };
    let rateAdmitted = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      const [initial, previous] = await performancePhase('SubmissionReadDuration', () => Promise.all([this.required(ownerId, id), this.options.store.get<SessionFeedback>(ownerId, feedbackCollection(id), key)]));
      requireSessionMutable(initial.value, this.clock.now());
      await performancePhase('SubmissionValidationDuration', () => validateSessionCaller(caller));
      const priorDigest = previous?.value.digest ?? initial.value.receipts[key]?.digest;
      if (priorDigest !== undefined) {
        if (priorDigest !== digest) throw new AgentsApiError(409, 'This Idempotency-Key was used with different events.', 'idempotency_conflict');
        return initial.value.session.environment.type;
      }
      const resource = await ensureSessionConfiguration(this.options.store, initial, this.clock.now());
      requireSessionMutable(resource.value, this.clock.now());
      // Validate before acceptance without reading execution or reconstructing history.
      this.plan(resource.value, { session: resource.value.session, turns: resource.value.turns.map(binding => ({ turn: binding.turn, requiredActions: [] })) }, events, key, undefined, caller);
      if (!rateAdmitted) {
        await performancePhase('SubmissionRateLimitDuration', async () => { await this.options.rateLimit?.admit(ownerId, `input:${id}:${key}`, events.length); });
        rateAdmitted = true;
      }
      // Revision observations fence revocation during the rate-limit/commit gap.
      // Callers without transactional observations still need a fresh check.
      if (!caller.observations?.length) await performancePhase('SubmissionValidationDuration', () => validateSessionCaller(caller));
      requireSessionCallerUnexpired(caller, Date.now());
      try {
        await performancePhase('SubmissionCommitDuration', () => this.options.store.commit([{ resource: input, expectedRevision: 0 }], [
          { ownerId, collection: 'sessions', id, revision: resource.revision }, ...caller.observations ?? [],
        ]));
        return resource.value.session.environment.type;
      } catch (error) {
        const acceptedDigest = await performancePhase('SubmissionRecoveryDuration', async () => {
          const accepted = await this.options.store.get<SessionFeedback>(ownerId, feedbackCollection(id), key).catch(() => undefined);
          const materialized = !accepted ? await this.options.store.get<SessionState>(ownerId, 'sessions', id).catch(() => undefined) : undefined;
          return accepted?.value.digest ?? materialized?.value.receipts[key]?.digest;
        });
        if (acceptedDigest === digest) return resource.value.session.environment.type;
        if (!(error instanceof AgentsApiError) || error.code !== 'conflict' || attempt === 9) throw error;
        performanceCount('SubmissionConflicts');
      }
    }
  }

  /** Close batch membership durably before any execution effect; repeated wakes use the same commands. */
  private async flushFeedback(ownerId: string, id: string, force = false): Promise<void> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const resource = await this.options.store.get<SessionState>(ownerId, 'sessions', id);
      if (!resource || resource.value.closing || resource.value.forkLock && resource.value.forkLock.expiresAt > this.clock.now() || resource.value.share && resource.value.share.phase !== 'quiescing') return;
      const entries = await this.pendingFeedback(ownerId, id);
      const already = entries.filter(entry => resource.value.receipts[entry.id]);
      for (const entry of already) await this.options.store.delete(entry).catch(error => { if (!(error instanceof AgentsApiError) || error.code !== 'conflict') throw error; });
      const window = feedbackWindow(entries.filter(entry => !resource.value.receipts[entry.id]), this.options.nowMs?.() ?? Date.now(), force);
      if (!window.inputs.length) return;
      if (window.waitMs > 0) { await delay(window.waitMs); attempt--; continue; }
      const observation = await this.observe(ownerId, resource.value);
      const items = await this.allItems(ownerId, resource.value);
      const anchors = Object.fromEntries(resource.value.turns.map(({ turn }) => [turn.id, items.filter(item => item.turn_id === turn.id).at(-1)?.id ?? null]));
      const value = planFeedbackBatch(resource.value, observation, window.inputs, this.clock.now(), anchors);
      try {
        await this.replace(resource, value);
        performanceCount('FeedbackBatchMessages', window.inputs.reduce((sum, input) => sum + input.value.messages.length, 0));
        performanceCount('FeedbackBatchCount');
        performanceCount('FeedbackCollectionDuration', Math.max(0, (this.options.nowMs?.() ?? Date.now()) - window.inputs[0]!.value.acceptedAtMs));
        for (const entry of window.inputs) await this.options.store.delete(entry).catch(error => { if (!(error instanceof AgentsApiError) || error.code !== 'conflict') throw error; });
        if (force) { attempt--; continue; }
        // A further full batch is handled by another durable wake, or the next local tick.
        return;
      } catch (error) {
        if (!(error instanceof AgentsApiError) || error.code !== 'conflict' || attempt === 9) throw error;
      }
    }
  }

  /** Called by the durable outbox consumer. Every command is retryable with the same identity. */
  public async dispatch(ownerId: string, id: string): Promise<void> {
    await this.flushFeedback(ownerId, id);
    let resource = await this.options.store.get<SessionState>(ownerId, 'sessions', id);
    if (!resource || resource.value.share && resource.value.share.phase !== 'quiescing' || resource.value.closing || resource.value.forkLock && resource.value.forkLock.expiresAt > this.clock.now()) return;
    resource = await ensureSessionConfiguration(this.options.store, resource, this.clock.now());
    if (resource.value.share && resource.value.share.phase !== 'quiescing' || resource.value.closing || resource.value.forkLock && resource.value.forkLock.expiresAt > this.clock.now()) return;
    this.requireRuntimeAllowed(resource.value.runtime ?? CODEX_RUNTIME, resource.value.session.agent);
    if (this.options.execution.initialize) {
      const completed = { ...resource.value, turns: resource.value.turns.filter(binding => terminalTurn(binding.turn)) };
      const history = [...resource.value.fork?.history ?? [], ...await this.allItems(ownerId, completed)];
      await this.options.execution.initialize(ownerId, resource.value.session, resource.value.placement ?? 'microvm', executionHistory(history, resource.value));
    }
    for (const [key, receipt] of Object.entries(resource.value.receipts).sort((left, right) => (left[1].sequence ?? 0) - (right[1].sequence ?? 0))) {
      if (receipt.dispatched || receipt.batchLeader && receipt.batchLeader !== key) continue;
      let failure: { code: string; message: string } | undefined;
      for (const command of receipt.commands) {
        const session = resource.value.session;
        try { switch (command.type) {
          case 'start': {
            const binding = resource.value.turns.find(({ turn }) => turn.id === command.turnId) ?? resourceNotFound();
            this.requireRuntimeAllowed(resource.value.runtime ?? CODEX_RUNTIME, binding.modelSettings ? { ...session.agent, ...binding.modelSettings, reasoning: { ...session.agent.reasoning, ...binding.modelSettings.reasoning } } : session.agent);
            if (binding.cancelRequested) {
              await this.options.execution.cancel(ownerId, session, command.turnId);
              const observation = await this.options.execution.observe(ownerId, session, binding.turn);
              const turn = cancelledStartTurn(observation.turn, this.clock.now());
              resource = await this.required(ownerId, id);
              resource = await this.replace(resource, { ...resource.value, turns: resource.value.turns.map((previous) => previous.turn.id === command.turnId ? {
                ...previous, turn: terminalTurn(previous.turn) ? previous.turn : turn,
              } : previous) });
            } else {
              const preceding = resource.value.turns.slice(0, resource.value.turns.findIndex(({ turn }) => turn.id === command.turnId));
              for (const previous of preceding.filter(binding => !terminalTurn(binding.turn))) {
                if (!terminalTurn((await this.options.execution.observe(ownerId, session, previous.turn)).turn)) throw new AgentsApiError(503, 'Waiting for previously accepted input to finish.', 'service_unavailable');
              }
              const history = [...resource.value.fork?.history ?? [], ...await this.allItems(ownerId, { ...resource.value, turns: preceding })];
              await this.options.execution.start(ownerId, session, { ...binding, input: executionInput(command.input) }, executionHistory(history, resource.value), resource.value.placement ?? 'microvm');
            }
            break;
          }
          case 'steer': await this.options.execution.steer(ownerId, session, command.turnId, executionInput(command.input), command.operationId); break;
          case 'cancel': await this.options.execution.cancel(ownerId, session, command.turnId); break;
          case 'tool_result': await this.options.execution.toolResult(ownerId, session, command.event); break;
        } } catch (error) {
          if (command.type === 'steer' && error instanceof SessionSteerRejectedError) {
            if (await this.rehomeRejectedSteer(ownerId, id, key, command.operationId) !== 'cancelled') return;
            failure = { code: 'active_turn_not_steerable', message: 'The submitted input was cancelled before delivery.' };
            continue;
          }
          if (!(error instanceof AgentsApiError) || error.status >= 500 || error.code === 'conflict') throw error;
          failure = { code: error.code ?? 'invalid_request', message: 'The submitted input could not be delivered.' };
          if (command.type === 'start') {
            resource = await this.required(ownerId, id);
            resource = await this.replace(resource, { ...resource.value,
              ...(key === 'initial' ? { session: { ...resource.value.session, status: 'failed', required_actions: [], error: failure.message } } : {}),
              turns: resource.value.turns.map((binding) => binding.turn.id === command.turnId ? {
              ...binding, turn: { ...binding.turn, status: 'failed', completed_at: this.clock.now(), error: { code: error.code === 'environment_connection_timeout' ? 'connection_failed' : 'invalid_request', message: failure!.message } },
            } : binding) });
          }
        }
      }
      // Re-read after effects so acknowledgement cannot discard a concurrently accepted input.
      const current = await this.options.store.get<SessionState>(ownerId, 'sessions', id);
      if (!current) {
        for (const command of receipt.commands) if (command.type === 'start') await this.options.execution.cancel(ownerId, resource.value.session, command.turnId);
        return;
      }
      if (current.value.closing) return;
      resource = current;
      resource = await this.replace(resource, {
        ...resource.value,
        receipts: Object.fromEntries(Object.entries(resource.value.receipts).map(([receiptKey, current]) => [receiptKey, receiptKey === key || current.batchLeader === key ? { ...current, dispatched: true, ...(failure ? { failure } : {}) } : current])),
      });
    }
  }

  private async rehomeRejectedSteer(ownerId: string, id: string, receiptId: string, operationId: string): Promise<'moved' | 'cancelled'> {
    const ids = { turnId: this.ids.next('turn'), operationId: this.ids.next('event') };
    for (let attempt = 0; attempt < 10; attempt++) {
      const resource = await this.required(ownerId, id);
      if (resource.value.closing) return 'moved';
      const command = resource.value.receipts[receiptId]?.commands.find(command => command.type === 'steer' && command.operationId === operationId);
      if (command && resource.value.turns.find(binding => binding.turn.id === command.turnId)?.cancelRequested) return 'cancelled';
      let value = planRejectedSteer(resource.value, receiptId, operationId, ids, this.clock.now());
      if (value === resource.value) return 'moved';
      const index = resource.value.receipts[receiptId]!.commands.indexOf(command!);
      const replacement = value.receipts[receiptId]!.commands[index]!;
      if (replacement.type === 'start' || replacement.type === 'steer') value = { ...value, receipts: Object.fromEntries(Object.entries(value.receipts).map(([key, receipt]) => [key, receipt.batchLeader === receiptId ? { ...receipt, turnIds: [replacement.turnId] } : receipt])) };
      const integration = await this.options.store.get<SessionIntegrationState>(ownerId, 'session_integrations', id);
      const integrationValue = integration && command?.type === 'steer' && (replacement.type === 'start' || replacement.type === 'steer')
        ? planIntegrationSteerRecovery(integration.value, receiptId, command.turnId, replacement.turnId) : integration?.value;
      try {
        await this.options.store.commit([{ resource: { ...resource, revision: resource.revision + 1, value }, expectedRevision: resource.revision },
          ...(integration && integrationValue !== integration.value ? [{ resource: { ...integration, revision: integration.revision + 1, value: integrationValue }, expectedRevision: integration.revision }] : []),
        ]);
        return 'moved';
      }
      catch (error) { if (!(error instanceof AgentsApiError) || error.code !== 'conflict' || attempt === 9) throw error; }
    }
    throw new AgentsApiError(409, 'Session input changed concurrently.', 'conflict');
  }

  public async turns(ownerId: string, id: string, raw: unknown = {}) {
    const query = parseAgentsContract('TurnList', raw);
    const resource = await this.required(ownerId, id);
    const observation = await this.observe(ownerId, resource.value);
    return cursorPage(observation.turns.map(({ turn }) => turn).sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id)), query);
  }

  public async turn(ownerId: string, id: string, turnId: string) {
    const resource = await this.required(ownerId, id);
    const binding = resource.value.turns.find(({ turn }) => turn.id === turnId);
    if (!binding) return (await this.subagentSnapshots(ownerId, resource.value)).flatMap((entry) => entry.turns).find((turn) => turn.id === turnId) ?? resourceNotFound();
    return terminalTurn(binding.turn) ? binding.turn : (await this.options.execution.observe(ownerId, resource.value.session, binding.turn)).turn;
  }

  public async subagents(ownerId: string, id: string, raw: unknown = {}) {
    const query = parseAgentsContract('SubagentList', raw);
    const { value } = await this.required(ownerId, id);
    return cursorPage((await this.subagentSnapshots(ownerId, value)).map((entry) => entry.subagent), query);
  }

  public async subagent(ownerId: string, id: string, subagentId: string) {
    return (await this.requiredSubagent(ownerId, id, subagentId)).subagent;
  }

  public async subagentTurns(ownerId: string, id: string, subagentId: string, raw: unknown = {}) {
    const query = parseAgentsContract('TurnList', raw);
    return cursorPage((await this.requiredSubagent(ownerId, id, subagentId)).turns, query);
  }

  public async subagentTurn(ownerId: string, id: string, subagentId: string, turnId: string) {
    return (await this.requiredSubagent(ownerId, id, subagentId)).turns.find((turn) => turn.id === turnId) ?? resourceNotFound();
  }

  public async subagentItems(ownerId: string, id: string, subagentId: string, raw: unknown = {}, turnId?: string) {
    const query = parseAgentsContract('ItemList', raw);
    const entry = await this.requiredSubagent(ownerId, id, subagentId);
    if (turnId && !entry.turns.some((turn) => turn.id === turnId)) resourceNotFound();
    return cursorPage(entry.items.filter((item) => !turnId || item.turn_id === turnId), query);
  }

  private async requiredSubagent(ownerId: string, id: string, subagentId: string) {
    return (await this.subagentSnapshots(ownerId, (await this.required(ownerId, id)).value)).find((entry) => entry.subagent.id === subagentId) ?? resourceNotFound();
  }

  private async subagentSnapshots(ownerId: string, state: SessionState) {
    const live = await this.options.execution.subagents?.(ownerId, state.session) ?? [];
    const merged = new Map((state.subagents ?? []).map((entry) => [entry.subagent.id, entry]));
    for (const entry of live) merged.set(entry.subagent.id, entry);
    return [...merged.values()].sort((a, b) => a.subagent.opened_at - b.subagent.opened_at || a.subagent.id.localeCompare(b.subagent.id)).map((entry) => ({
      ...entry, items: entry.turns.flatMap((turn) => orderedTurnItems(state, { turn, input: [] }, entry.items.filter((item) => item.turn_id === turn.id))),
    }));
  }

  /** Materialize terminal history before private execution records reach their retention limit. */
  public async completeReadyTurns(ownerId: string, id: string): Promise<void> {
    const resource = await this.options.store.get<SessionState>(ownerId, 'sessions', id);
    if (!resource) return;
    for (const binding of resource.value.turns.filter(binding => !terminalTurn(binding.turn))) this.requireRuntimeAllowed(resource.value.runtime ?? CODEX_RUNTIME, binding.modelSettings ? { ...resource.value.session.agent, ...binding.modelSettings, reasoning: { ...resource.value.session.agent.reasoning, ...binding.modelSettings.reasoning } } : resource.value.session.agent);
    if (!resource.value.closing && (!resource.value.share || resource.value.share.phase === 'quiescing')) await this.options.execution.reconcile?.(ownerId, resource.value.session);
    for (const binding of resource.value.turns) await this.completeTurn(ownerId, id, binding.turn.id);
  }

  public async completeTurn(ownerId: string, id: string, turnId: string): Promise<void> {
    const resource = await this.options.store.get<SessionState>(ownerId, 'sessions', id);
    if (!resource) return;
    const binding = resource.value.turns.find(({ turn }) => turn.id === turnId) ?? resourceNotFound();
    const observation = terminalTurn(binding.turn) ? { turn: binding.turn, requiredActions: [] } : await this.options.execution.observe(ownerId, resource.value.session, binding.turn);
    if (!terminalTurn(observation.turn)) return;
    const [savedItems, savedArtifacts, savedTraceSteps] = await Promise.all([
      binding.savedItems ?? this.options.execution.items(ownerId, resource.value.session, turnId),
      binding.savedArtifacts ?? this.options.execution.artifacts(ownerId, resource.value.session, turnId),
      this.options.execution.traceSteps?.(ownerId, resource.value.session, turnId),
    ]);
    const turns = resource.value.turns.map((previous) => previous.turn.id === turnId ? { ...previous, turn: observation.turn, savedItems, savedArtifacts, savedTraceSteps: [...new Map([...(binding.savedTraceSteps ?? []), ...(savedTraceSteps ?? [])].map(step => [step.id, step])).values()] } : previous);
    const value = { ...resource.value, turns, subagents: await this.subagentSnapshots(ownerId, resource.value) };
    if (canonicalJson(value) !== canonicalJson(resource.value)) await this.replace(resource, value);
  }

  public async items(ownerId: string, id: string, raw: unknown = {}) {
    const query = parseAgentsContract('ItemList', raw);
    const { value } = await this.required(ownerId, id);
    return cursorPage(await this.allItems(ownerId, value), query);
  }

  public async artifacts(ownerId: string, id: string, raw: unknown = {}) {
    const query = parseAgentsContract('ArtifactList', raw);
    const { value } = await this.required(ownerId, id);
    const artifacts = await this.allArtifacts(ownerId, value);
    const selected = artifacts.map(({ artifact }) => artifact)
      .filter((artifact) => !value.deletedArtifacts.includes(artifact.id)
        && (!query.environment_id || artifact.environment_id === query.environment_id))
      .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
    return cursorPage(selected, query);
  }

  public async artifact(ownerId: string, id: string, artifactId: string) {
    return (await this.savedArtifact(ownerId, id, artifactId)).artifact;
  }

  /** Trusted application integrations may publish these immutable references after owner checks. */
  public async publicationArtifacts(ownerId: string, id: string, artifactIds: readonly string[]) {
    const { value } = await this.required(ownerId, id);
    const available = await this.allArtifacts(ownerId, value);
    return artifactIds.map((artifactId) => {
      if (value.deletedArtifacts.includes(artifactId)) resourceNotFound();
      return available.find((entry) => entry.artifact.id === artifactId) ?? resourceNotFound();
    });
  }

  private async savedArtifact(ownerId: string, id: string, artifactId: string) {
    const { value } = await this.required(ownerId, id);
    if (value.deletedArtifacts.includes(artifactId)) resourceNotFound();
    return (await this.allArtifacts(ownerId, value)).find((item) => item.artifact.id === artifactId) ?? resourceNotFound();
  }

  private async allArtifacts(ownerId: string, state: SessionState) {
    const [roots, subagents] = await Promise.all([
      Promise.all(state.turns.map((binding) => binding.savedArtifacts ?? this.options.execution.artifacts(ownerId, state.session, binding.turn.id))),
      this.subagentSnapshots(ownerId, state),
    ]);
    return [...roots.flat(), ...subagents.flatMap((subagent) => subagent.artifacts ?? [])];
  }

  public async artifactContent(ownerId: string, id: string, artifactId: string) {
    const artifact = await this.savedArtifact(ownerId, id, artifactId);
    return this.options.execution.artifactContent(ownerId, await this.retrieve(ownerId, id), artifact);
  }

  public async deleteArtifact(ownerId: string, id: string, artifactId: string): Promise<SessionArtifactDeleted> {
    await this.artifact(ownerId, id, artifactId);
    const resource = await this.configuredMutable(ownerId, id);
    await this.replace(resource, { ...resource.value, deletedArtifacts: [...resource.value.deletedArtifacts, artifactId] });
    return { id: artifactId, object: 'agent.session.artifact.deleted', deleted: true };
  }

  private plan(state: SessionState, observation: SessionObservation, events: AgentSessionInputParam[], key: string, itemAnchors?: Record<string, string | null>, caller?: SessionCaller): SessionState {
    const plan = planSessionInput(state, observation, events, {
      turnIds: events.map(() => this.ids.next('turn')),
      messageIds: events.flatMap((event) => event.type === 'agent.session.input.message' ? event.input.map(() => this.ids.next('msg')) : []),
      operationIds: events.map(() => this.ids.next('event')),
      ...(itemAnchors ? { itemAnchors } : {}),
      ...(caller ? { actor: caller.actor } : {}),
    }, this.clock.now());
    for (const command of plan.commands) {
      const binding = plan.state.turns.find(entry => entry.turn.id === command.turnId);
      const agent = binding?.modelSettings ? { ...state.session.agent, ...binding.modelSettings, reasoning: { ...state.session.agent.reasoning, ...binding.modelSettings.reasoning } } : state.session.agent;
      this.requireRuntimeAllowed(state.runtime ?? CODEX_RUNTIME, agent);
      if (command.type === 'start' || command.type === 'steer') validateRuntimeInput(state.runtime ?? CODEX_RUNTIME, agent, command.input);
      if (command.type === 'tool_result' && command.event.success && Array.isArray(command.event.output)) validateRuntimeInput(state.runtime ?? CODEX_RUNTIME, agent, [{ role: 'user', content: command.event.output }]);
    }
    return { ...plan.state, inputSequence: (state.inputSequence ?? 0) + 1, receipts: {
      ...state.receipts, [key]: { digest: hash(canonicalJson(events)), commands: plan.commands, dispatched: false, ...(caller ? { actor: caller.actor, provenance: { kind: 'authenticated' as const } } : {}), sequence: (state.inputSequence ?? 0) + 1, acceptedAt: this.clock.now() },
    } };
  }

  private async observe(ownerId: string, state: SessionState): Promise<SessionObservation> {
    const observations = await Promise.all(state.turns.map(({ turn }) => terminalTurn(turn) ? { turn, requiredActions: [] } : this.options.execution.observe(ownerId, state.session, turn)));
    const subagents = await this.subagentSnapshots(ownerId, state);
    const environment = await this.options.execution.environment?.(ownerId, state.session);
    const current = state.runtime?.kind !== 'pi' && environment?.status === 'failed' ? { ...state, session: { ...state.session, status: 'failed' as const, error: 'The execution environment is unavailable. Create a new session.' } } : state;
    return observeSession(current, [...observations, ...subagents.flatMap((entry) => entry.turns.map((turn) => ({ turn, requiredActions: (entry.requiredActions ?? []).filter((action) => action.type === 'function_call' && action.turn_id === turn.id) })))]);
  }

  private async allItems(ownerId: string, state: SessionState) {
    return [...state.importedHistory ?? [], ...(await Promise.all(state.turns.map(async (binding) => orderedTurnItems(
      state, binding, binding.savedItems ?? await this.options.execution.items(ownerId, state.session, binding.turn.id),
    )))).flat()];
  }

  private async required(ownerId: string, id: string) {
    const resource = await this.options.store.get<SessionState>(ownerId, 'sessions', id) ?? resourceNotFound();
    return resource;
  }

  private async configuredMutable(ownerId: string, id: string) {
    const initial = await this.required(ownerId, id);
    requireSessionMutable(initial.value, this.clock.now());
    const resource = await ensureSessionConfiguration(this.options.store, initial, this.clock.now());
    // A rejected baseline CAS may have refreshed the resource to a fenced head.
    requireSessionMutable(resource.value, this.clock.now());
    return resource;
  }

  private async replace(resource: AgentResource<SessionState>, value: SessionState, caller?: SessionCaller) {
    const updated = { ...resource, value, revision: resource.revision + 1 };
    await validateSessionCaller(caller);
    if (caller?.observations?.length) await this.options.store.commit([{ resource: updated, expectedRevision: resource.revision }], caller.observations);
    else await this.options.store.put(updated, resource.revision);
    return updated;
  }
}

function pageLimit(limit?: number | null) {
  if (limit != null && (!Number.isInteger(limit) || limit < 1)) invalid('limit must be a positive integer', 'limit');
  return Math.min(limit ?? 20, 100);
}

const hash = (text: string): string => createHash('sha256').update(text).digest('hex');

function executionInput(input: import('./session-ports.js').SessionMessage[]): import('./session-ports.js').SessionMessage[] {
  return input.map(message => !message.actor ? message : { ...message, content: [
    { type: 'input_text', text: participantContext(message) }, ...message.content,
  ] });
}
function executionHistory(items: import('../domain/agents-api.js').AgentSessionItem[], state: SessionState) {
  const messages = new Map(state.turns.flatMap(binding => binding.input.map(message => [message.id, message] as const)));
  return items.map(item => {
    const message = item.id ? messages.get(item.id) : undefined;
    return item.type === 'message' && item.role === 'user' && message?.actor ? { ...item, content: executionInput([message])[0]!.content } : item;
  });
}

function callerConfiguration(caller?: SessionCaller): ConfigurationMutation {
  return caller ? { actor: { kind: 'principal', id: caller.actor.id,
    ...(caller.actor.issuer !== undefined ? { issuer: caller.actor.issuer } : {}),
    ...(caller.actor.subject !== undefined ? { subject: caller.actor.subject } : {}),
  } } : {};
}
