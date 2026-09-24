import { createHash } from 'node:crypto';
import type { AgentSession, AgentSessionInputMessageParam, AgentSessionInputParam, AgentSessionItem, AgentToolParam, EnvironmentParam, Turn } from '../domain/agents-api.js';
import { AgentsApiError, resourceNotFound } from '../domain/agents-api-validation.js';
import type { SessionLaunch } from '../domain/session-execution.js';
import type { SavedSessionArtifact, SessionExecution, SessionTurnBinding, SessionTurnObservation } from '../core/session-ports.js';
import type { AgentInteractionController, ArtifactStore } from '../core/ports.js';
import type { RunService } from '../core/run-service.js';
import type { VaultService } from '../core/vault-service.js';
import type { EnvironmentService } from '../core/environment-service.js';
import type { SessionToolService } from '../core/session-tool-service.js';
import type { RunRecord } from '../domain/contracts.js';
import { isTerminal } from '../domain/state.js';
import { NotFoundError } from '../core/errors.js';
import { canonicalJson } from '../domain/json.js';
import { ValidationError } from '../domain/validation.js';
import { projectSessionItems, projectSessionTurn } from '../core/session-run-projection.js';
import { SessionRuntimeStore } from '../core/session-runtime-store.js';
import type { SessionIntegrationState } from '../domain/session-integrations.js';
import type { AgentsStore } from '../core/agents-ports.js';
import { runtimeSubagents, stoppedSessionRuntime } from '../core/session-runtime-planning.js';
import { sessionModelSettings, terminalTurn } from '../core/session-planning.js';

/** AWS execution is private implementation machinery; public clients see sessions and turns. */
export class RunSessionExecution implements SessionExecution {
  private readonly runtime: SessionRuntimeStore;
  public constructor(private readonly options: {
    runs: Pick<RunService, 'get' | 'submit' | 'idFor' | 'cancel'>;
    interaction: Pick<AgentInteractionController, 'startSessionTurn' | 'events' | 'steer' | 'interrupt' | 'respond'>;
    artifacts: Pick<ArtifactStore, 'getJson' | 'putJson' | 'getBytes' | 'getStream'>; vaults: Pick<VaultService, 'requireVaults'>;
    environments: Pick<EnvironmentService, 'prepare' | 'state' | 'retire' | 'launchReference' | 'managedLaunch' | 'attachManaged'>;
    tools: Pick<SessionToolService, 'prepare' | 'launch' | 'close'> & Partial<Pick<SessionToolService, 'environmentLaunch'>>;
    store: AgentsStore;
    backend?: import('../domain/contracts.js').ExecutionBackend;
  }) { this.runtime = new SessionRuntimeStore(options.store); }

  public async prepare(ownerId: string, sessionId: string, environment: EnvironmentParam, agent: AgentSession['agent'], vaultIds: string[], tools: AgentToolParam[] = [], resumePreparation = false) {
    await this.options.vaults.requireVaults(ownerId, vaultIds);
    if (environment.type === 'none' && agent.tools.some((tool) => tool.type === 'mcp' && (tool.transport.type === 'stdio' || tool.connection_origin === 'environment'))) throw new AgentsApiError(400, 'This MCP connection requires an execution environment.', 'invalid_request', 'agent.tools');
    if (environment.type === 'self_hosted' && tools.some((tool) => tool.type === 'mcp' && tool.transport.type === 'stdio' && Object.keys(tool.transport.env ?? {}).length)) throw new AgentsApiError(400, 'Self-hosted stdio MCP accepts env_vars from the environment, not inline env values.', 'invalid_request', 'agent.tools.transport.env');
    const prepared = await this.options.environments.prepare(ownerId, sessionId, environment, resumePreparation);
    try {
      // The upstream managed stdio contract requires enabled network access,
      // including when a template supplies the effective network policy.
      if (prepared.type === 'openai_hosted' && prepared.network.access !== 'enabled'
        && agent.tools.some((tool) => tool.type === 'mcp' && tool.transport.type === 'stdio')) {
        throw new AgentsApiError(400, 'Managed stdio MCP requires enabled network access.', 'invalid_request', 'environment.network');
      }
      const hosted = prepared.type === 'openai_hosted' ? {
        environmentId: prepared.id, network: prepared.network,
        env: (await this.options.environments.managedLaunch(ownerId, prepared.id)).hostedConfiguration?.env ?? {},
      } : undefined;
      await this.options.tools.prepare(ownerId, sessionId, agent, tools, vaultIds, resumePreparation, hosted);
      return prepared;
    } catch (error) { if (!resumePreparation && prepared.type !== 'none') await this.options.environments.retire(ownerId, prepared.id); throw error; }
  }

  public async environment(ownerId: string, session: AgentSession) {
    return session.environment.type === 'none' ? undefined : this.options.environments.state(ownerId, session.environment.id);
  }

  public async checkInputConnection(ownerId: string, session: AgentSession, turn: Turn): Promise<void> {
    if (session.environment.type !== 'self_hosted') return;
    const acknowledged = async () => (await this.runtime.get(ownerId, session.id))?.value.snapshot?.turns.some((saved) => saved.turn.id === turn.id) ?? false;
    if (await acknowledged()) return;
    try { await this.options.environments.launchReference(ownerId, session.environment.id, turn.created_at + 300); }
    catch (error) {
      // Input may have reached the harness while the HTTP waiter read connection
      // state. An observed Turn is stronger evidence than a later disconnect.
      if (error instanceof AgentsApiError && ['environment_unavailable', 'environment_connection_timeout'].includes(error.code ?? '') && await acknowledged()) return;
      throw error;
    }
  }

  public async initialize(ownerId: string, session: AgentSession): Promise<void> {
    if (session.environment.type !== 'openai_hosted') return;
    const runtime = await this.runtime.get(ownerId, session.id);
    if (runtime) {
      if (runtime.value.closed || await this.runById(ownerId, runtime.value.runId)) return;
    }
    const turn: Turn = { id: 'bootstrap', object: 'agent.session.turn', session_id: session.id, agent_id: session.agent.id,
      subagent_id: null, status: 'queued', created_at: session.created_at, started_at: null, completed_at: null, error: null, usage: null };
    await this.start(ownerId, session, { turn, input: [] }, [], true);
  }

  public async close(ownerId: string, session: AgentSession) {
    const runtime = await this.runtime.close(ownerId, session.id);
    if (runtime.value.runId !== null) {
      const run = await this.runById(ownerId, runtime.value.runId);
      if (run && !isTerminal(run.status)) await this.options.runs.cancel(ownerId, run.runId);
    }
    if (session.environment.type !== 'none') await this.options.environments.retire(ownerId, session.environment.id);
    await this.options.tools.close(ownerId, session.id);
  }

  public async start(ownerId: string, session: AgentSession, binding: SessionTurnBinding, history: AgentSessionItem[] = [], bootstrap = false): Promise<void> {
    const runtime = await this.runtime.get(ownerId, session.id);
    // A receipt retry must not replay a saved Turn after its harness has stopped.
    if (runtime?.value.snapshot?.turns.some((saved) => saved.turn.id === binding.turn.id)) return;
    if (runtime?.value.closed) return;
    const activeRun = runtime && !runtime.value.closed ? await this.options.runs.get(ownerId, runtime.value.runId).catch((error: unknown) => { if (error instanceof NotFoundError) return undefined; throw error; }) : undefined;
    if (activeRun && !isTerminal(activeRun.status)) {
      if (activeRun.agentsSession?.turnId === binding.turn.id) return;
      if (activeRun.status !== 'running' || !activeRun.execution || !this.options.interaction.startSessionTurn) throw new AgentsApiError(503, 'The session harness is not ready for input.', 'service_unavailable');
      await this.checkInputConnection(ownerId, session, binding.turn);
      const target = { runId: activeRun.runId, execution: activeRun.execution };
      // Run heartbeats start before native initialization. Wait for the control
      // bridge's acknowledgement instead of submitting input into that gap.
      if (!(await this.options.interaction.events(target)).ready) throw new AgentsApiError(503, 'The session harness is not ready for input.', 'service_unavailable');
      await this.options.interaction.startSessionTurn(target, binding.turn,
        binding.input.map(({ role, content }) => ({ role, content })), binding.modelSettings ?? sessionModelSettings(session.agent));
      return;
    }
    const existing = await this.runById(ownerId, this.options.runs.idFor(ownerId, this.key(session.id, binding.turn.id)));
    const environmentCredential = session.environment.type === 'self_hosted' ? await this.options.environments.launchReference(ownerId, session.environment.id, existing ? undefined : binding.turn.created_at + 300) : undefined;
    const environmentCredentials = existing?.agentsSession ? undefined : await this.options.tools.environmentLaunch?.(ownerId, session);
    const launch: SessionLaunch = existing?.agentsSession ? await this.options.artifacts.getJson(existing.agentsSession.launch) : {
      sessionId: session.id, turnId: binding.turn.id, ...(bootstrap ? {} : { turn: binding.turn }),
      agent: binding.modelSettings ? { ...session.agent, ...binding.modelSettings, reasoning: { ...session.agent.reasoning, ...binding.modelSettings.reasoning } } : session.agent, environment: session.environment,
      input: binding.input.map(({ role, content }) => ({ role, content })), history,
      mcp: await this.options.tools.launch(ownerId, session),
      ...(environmentCredentials ? { environmentCredentials } : {}),
      ...(environmentCredential ? { environmentCredential } : {}),
      ...(session.environment.type === 'openai_hosted' ? await this.options.environments.managedLaunch(ownerId, session.environment.id) : {}),
    };
    const integration = (await this.options.store.get<SessionIntegrationState>(ownerId, 'session_integrations', session.id))?.value;
    const origin = integration?.inputs[0];
    const owner = hash(ownerId).slice(0, 32);
    const reference = await this.options.artifacts.putJson(`owners/${owner}/sessions/${session.id}/${binding.turn.id}/launch-${hash(canonicalJson(launch))}.json`, launch);
    const prompt = messageText(launch.input);
    const runId = this.options.runs.idFor(ownerId, this.key(session.id, binding.turn.id));
    if (runtime?.value.runId !== runId) await this.runtime.claim(ownerId, session.id, runId, binding.turn.created_at, runtime);
    if (session.environment.type === 'openai_hosted') await this.options.environments.attachManaged(ownerId, session.environment.id, runId);
    try { await this.options.runs.submit(ownerId, {
      version: '1', prompt, source: origin?.source ?? { kind: 'api' }, destinations: [{ kind: 'none' }],
      ...(origin?.repository && session.environment.type === 'openai_hosted' ? { repository: origin.repository } : {}),
      execution: { backend: this.options.backend ?? 'microvm', timeoutSeconds: 28_000 },
      agent: { driver: 'codex', sandbox: session.environment.type === 'none' ? 'read-only' : session.environment.type === 'openai_hosted' && session.environment.network.access !== 'enabled' ? 'workspace-write' : 'danger-full-access', capabilities: { networkAccess: session.environment.type !== 'none' && (session.environment.type !== 'openai_hosted' || session.environment.network.access === 'enabled'), webSearch: session.agent.tools.find((tool) => tool.type === 'web_search')?.mode ?? 'disabled', computerUse: 'disabled' } },
    }, {
      idempotencyKey: this.key(session.id, binding.turn.id),
      agentsSession: { sessionId: session.id, turnId: binding.turn.id, launch: reference },
      provenance: origin ? { actor: origin.actor, credentialSubject: origin.credentialSubject } : { actor: { kind: 'human', id: ownerId, provider: 'api' }, credentialSubject: { kind: 'actor', id: ownerId } },
    }); } catch (error) {
      if (error instanceof ValidationError) throw new AgentsApiError(400, error.message, 'invalid_request');
      throw error;
    }
  }

  public async steer(ownerId: string, session: AgentSession, turnId: string, input: AgentSessionInputMessageParam[], operationId: string): Promise<void> {
    const run = await this.requiredRun(ownerId, session.id, turnId);
    if (isTerminal(run.status)) throw new AgentsApiError(409, 'The active turn ended before it could be steered.', 'active_turn_not_steerable');
    if (!run.execution || run.status !== 'running') throw new AgentsApiError(503, 'The turn is not ready for input yet.', 'service_unavailable');
    await this.options.interaction.steer({ runId: run.runId, execution: run.execution, turnId }, messageText(input), operationId, input);
  }

  public async cancel(ownerId: string, session: AgentSession, turnId: string): Promise<void> {
    const run = await this.run(ownerId, session.id, turnId);
    if (!run || isTerminal(run.status)) return;
    if (run.status === 'running' && run.execution) await this.options.interaction.interrupt({ runId: run.runId, execution: run.execution, turnId });
    else await this.options.runs.cancel(ownerId, run.runId);
  }

  public async toolResult(ownerId: string, session: AgentSession, event: Extract<AgentSessionInputParam, { type: 'agent.session.input.tool_result' }>): Promise<void> {
    const run = await this.requiredRun(ownerId, session.id, event.turn_id);
    if (isTerminal(run.status)) return;
    if (!run.execution) throw new AgentsApiError(503, 'The turn is not ready for input yet.', 'service_unavailable');
    const target = { runId: run.runId, execution: run.execution };
    const snapshot = await this.options.interaction.events(target);
    const pending = snapshot.pendingRequests.find((request) => request.method === 'item/tool/call' && (request.params.callId ?? request.requestId) === event.call_id);
    if (!pending) {
      if (projectSessionItems(event.turn_id, snapshot.events).some((item) => item.type === 'function_call' && item.call_id === event.call_id && item.status !== 'in_progress')) return;
      throw new AgentsApiError(503, 'Waiting for the tool call acknowledgement.', 'service_unavailable');
    }
    const content = event.success
      ? typeof event.output === 'string' ? [{ type: 'inputText', text: event.output }] : (event.output ?? []).map((part) => part.type === 'input_text' ? { type: 'inputText', text: part.text } : { type: 'inputImage', imageUrl: part.image_url })
      : [{ type: 'inputText', text: event.error ?? 'Function failed' }];
    await this.options.interaction.respond(target, pending.requestId, { success: event.success, contentItems: content });
  }

  public async observe(ownerId: string, session: AgentSession, turn: Turn): Promise<SessionTurnObservation> {
    const runtime = await this.runtime.get(ownerId, session.id);
    const saved = runtime?.value.snapshot?.turns.find((binding) => binding.turn.id === turn.id);
    if (saved && terminalTurn(saved.turn)) return { turn: saved.turn, requiredActions: [] };
    const run = await this.run(ownerId, session.id, turn.id);
    if (saved && run && !isTerminal(run.status)) return { turn: saved.turn, requiredActions: (runtime?.value.snapshot?.requiredActions ?? []).filter((action) => action.type === 'function_call' && action.turn_id === turn.id) };
    if (saved && runtime?.value.snapshot) return { turn: stoppedSessionRuntime(runtime.value.snapshot, Math.floor(Date.now() / 1000)).turns.find((binding) => binding.turn.id === turn.id)!.turn, requiredActions: [] };
    // Until native acknowledgement or a dedicated launch binds this Turn, the
    // runtime may still point at the previous harness. Its terminal status is
    // not evidence that newly queued input failed before replacement dispatch.
    if (run?.agentsSession?.turnId !== turn.id && run) return { turn, requiredActions: [] };
    if (!run) {
      const environment = await this.environment(ownerId, session);
      return { turn, requiredActions: environment && environment.status !== 'connected' ? [{ type: 'environment_connection', environment_id: environment.id }] : [] };
    }
    const snapshot = run.status === 'running' && run.execution
      ? await this.options.interaction.events({ runId: run.runId, execution: run.execution }, 0, 100)
      : undefined;
    return projectSessionTurn(turn, run, snapshot);
  }

  public async items(ownerId: string, session: AgentSession, turnId: string): Promise<AgentSessionItem[]> {
    const runtime = await this.runtime.get(ownerId, session.id);
    const saved = runtime?.value.snapshot?.turns.find((binding) => binding.turn.id === turnId);
    if (saved) return saved.items;
    const run = await this.run(ownerId, session.id, turnId);
    if (!run || run.agentsSession?.turnId !== turnId) return [];
    if (run.result?.events) {
      const bytes = await this.options.artifacts.getBytes(run.result.events);
      if (hash(bytes) !== run.result.events.sha256) throw new Error('Saved session events checksum mismatch');
      return projectSessionItems(turnId, Buffer.from(bytes).toString('utf8').split('\n').flatMap((line) => {
        if (!line.trim()) return [];
        try { return [JSON.parse(line) as unknown]; } catch { return []; }
      }), Buffer.from(await this.options.artifacts.getBytes(run.result.output)).toString('utf8'));
    }
    if (run.status === 'running' && run.execution) {
      const snapshot = await this.options.interaction.events({ runId: run.runId, execution: run.execution }, 0, 100);
      return snapshot.sessionItems ?? projectSessionItems(turnId, snapshot.events);
    }
    return [];
  }

  public async artifacts(ownerId: string, session: AgentSession, turnId: string): Promise<SavedSessionArtifact[]> {
    if (session.environment.type !== 'openai_hosted') return [];
    const runtime = await this.runtime.get(ownerId, session.id);
    const binding = runtime?.value.snapshot?.turns.find((binding) => binding.turn.id === turnId);
    if (binding) return binding.artifacts ?? [];
    return [];
  }

  public async artifactContent(_ownerId: string, _session: AgentSession, artifact: SavedSessionArtifact): Promise<ReadableStream<Uint8Array>> {
    const stream = await this.options.artifacts.getStream(artifact.content);
    const iterator = stream[Symbol.asyncIterator]();
    return new ReadableStream({
      async pull(controller) { const next = await iterator.next(); if (next.done) controller.close(); else controller.enqueue(next.value); },
      async cancel() { await iterator.return?.(); },
    });
  }

  private key(sessionId: string, turnId: string) { return `agents:${sessionId}:${turnId}`; }
  public async subagents(ownerId: string, session: AgentSession) {
    const runtime = await this.runtime.get(ownerId, session.id);
    if (!runtime?.value.snapshot) return [];
    const run = runtime.value.runId === null ? undefined : await this.runById(ownerId, runtime.value.runId);
    return runtimeSubagents(run && !isTerminal(run.status) ? runtime.value.snapshot : stoppedSessionRuntime(runtime.value.snapshot, Math.floor(Date.now() / 1000)));
  }
  private async run(ownerId: string, sessionId: string, turnId: string): Promise<RunRecord | undefined> {
    const runtime = await this.runtime.get(ownerId, sessionId);
    return this.runById(ownerId, runtime?.value.runId ?? this.options.runs.idFor(ownerId, this.key(sessionId, turnId)));
  }
  private async runById(ownerId: string, id: string): Promise<RunRecord | undefined> {
    try { return await this.options.runs.get(ownerId, id); }
    catch (error) { if (error instanceof NotFoundError) return undefined; throw error; }
  }
  private async requiredRun(ownerId: string, sessionId: string, turnId: string) { return await this.run(ownerId, sessionId, turnId) ?? resourceNotFound(); }
}

function messageText(input: AgentSessionInputMessageParam[]): string {
  return input.flatMap((message) => message.content.map((part) => part.type === 'input_text' ? part.text : '[Attached image]')).join('\n\n') || '[Empty user input]';
}
function hash(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
