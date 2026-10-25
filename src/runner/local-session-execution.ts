import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentsStore } from '../core/agents-ports.js';
import type { SessionExecution, SessionState, SessionTurnBinding } from '../core/session-ports.js';
import type { AgentSession, AgentSessionItem, EnvironmentParam, Turn } from '../domain/agents-api.js';
import { AgentsApiError } from '../domain/agents-api-validation.js';
import { runtimeSubagents, stoppedSessionRuntime, type SessionRuntimeState } from '../core/session-runtime-planning.js';
import { terminalTurn } from '../core/session-planning.js';
import { planCodexLaunch } from './agent-planning.js';
import { planSessionLaunch } from './session-launch-planning.js';
import { SessionRuntime } from './session-runtime.js';
import type { CodexAppServerRequest } from './codex-app-server.js';
import type { LocalManagedEnvironment } from './local-managed-environment.js';
import { developmentLocalCodexHost, localCodexArguments, localCodexClient, localCodexEnvironment, type LocalCodexHostProvider } from './local-codex.js';
import { LocalRuntimeLifecycle } from '../adapters/local-runtime-lifecycle.js';

/** The host owns subscription inference; managed commands run in an isolated Linux worker. */
export class LocalSessionExecution implements SessionExecution {
  private readonly runtimes = new Map<string, Promise<SessionRuntime>>();
  private readonly snapshots = new Map<string, SessionRuntimeState>();
  private readonly cancellations = new Map<string, { turnId: string; runtime: SessionRuntime }>();
  private writes: Promise<void> = Promise.resolve();
  private closing = false;
  private readonly lifecycle = new LocalRuntimeLifecycle();
  private readonly hostCodex: LocalCodexHostProvider;

  public constructor(private readonly options: {
    store: AgentsStore; directory: string; maxSessions: number;
    environment?: NodeJS.ProcessEnv;
    request?: (request: CodexAppServerRequest) => CodexAppServerRequest;
    managed?: LocalManagedEnvironment;
    hostCodex?: LocalCodexHostProvider;
  }) { this.hostCodex = options.hostCodex ?? developmentLocalCodexHost(options.directory, options.environment); }

  public async prepare(_owner: string, _id: string, environment: EnvironmentParam, agent: AgentSession['agent'], vaultIds: string[]) {
    this.hostCodex();
    if (vaultIds.length || agent.tools.some(tool => !['function', 'web_search', 'programmatic_tool_calling'].includes(tool.type))) {
      throw new AgentsApiError(400, 'Local Sessions support functions, web search and code mode. Connect cloud credentials separately for Vaults and MCP.', 'unsupported_tool', 'agent.tools');
    }
    if (environment.type !== 'none') {
      if (!this.options.managed) throw new AgentsApiError(400, 'Local managed environments are unavailable.', 'unsupported_environment', 'environment');
      return this.options.managed.prepare(_owner, _id, environment);
    }
    return { type: 'none' as const };
  }

  public environment(owner: string, session: AgentSession) { return this.options.managed?.state(owner, session) ?? Promise.resolve(undefined); }
  public initialize(owner: string, session: AgentSession) {
    return this.lifecycle.run(session.id, async () => {
      const state = await this.options.store.get<SessionState>(owner, 'sessions', session.id);
      if (state && Object.values(state.value.receipts).some(receipt => !receipt.dispatched)) return;
      await this.options.managed?.initialize(owner, session);
    });
  }

  public start(owner: string, session: AgentSession, binding: SessionTurnBinding, history: AgentSessionItem[] = []) {
    if (this.closing) return Promise.reject(new AgentsApiError(503, 'Local workspace is shutting down.', 'service_unavailable'));
    return this.lifecycle.run(session.id, () => this.startTurn(owner, session, binding, history));
  }
  private async startTurn(owner: string, session: AgentSession, binding: SessionTurnBinding, history: AgentSessionItem[]) {
    const attempt = await this.options.store.get<Turn>(owner, 'local_turn_attempts', binding.turn.id);
    if (attempt) return;
    if (this.cancellations.has(session.id)) throw new AgentsApiError(503, 'The previous local worker has not confirmed shutdown.', 'local_runtime_stopping');
    if (!this.runtimes.has(session.id) && this.runtimes.size >= this.options.maxSessions) {
      throw new AgentsApiError(503, 'All local Session slots are busy. Work stays queued until a slot is free.', 'local_capacity');
    }
    const created = !this.runtimes.has(session.id);
    const previous = created ? await this.recoverState(owner, session.id) : undefined;
    let runtime: SessionRuntime;
    try {
      runtime = await this.runtime(owner, session, history, previous);
      await this.writes;
      await this.options.managed?.admitTurn(session);
    } catch (error) {
      if (created || !resourceWait(error)) await this.closeSession(owner, session);
      if (resourceWait(error)) throw error;
      await this.options.store.put({ ownerId: owner, collection: 'local_turn_attempts', id: binding.turn.id,
        createdAt: binding.turn.created_at, revision: 1, value: failedTurn(binding.turn) }, 0);
      return;
    }
    let cancelled: boolean;
    try {
      cancelled = await this.cancellationRequested(owner, session.id, binding.turn.id);
      await this.options.store.put({ ownerId: owner, collection: 'local_turn_attempts', id: binding.turn.id,
        createdAt: binding.turn.created_at, revision: 1, value: cancelled ? cancelledTurn(binding.turn) : binding.turn }, 0);
      if (!cancelled && await this.cancellationRequested(owner, session.id, binding.turn.id)) {
        await this.failAttempt(owner, binding.turn, 'cancelled');
        cancelled = true;
      }
    } catch (error) {
      await this.closeSession(owner, session);
      throw error;
    }
    if (cancelled) {
      if (created) await this.closeSession(owner, session);
      return;
    }
    try {
      await runtime.start(binding.turn, binding.input, binding.modelSettings);
      await this.writes;
    } catch {
      try { await this.failAttempt(owner, binding.turn); }
      finally { await this.closeSession(owner, session); }
    }
  }

  public async steer(_owner: string, session: AgentSession, turn: string, input: Parameters<SessionExecution['steer']>[3], operation: string) {
    await (await this.live(session.id)).steer(turn, input, operation);
    await this.writes;
  }
  public cancel(owner: string, session: AgentSession, turn: string) {
    return this.lifecycle.run(session.id, async () => {
      const pending = this.cancellations.get(session.id);
      if (pending) {
        if (pending.turnId === turn) await this.cancelManaged(owner, session, turn, pending.runtime);
        return;
      }
      const runtime = await this.runtimes.get(session.id);
      const binding = runtime?.snapshot().turns.find(binding => binding.turn.id === turn);
      if (runtime && binding) {
        if (terminalTurn(binding.turn)) return;
        if (session.environment.type === 'openai_hosted' && this.options.managed) await this.cancelManaged(owner, session, turn, runtime);
        else await runtime.cancel(turn);
      }
      else {
        const attempt = await this.options.store.get<Turn>(owner, 'local_turn_attempts', turn);
        if (attempt && !terminalTurn(attempt.value)) {
          if (session.environment.type !== 'none') await this.options.managed?.close(owner, session);
          await this.failAttempt(owner, attempt.value, 'cancelled');
        }
      }
      await this.writes;
    });
  }
  private async cancelManaged(owner: string, session: AgentSession, turnId: string, runtime: SessionRuntime) {
    // Native interruption leaves background terminals alive. Do not publish its
    // terminal event until the dedicated worker and every descendant have stopped.
    this.cancellations.set(session.id, { turnId, runtime });
    const interrupted = runtime.cancel(turnId).catch(() => {});
    const cleanup = await Promise.allSettled([this.options.managed!.close(owner, session), runtime.close()]);
    await interrupted;
    const failures = cleanup.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, 'Local cancellation could not confirm worker shutdown');
    const snapshot = cancelledRuntime(runtime.snapshot(), turnId, Math.floor(Date.now() / 1000));
    await this.saveSnapshot(owner, session, snapshot);
    await this.failAttempt(owner, snapshot.turns.find(binding => binding.turn.id === turnId)!.turn, 'cancelled');
    this.runtimes.delete(session.id);
    this.cancellations.delete(session.id);
  }
  public async toolResult(_owner: string, session: AgentSession, event: Parameters<SessionExecution['toolResult']>[2]) {
    await (await this.live(session.id)).toolResult(event);
    await this.writes;
  }
  public async observe(owner: string, session: AgentSession, turn: Turn) {
    if (this.runtimes.has(session.id)) {
      const state = this.snapshots.get(session.id);
      const observed = state?.turns.find(binding => binding.turn.id === turn.id)?.turn;
      if (observed) return { turn: observed, requiredActions: state?.requiredActions ?? [] };
      const attempt = await this.options.store.get<Turn>(owner, 'local_turn_attempts', turn.id);
      return { turn: attempt && terminalTurn(attempt.value) ? attempt.value : turn, requiredActions: [] };
    }
    return this.lifecycle.run(session.id, async () => {
      const state = await this.recoverState(owner, session.id);
      const observed = state?.turns.find(binding => binding.turn.id === turn.id)?.turn;
      if (observed) return { turn: observed, requiredActions: state?.requiredActions ?? [] };
      const attempt = await this.options.store.get<Turn>(owner, 'local_turn_attempts', turn.id);
      if (!attempt) return { turn, requiredActions: [] };
      if (terminalTurn(attempt.value)) return { turn: attempt.value, requiredActions: [] };
      if (this.runtimes.has(session.id)) return { turn, requiredActions: [] };
      const recovered = failedTurn(attempt.value);
      await this.options.store.put({ ...attempt, revision: attempt.revision + 1, value: recovered }, attempt.revision);
      return { turn: recovered, requiredActions: [] };
    });
  }
  public async items(owner: string, session: AgentSession, turn: string) {
    return (await this.state(owner, session.id))?.turns.find(binding => binding.turn.id === turn)?.items ?? [];
  }
  public async traceSteps(owner: string, session: AgentSession, turn: string) {
    return (await this.state(owner, session.id))?.turns.find(binding => binding.turn.id === turn)?.traceSteps ?? [];
  }
  public async subagents(owner: string, session: AgentSession) {
    const state = await this.state(owner, session.id);
    return state ? runtimeSubagents(state) : [];
  }
  public async artifacts() { return []; }
  public async artifactContent(): Promise<ReadableStream<Uint8Array>> { throw new AgentsApiError(404, 'Artifact not found.', 'resource_not_found'); }
  public close(owner: string, session: AgentSession) {
    return this.lifecycle.run(session.id, () => this.closeSession(owner, session));
  }
  private async closeSession(owner: string, session: AgentSession) {
    const cancelling = this.cancellations.get(session.id);
    if (cancelling) { await this.cancelManaged(owner, session, cancelling.turnId, cancelling.runtime); return; }
    const pending = this.runtimes.get(session.id);
    const runtime = await pending?.catch(() => undefined);
    if (this.runtimes.get(session.id) === pending) this.runtimes.delete(session.id);
    try { await runtime?.close(); }
    finally { if (session.environment.type !== 'none') await this.options.managed?.close(owner, session); }
    await this.writes;
  }
  public shutdown() {
    this.closing = true;
    return this.lifecycle.close(async () => {
      const runtimes = [...this.runtimes.values()];
      this.runtimes.clear();
      try {
        await Promise.all(runtimes.map(async pending => { const runtime = await pending.catch(() => undefined); await runtime?.close(); }));
        await this.writes;
      } finally { await this.options.managed?.shutdown(); }
    });
  }

  private async live(id: string) {
    const runtime = await this.runtimes.get(id);
    if (!runtime) throw new AgentsApiError(409, 'This local Turn has stopped. Send a new message to continue.', 'turn_stopped');
    return runtime;
  }
  private state(owner: string, id: string) {
    if (this.runtimes.has(id)) return Promise.resolve(this.snapshots.get(id));
    return this.lifecycle.run(id, () => this.recoverState(owner, id));
  }
  private async recoverState(owner: string, id: string) {
    if (this.runtimes.has(id)) return this.snapshots.get(id);
    await this.writes;
    const current = await this.options.store.get<SessionRuntimeState>(owner, 'local_runtime', id);
    if (!current) return undefined;
    const recovery = recoverStoppedSnapshot(current.value, Math.floor(Date.now() / 1000));
    if (recovery.kind === 'persist') await this.options.store.put({ ...current, revision: current.revision + 1, value: recovery.snapshot }, current.revision);
    this.snapshots.set(id, recovery.snapshot);
    return recovery.snapshot;
  }
  private runtime(owner: string, session: AgentSession, history: AgentSessionItem[], previous: SessionRuntimeState | undefined) {
    const existing = this.runtimes.get(session.id);
    if (existing) return existing;
    if (this.runtimes.size >= this.options.maxSessions) throw new AgentsApiError(503, 'All local Session slots are busy. Work stays queued until a slot is free.', 'local_capacity');
    const pending = this.launch(owner, session, history, previous);
    this.runtimes.set(session.id, pending);
    void pending.catch(() => { if (this.runtimes.get(session.id) === pending) this.runtimes.delete(session.id); });
    return pending;
  }
  private async launch(owner: string, session: AgentSession, history: AgentSessionItem[], previous: SessionRuntimeState | undefined) {
    const host = this.hostCodex();
    const workspace = join(this.options.directory, 'sessions', session.id);
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    const base = planCodexLaunch({ version: '1', prompt: '', agent: { driver: 'codex', model: session.agent.model, sandbox: 'read-only',
      capabilities: { networkAccess: false, webSearch: session.agent.tools.find(tool => tool.type === 'web_search')?.mode ?? 'disabled' } } },
    workspace, 3_600_000, localCodexEnvironment(this.options.directory, { ...host.environment, CODEX_BINARY: host.binary }));
    base.binaryArguments = localCodexArguments(base.binaryArguments ?? ['app-server']);
    const launch = session.environment.type === 'openai_hosted' && this.options.managed
      ? await this.options.managed.launch(owner, session, base, history)
      : planSessionLaunch(base, { sessionId: session.id, turnId: '', agent: session.agent, environment: session.environment, input: [], history });
    const request = { ...base, ...launch, sandbox: 'read-only' as const, persistent: true };
    const runtime = new SessionRuntime({ sessionId: session.id, agentId: session.agent.id,
      client: localCodexClient,
      request: this.options.request?.(request) ?? request, idleTimeoutMs: 30_000, ...(previous ? { previous } : {}),
      changed: snapshot => {
        if (!this.cancellations.has(session.id)) void this.saveSnapshot(owner, session, snapshot).catch(() => runtime.close());
      },
    });
    void runtime.finished.then(() => {
      if (this.closing) return;
      return this.lifecycle.run(session.id, async () => {
        if (this.runtimes.get(session.id) !== pending || this.cancellations.has(session.id)) return;
        this.runtimes.delete(session.id);
        await this.options.managed?.close(owner, session);
      });
    }).catch(() => {});
    const pending = this.runtimes.get(session.id);
    try { await runtime.initialize(); await this.writes; return runtime; }
    catch (error) { await runtime.close(); throw error; }
  }
  private saveSnapshot(owner: string, session: AgentSession, snapshot: SessionRuntimeState) {
    this.snapshots.set(session.id, snapshot);
    this.writes = this.writes.then(async () => {
      const current = await this.options.store.get(owner, 'local_runtime', session.id);
      await this.options.store.put({ ownerId: owner, collection: 'local_runtime', id: session.id,
        createdAt: current?.createdAt ?? session.created_at, revision: (current?.revision ?? 0) + 1, value: snapshot }, current?.revision ?? 0);
    });
    return this.writes;
  }
  private async failAttempt(owner: string, turn: Turn, status: 'failed' | 'cancelled' = 'failed') {
    const current = await this.options.store.get<Turn>(owner, 'local_turn_attempts', turn.id);
    if (current) await this.options.store.put({ ...current, revision: current.revision + 1,
      value: status === 'cancelled' ? cancelledTurn(turn) : failedTurn(turn) }, current.revision);
  }
  private async cancellationRequested(owner: string, session: string, turn: string) {
    const state = await this.options.store.get<SessionState>(owner, 'sessions', session);
    return Boolean(state?.value.closing || state?.value.turns.some(binding => binding.turn.id === turn && binding.cancelRequested));
  }
}

type StoppedRecovery =
  | { kind: 'retain'; snapshot: SessionRuntimeState }
  | { kind: 'persist'; snapshot: SessionRuntimeState };

function cancelledRuntime(snapshot: SessionRuntimeState, turnId: string, now: number): SessionRuntimeState {
  const stopped = stoppedSessionRuntime(snapshot, now);
  return { ...stopped, turns: stopped.turns.map(binding => binding.turn.id !== turnId ? binding
    : { ...binding, turn: { ...binding.turn, status: 'cancelled', completed_at: now, error: null } }) };
}

function recoverStoppedSnapshot(snapshot: SessionRuntimeState, now: number): StoppedRecovery {
  const abandoned = snapshot.requiredActions.length > 0 || snapshot.subagents.some(agent => agent.status !== 'closed')
    || snapshot.turns.some(binding => !terminalTurn(binding.turn));
  return abandoned
    ? { kind: 'persist', snapshot: stoppedSessionRuntime(snapshot, now) }
    : { kind: 'retain', snapshot };
}

function cancelledTurn(turn: Turn): Turn {
  return { ...turn, status: 'cancelled', completed_at: Math.floor(Date.now() / 1000), error: null };
}

function failedTurn(turn: Turn): Turn {
  if (['completed', 'failed', 'cancelled'].includes(turn.status)) return turn;
  return { ...turn, status: 'failed', completed_at: Math.floor(Date.now() / 1000),
    error: { code: 'connection_failed', message: 'The local harness stopped. Check Codex login and model access, then send a new message to continue.' } };
}

function resourceWait(error: unknown): error is AgentsApiError {
  return error instanceof AgentsApiError && error.status === 503
    && ['local_capacity', 'local_memory_pressure', 'local_disk_capacity', 'local_runtime_starting'].includes(error.code ?? '');
}
