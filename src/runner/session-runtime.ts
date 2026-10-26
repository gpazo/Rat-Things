import { verifyManagedCodexPolicy } from '../adapters/codex-managed-policy.js';
import { admitNativeServiceTier, nativeServiceTier } from '../domain/session-model-validation.js';
import { nativeHostJournalDigest, planNativeCheckpoint } from '../core/native-checkpoint-planning.js';
import type { NativeCheckpointManifest, NativeCheckpointEvidence } from '../domain/native-checkpoint.js';
import { assertCheckpointStartupSafe } from './codex-cold-verification.js';
import type { PreparedColdVerification } from './codex-cold-verification.js';
import type { AgentSessionInputMessageParam, AgentSessionInputParam, Turn } from '../domain/agents-api.js';
import { CodexRpcClient, CodexRpcError, type CodexRpcEvent } from '../adapters/codex-rpc.js';
import { bindSessionTurn, initialSessionRuntime, reduceSessionRuntime, resolveSessionFunction, rootTurnBusy, stoppedSessionRuntime, type SessionRuntimeState } from '../core/session-runtime-planning.js';
import type { CodexAppServerRequest } from './codex-app-server.js';
import { environmentToolConfig, sandboxPolicyFor } from './codex-app-server.js';
import type { SessionModelSettings } from '../domain/session-execution.js';
import { checkpointWorkspace, type WorkspaceHandoffPorts } from './workspace-handoff.js';

export type SessionCheckpointOptions = Omit<WorkspaceHandoffPorts, 'inspectIdle' | 'shutdownNative' | 'verifyNative' | 'settle' | 'commit'> & {
  prepareNativeVerification?(request: CodexAppServerRequest, manifest: NativeCheckpointManifest): Promise<PreparedColdVerification>;
  commit(state: SessionRuntimeState, evidence?: NativeCheckpointEvidence): ReturnType<WorkspaceHandoffPorts['commit']>;
};

type ToolResult = Extract<AgentSessionInputParam, { type: 'agent.session.input.tool_result' }>;
interface PendingFunction { nativeTurnId: string; threadId: string; callId: string; resolve(value: unknown): void; reject(error: Error): void }

/** One native harness stays alive across root turns and background subagent work. */
export class SessionRuntime {
  private readonly rpc: Pick<CodexRpcClient, 'initialize' | 'call' | 'close'> & Partial<Pick<CodexRpcClient, 'closeCheckpoint'>>;
  private state: SessionRuntimeState | undefined;
  private readonly requests = new Map<string, PendingFunction>();
  private readonly terminalWaiters = new Set<() => void>();
  private readonly started = new Map<string, Promise<void>>();
  private readonly operations = new Map<string, { digest: string; promise: Promise<void> }>();
  private readonly earlyEvents: CodexRpcEvent[] = [];
  private readonly childEvents: CodexRpcEvent[] = [];
  private readonly inheritedNativeTurns = new Set<string>();
  private starting = false;
  private startingTurn: Turn | undefined;
  private closed = false;
  private expired = false;
  private checkpointing = false;
  private checkpointActivity = false;
  private checkpointFailure: unknown;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private lifetimeTimer: ReturnType<typeof setTimeout> | undefined;
  public readonly finished: Promise<void>;
  private finish!: () => void;

  public constructor(private readonly options: {
    sessionId: string; agentId: string; request: CodexAppServerRequest;
    now?: () => number; changed?: (state: SessionRuntimeState) => void;
    previous?: SessionRuntimeState;
    idleTimeoutMs?: number;
    /** Trusted host policy: dedicated workers terminate on authority loss or closure. */
    lifetime?: 'bounded' | 'host-managed';
    checkpoint?: SessionCheckpointOptions;
    requiredResumeThreadId?: string;
    fork?: { rootThreadId: string; lastNativeTurnId: string | null };
    /** A replacement's accepted first Turn is busy even before native admission starts. */
    initialTurnId?: string;
    client?: (options: ConstructorParameters<typeof CodexRpcClient>[0]) => Pick<CodexRpcClient, 'initialize' | 'call' | 'close'> & Partial<Pick<CodexRpcClient, 'closeCheckpoint'>>;
  }) {
    this.finished = new Promise<void>((resolve) => { this.finish = resolve; });
    const request = options.request;
    const args: ConstructorParameters<typeof CodexRpcClient>[0] = {
      startupPurpose: 'session', binary: request.binary, cwd: request.workspace, environment: request.environment,
      ...(request.binaryArguments ? { binaryArguments: request.binaryArguments } : {}),
      ...(request.identity ? { identity: request.identity } : {}), ...(request.signal ? { signal: request.signal } : {}),
      onEvent: (event) => this.event(event), onServerRequest: (event) => this.serverRequest(event), onClose: () => this.disconnected(),
    };
    this.rpc = options.client ? options.client(args) : new CodexRpcClient(args);
    if (options.lifetime !== 'host-managed') {
      this.lifetimeTimer = setTimeout(() => { this.expired = true; void this.close(); }, request.timeoutMs);
      this.lifetimeTimer.unref();
    }
  }

  public sandboxExpired(): boolean { return this.expired; }
  public assertSuccessfulShutdown(): void { if (this.checkpointFailure) throw this.checkpointFailure; }

  public async checkpoint(): Promise<unknown> {
    const ports = this.options.checkpoint;
    if (!ports || !this.state || this.closed || this.checkpointing) throw new Error('Session checkpoint is unavailable');
    // Set synchronously so a native disconnect cannot finish the Run during shutdown.
    this.checkpointing = true;
    this.checkpointActivity = false;
    let transitionStarted = false;
    let threadIds: string[] = [];
    let manifest: NativeCheckpointManifest | undefined;
    let verifier: PreparedColdVerification | undefined;
    const rootThreadId = this.state.rootThreadId;
    const assertQuiescent = () => {
      if (this.checkpointActivity || manifest && nativeHostJournalDigest(this.snapshot()) !== manifest.hostJournalDigest || this.requests.size || this.state!.requiredActions.length
        || this.state!.turns.some(binding => !terminal(binding.turn))) throw new Error('Native activity changed during checkpoint shutdown');
    };
    try {
      return await checkpointWorkspace({ ...ports,
        inspectIdle: async () => {
          const idle = Boolean(this.state) && (!this.options.initialTurnId || this.started.has(this.options.initialTurnId)) && !this.starting && !this.requests.size
            && !this.state!.requiredActions.length && !this.state!.turns.some(binding => !terminal(binding.turn));
          // Empty native threads may never materialize a rollout. Reject these before
          // beginning shutdown so we cannot publish an unresumable checkpoint.
          if (idle) {
            if (!ports.prepareNativeVerification) throw new Error('Cold native checkpoint is unavailable on this host');
            const loaded = await this.loadedCheckpointThreads();
            if (!loaded.includes(rootThreadId)) throw new Error('Root thread is not loaded');
            threadIds = checkpointThreadIds([...new Set([rootThreadId, ...this.state!.subagents.map(agent => agent.id), ...this.state!.turns.map(binding => binding.threadId)])]);
            if (loaded.some(id => !threadIds.includes(id))) throw new Error('Native threads differ from the Session journal');
            const histories: unknown[] = [];
            for (const threadId of threadIds) {
              const result = await this.rpc.call('thread/read', { threadId, includeTurns: true });
              if (!record(result) || !record(result.thread) || result.thread.id !== threadId) throw new Error('Native checkpoint history is unavailable');
              histories.push(result.thread);
            }
            manifest = planNativeCheckpoint(this.snapshot(), histories);
            assertCheckpointStartupSafe(await this.rpc.call('config/read', { includeLayers: true }), this.options.request.sessionConfig);
            const requirements = await this.rpc.call('configRequirements/read', {});
            if (!record(requirements) || requirements.requirements !== null) throw new Error('Cold native checkpoint requirements are unsupported');
            verifier = await ports.prepareNativeVerification(this.options.request, manifest);
            assertQuiescent();
          }
          return { idle, threadIds };
        },
        begin: async () => {
          transitionStarted = true;
          clearTimeout(this.idleTimer); clearTimeout(this.lifetimeTimer);
          assertQuiescent();
          await ports.begin();
        },
        shutdownNative: async () => {
          assertQuiescent();
          if ((await this.loadedCheckpointThreads()).some(id => !threadIds.includes(id))) throw new Error('Native threads changed during checkpoint shutdown');
          assertQuiescent();
          if (!this.rpc.closeCheckpoint) throw new Error('Native checkpoint shutdown is unsupported');
          await this.rpc.closeCheckpoint();
          this.disconnected();
          assertQuiescent();
          return { kind: 'codex-eof', threadIds };
        },
        verifyNative: async () => {
          assertQuiescent();
          if (!manifest || !verifier) throw new Error('Cold native verification was not prepared');
          const evidence = await verifier.verify(manifest);
          assertQuiescent();
          return evidence;
        },
        commit: evidence => { assertQuiescent(); return ports.commit(this.snapshot(), evidence); },
        settle: () => {},
      });
    } catch (error) { if (transitionStarted) this.checkpointFailure = error; throw error; }
    finally {
      try { await verifier?.close(); }
      catch (error) { if (transitionStarted) this.checkpointFailure = error; throw error; }
      finally {
        if (transitionStarted) await this.close();
        this.checkpointing = false;
        if (this.closed) this.finish();
      }
    }
  }

  private async loadedCheckpointThreads(): Promise<string[]> {
    let ids: string[] = [];
    let cursor: string | undefined;
    const cursors = new Set<string>();
    do {
      const page = checkpointThreadPage(await this.rpc.call('thread/loaded/list', { limit: 100, ...(cursor ? { cursor } : {}) }));
      ids = checkpointThreadIds([...ids, ...page.ids]);
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error('Native thread pagination repeated');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return ids;
  }

  public async initialize(): Promise<SessionRuntimeState> {
    const request = this.options.request;
    await this.rpc.initialize();
    if (request.permissions === 'rat_managed' && !request.managedPolicy) throw new Error('Managed executor policy intent is missing');
    if (request.managedPolicy && request.permissions !== 'rat_managed') throw new Error('Managed executor permission profile is not selected');
    if (request.managedPolicy) await verifyManagedCodexPolicy({ call: this.rpc.call.bind(this.rpc), policy: request.managedPolicy });
    const serviceTier = await this.admitTier(request.serviceTier, request.model);
    const parameters = {
      cwd: request.executionWorkspace ?? request.workspace,
      modelProvider: request.modelProvider, model: request.model,
      approvalPolicy: 'never', approvalsReviewer: 'user', ...(request.permissions ? { permissions: request.permissions } : { sandbox: request.sandbox }),
      ephemeral: false, serviceName: 'rat-things', allowProviderModelFallback: false,
      experimentalRawEvents: true,
      selectedCapabilityRoots: request.selectedCapabilityRoots ?? [],
      developerInstructions: request.developerInstructions,
      serviceTier,
      environments: request.environments,
      dynamicTools: request.dynamicTools,
      config: { ...request.sessionConfig, 'features.fast_mode': true, ...environmentToolConfig(request.environments), web_search: request.webSearch ?? 'disabled',
        'features.default_mode_request_user_input': false, 'tools.experimental_request_user_input.enabled': false,
        'orchestrator.skills.enabled': false, 'skills.bundled.enabled': false, 'features.goals': false },
    };
    let resumed = false;
    let thread: unknown;
    const resumeThreadId = this.options.requiredResumeThreadId ?? this.options.previous?.rootThreadId ?? request.resumeThreadId;
    if (this.options.fork) {
      if (resumeThreadId) throw new Error('Fork and resume are mutually exclusive');
      thread = await this.rpc.call('thread/fork', { ...parameters, threadId: this.options.fork.rootThreadId,
        ...(this.options.fork.lastNativeTurnId ? { lastTurnId: this.options.fork.lastNativeTurnId } : {}), deferGoalContinuation: true });
      resumed = true;
    } else if (resumeThreadId) {
      try {
        const { dynamicTools: _tools, environments: _environments, ...resume } = parameters;
        thread = await this.rpc.call('thread/resume', { ...resume, threadId: resumeThreadId });
        resumed = true;
      } catch (error) {
        if (this.options.requiredResumeThreadId || !(error instanceof CodexRpcError) || !error.missingThread) throw error;
        thread = await this.rpc.call('thread/start', parameters);
      }
    } else thread = await this.rpc.call('thread/start', parameters);
    if (!record(thread) || !record(thread.thread) || typeof thread.thread.id !== 'string') throw new Error('Native session initialization failed');
    if (this.options.fork && thread.thread.id === this.options.fork.rootThreadId) throw new Error('Native fork reused its source identity');
    for (const id of this.options.previous?.inheritedNativeTurnIds ?? []) this.inheritedNativeTurns.add(id);
    if (this.options.fork) {
      if (this.options.fork.lastNativeTurnId) this.inheritedNativeTurns.add(this.options.fork.lastNativeTurnId);
      for (const turn of Array.isArray(thread.thread.turns) ? thread.thread.turns : []) if (record(turn) && typeof turn.id === 'string') this.inheritedNativeTurns.add(turn.id);
    }
    if (this.options.requiredResumeThreadId && thread.thread.id !== this.options.requiredResumeThreadId) throw new Error('Native checkpoint resumed a different thread');
    this.state = initialSessionRuntime(this.options.sessionId, this.options.agentId, thread.thread.id);
    if (this.inheritedNativeTurns.size) this.state = { ...this.state, inheritedNativeTurnIds: [...this.inheritedNativeTurns] };
    if (this.options.previous) {
      const previous = stoppedSessionRuntime(this.options.previous, this.now());
      this.state = {
      ...this.state,
      subagents: previous.subagents,
      ...(previous.coordinationCalls ? { coordinationCalls: previous.coordinationCalls } : {}),
      ...(previous.agentPaths ? { agentPaths: previous.agentPaths } : {}),
      ...(previous.threadUsage ? { threadUsage: previous.threadUsage } : {}),
      turns: previous.turns.map((binding) => ({ ...binding, threadId: binding.turn.subagent_id === null ? this.state!.rootThreadId : binding.threadId })),
      };
    }
    // Native fork hydration emits inherited usage/history notifications. Those
    // belong to the source's public history, not newly executed child Turns.
    const early = this.earlyEvents.splice(0);
    for (const event of early) {
      if (this.options.fork) this.inheritForkUsage(event);
      else this.event(event);
    }
    if (!resumed && request.recoveryItems?.length) await this.rpc.call('thread/inject_items', { threadId: this.state.rootThreadId, items: request.recoveryItems });
    this.publish();
    await this.ready();
    return this.snapshot();
  }

  public snapshot(): SessionRuntimeState {
    if (!this.state) throw new Error('Session runtime is not initialized');
    return structuredClone(this.state);
  }

  public start(turn: Turn, input: AgentSessionInputMessageParam[], settings?: SessionModelSettings): Promise<void> {
    const existing = this.started.get(turn.id);
    if (existing) return existing;
    // Pre-admission rejection has no native effect and must remain retryable.
    // Cache only attempts that cross the native boundary, including ambiguity.
    if (!this.state || this.closed || this.checkpointing) return Promise.reject(new Error('Session runtime is unavailable'));
    if (rootTurnBusy(this.state, this.starting)) return Promise.reject(new Error('The root agent already has an active turn'));
    // Reserve admission while the read-only capability lookup runs, but cache only
    // native attempts. Unsupported tier requests can be corrected and retried.
    this.starting = true;
    let nativeAttempt = false;
    const promise = this.admitTier(settings?.service_tier ?? this.options.request.serviceTier, settings?.model ?? this.options.request.model).then(serviceTier => {
      if (!this.state || this.closed || this.checkpointing) throw new Error('Session runtime is unavailable');
      nativeAttempt = true;
      return this.startTurn(turn, input, this.state.rootThreadId, serviceTier, settings);
    }).catch(error => { if (!nativeAttempt && this.started.get(turn.id) === promise) this.started.delete(turn.id); throw error; })
      .finally(() => { this.starting = false; });
    this.started.set(turn.id, promise);
    return promise;
  }

  private async admitTier(tier: string | undefined, model: string | undefined) {
    if (nativeServiceTier(tier) === 'default') return 'default' as const;
    const configuration = await this.rpc.call('config/read', { includeLayers: false });
    if (!record(configuration) || !record(configuration.config) || (configuration.config.model_provider ?? 'openai') !== this.options.request.modelProvider) throw new Error('Native model catalogue provider differs from the Session provider');
    const models: unknown[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await this.rpc.call('model/list', { includeHidden: true, limit: 100, ...(cursor ? { cursor } : {}) });
      if (!record(page) || !Array.isArray(page.data) || models.length + page.data.length > 10_000
        || (page.nextCursor !== undefined && page.nextCursor !== null && (typeof page.nextCursor !== 'string' || !page.nextCursor))) throw new Error('Native model capabilities are unavailable');
      models.push(...page.data);
      cursor = typeof page.nextCursor === 'string' ? page.nextCursor : undefined;
      if (cursor && (cursors.has(cursor) || cursors.size >= 100)) throw new Error('Native model pagination repeated');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return admitNativeServiceTier(tier, { model, provider: this.options.request.modelProvider, models });
  }

  private async startTurn(turn: Turn, input: AgentSessionInputMessageParam[], rootThreadId: string, serviceTier: 'default' | 'priority' | 'flex', settings?: SessionModelSettings): Promise<void> {
    this.starting = true;
    this.startingTurn = turn;
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    const request = this.options.request;
    try {
      const result = await this.rpc.call('turn/start', {
        threadId: rootThreadId, input: nativeInput(input), cwd: request.executionWorkspace ?? request.workspace,
        environments: request.environments,
        approvalPolicy: 'never', approvalsReviewer: 'user',
        ...(request.permissions ? { permissions: request.permissions } : { sandboxPolicy: sandboxPolicyFor(request.sandbox, request.executionWorkspace ?? request.workspace, request.networkAccess) }),
        model: settings?.model ?? request.model,
        effort: settings ? settings.reasoning.effort : request.reasoningEffort,
        // Native null effort otherwise means "keep the previous effort". A
        // default collaboration-mode snapshot clears it to the selected model's default.
        ...(settings?.reasoning.effort === null ? { collaborationMode: {
          mode: 'default', settings: { model: settings.model, reasoning_effort: null, developer_instructions: null },
        } } : {}),
        serviceTier, summary: request.reasoningSummary,
        ...(request.outputSchema ? { outputSchema: request.outputSchema } : {}),
      });
      if (!record(result) || !record(result.turn) || typeof result.turn.id !== 'string') throw new Error('Native session returned no turn');
      this.state = bindSessionTurn(this.state!, result.turn.id, turn);
      this.publish();
      await this.ready();
    } catch (error) {
      // An ambiguous turn/start must not be retried against a still-running model.
      await this.close();
      throw error;
    } finally { this.starting = false; this.startingTurn = undefined; }
  }

  public steer(turnId: string, input: AgentSessionInputMessageParam[], operationId: string): Promise<void> {
    const digest = JSON.stringify({ turnId, input });
    const previous = this.operations.get(operationId);
    if (previous) return previous.digest === digest ? previous.promise : Promise.reject(new Error('Input operation changed on retry'));
    const binding = this.binding(turnId);
    if (terminal(binding.turn)) return Promise.reject(new Error('The intended Session Turn has already ended'));
    const promise = this.rpc.call('turn/steer', { threadId: binding.threadId, expectedTurnId: binding.nativeTurnId, input: nativeInput(input) }).then(() => undefined);
    this.operations.set(operationId, { digest, promise });
    return promise;
  }

  private async ready(): Promise<void> {
    const root = () => [...this.state!.turns].reverse().find((binding) => binding.threadId === this.state!.rootThreadId);
    await this.options.request.onTurnStarted?.({
      threadId: this.state!.rootThreadId, turnId: root()?.nativeTurnId ?? 'idle',
      startSessionTurn: (turn, input, settings) => this.start(turn, input, settings),
      steer: async (text, input, turnId) => {
        if (!turnId) throw new Error('The intended Session Turn is required');
        return this.steer(turnId, input ?? [{ role: 'user', content: [{ type: 'input_text', text }] }], `native-${crypto.randomUUID()}`);
      },
      interrupt: async (turnId) => {
        if (!turnId) throw new Error('The intended Session Turn is required');
        await this.cancel(turnId);
      },
      sessionItems: async () => root()?.items ?? [],
      ...(this.options.checkpoint ? { checkpoint: () => this.checkpoint() } : {}),
    });
  }

  public async cancel(turnId: string): Promise<void> {
    const binding = this.binding(turnId);
    if (terminal(binding.turn)) return;
    // The stock interrupt acknowledgement can precede its terminal notification.
    // Observe the exact existing binding before admitting another public Turn.
    const stopped = this.waitForTerminal(binding.threadId, binding.nativeTurnId);
    try { await this.rpc.call('turn/interrupt', { threadId: binding.threadId, turnId: binding.nativeTurnId }); await stopped.promise; }
    finally { stopped.release(); }
  }

  private waitForTerminal(threadId: string, nativeTurnId: string) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let observe = () => {};
    const release = () => { clearTimeout(timer); this.terminalWaiters.delete(observe); };
    const promise = new Promise<void>((resolve, reject) => {
      observe = () => {
        const binding = this.state?.turns.find(value => value.threadId === threadId && value.nativeTurnId === nativeTurnId);
        if (this.closed) { release(); reject(new Error('Executor closed before interruption settled')); }
        else if (binding && terminal(binding.turn)) { release(); resolve(); }
      };
      this.terminalWaiters.add(observe);
      timer = setTimeout(() => { release(); reject(new Error('Native interruption terminal notification timed out')); }, 30_000);
      observe();
    });
    void promise.catch(() => {});
    return { promise, release };
  }

  public async toolResult(result: ToolResult): Promise<void> {
    const binding = this.binding(result.turn_id);
    const key = `${binding.threadId}:${binding.nativeTurnId}:${result.call_id}`;
    const request = this.requests.get(key);
    if (!request) {
      if (!this.state!.requiredActions.some((action) => action.type === 'function_call' && action.turn_id === result.turn_id && action.call_id === result.call_id)) return;
      throw new Error('The function call is not available');
    }
    const content = result.success ? typeof result.output === 'string' ? [{ type: 'inputText', text: result.output }] : (result.output ?? []).map((part) => part.type === 'input_text' ? { type: 'inputText', text: part.text } : { type: 'inputImage', imageUrl: part.image_url }) : [{ type: 'inputText', text: result.error ?? 'Function failed' }];
    request.resolve({ success: result.success, contentItems: content });
    this.requests.delete(key);
    this.state = resolveSessionFunction(this.state!, result.turn_id, result.call_id, { completedAt: this.now(), success: result.success });
    this.publish();
  }

  public async close(): Promise<void> {
    await this.rpc.close();
    this.disconnected();
  }

  private binding(turnId: string) {
    if (this.closed || this.checkpointing) throw new Error('Session runtime is unavailable');
    const binding = this.state?.turns.find((binding) => binding.turn.id === turnId);
    if (!binding) throw new Error('Turn does not belong to this session runtime');
    return binding;
  }

  private event(event: CodexRpcEvent): void {
    if (this.checkpointing && checkpointHasActivity(event)) this.checkpointActivity = true;
    if (!this.state) { this.earlyEvents.push(event); return; }
    const nativeTurn = record(event.params.turn) ? event.params.turn.id : event.params.turnId;
    // Hydration notifications can arrive after thread/fork returns, even while
    // the first child Turn is being started. Never bind a source Turn to it.
    if (typeof nativeTurn === 'string' && this.inheritedNativeTurns.has(nativeTurn)) { this.inheritForkUsage(event); return; }
    // Only declared function requests become application-required actions.
    if (event.requestId !== undefined && !this.declaredFunction(event)) return;
    void Promise.resolve(this.options.request.onEvent?.(event)).catch(() => this.close());
    if (typeof event.params.threadId === 'string' && event.params.threadId !== this.state.rootThreadId && !this.state.subagents.some((agent) => agent.id === event.params.threadId)) {
      // A child can start before its parent's spawn completion reaches us. Keep
      // that short race bounded; only a later owned spawn authorizes replay.
      if (this.childEvents.length >= 1000) { void this.close(); return; }
      this.childEvents.push(event);
      return;
    }
    const next = reduceSessionRuntime(this.state, { ...event, observedAt: this.now() });
    if (next === this.state) return;
    this.state = next;
    // Notifications may precede turn/start's reply. Bind the pending API Turn
    // before publishing so even a very fast turn retains its start/tool events.
    if (this.startingTurn && event.params.threadId === this.state.rootThreadId) {
      const turn = record(event.params.turn) ? event.params.turn : undefined;
      const nativeId = typeof turn?.id === 'string' ? turn.id : typeof event.params.turnId === 'string' ? event.params.turnId : undefined;
      const binding = this.state.turns.find((entry) => entry.threadId === this.state!.rootThreadId && entry.nativeTurnId === nativeId);
      if (binding && binding.turn.id === nativeId) this.state = bindSessionTurn(this.state, nativeId!, this.startingTurn);
    }
    for (let index = 0; index < this.childEvents.length;) {
      const pending = this.childEvents[index]!;
      if (this.state.subagents.some((agent) => agent.id === pending.params.threadId)) {
        this.childEvents.splice(index, 1);
        this.state = reduceSessionRuntime(this.state, { ...pending, observedAt: this.now() });
      } else index++;
    }
    this.publish();
  }

  private inheritForkUsage(event: CodexRpcEvent): void {
    if (event.method !== 'thread/tokenUsage/updated' || !this.state || this.state.threadUsage?.[this.state.rootThreadId]) return;
    const inherited = reduceSessionRuntime(this.state, { ...event, observedAt: this.now() });
    if (inherited.threadUsage) this.state = { ...this.state, threadUsage: inherited.threadUsage };
  }

  private declaredFunction(event: CodexRpcEvent): boolean {
    return event.method === 'item/tool/call' && event.params.threadId === this.state?.rootThreadId
      && (this.options.request.dynamicTools ?? []).some((tool) => tool.type === 'namespace'
        ? tool.name === event.params.namespace && Array.isArray(tool.tools)
          && tool.tools.some((child: unknown) => record(child) && child.type === 'function' && child.name === event.params.tool)
        : event.params.namespace == null && tool.name === event.params.tool);
  }

  private async serverRequest(event: CodexRpcEvent & { requestId: string | number }): Promise<unknown> {
    if (this.checkpointing) { this.checkpointActivity = true; throw new Error('Native interaction is unavailable during checkpoint shutdown'); }
    if (event.method === 'currentTime/read') return { currentTimeAt: this.now() };
    if (!this.declaredFunction(event)) {
      // Approval-shaped requests fail closed; a guest never widens its own envelope.
      console.error(JSON.stringify({ message: 'Native harness requested an undeclared host interaction',
        method: /^[A-Za-z][A-Za-z0-9/]{0,100}$/.test(event.method) ? event.method : 'unknown' }));
      void this.close();
      throw new Error('The session requested an undeclared host interaction');
    }
    const { threadId, turnId, callId } = event.params;
    if (typeof threadId !== 'string' || typeof turnId !== 'string' || typeof callId !== 'string') throw new Error('Invalid native function request');
    if (this.options.request.onServerRequest) {
      const result = await this.options.request.onServerRequest(event);
      const binding = this.state!.turns.find((binding) => binding.threadId === threadId && binding.nativeTurnId === turnId);
      if (binding) { this.state = resolveSessionFunction(this.state!, binding.turn.id, callId); this.publish(); }
      return result;
    }
    return new Promise((resolve, reject) => {
      this.requests.set(`${threadId}:${turnId}:${callId}`, { nativeTurnId: turnId, threadId, callId, resolve, reject });
    });
  }

  private disconnected(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.idleTimer);
    clearTimeout(this.lifetimeTimer);
    if (this.state) {
      this.state = stoppedSessionRuntime(this.state, this.now());
      this.publish();
    }
    for (const request of this.requests.values()) request.reject(new Error('Session runtime closed'));
    this.requests.clear();
    if (!this.checkpointing) this.finish();
  }
  private now() { return this.options.now?.() ?? Math.floor(Date.now() / 1000); }
  private publish() {
    if (!this.state) return;
    this.options.changed?.(this.state);
    for (const observe of [...this.terminalWaiters]) observe();
    if (this.closed) return;
    if (this.state.turns.some((binding) => !terminal(binding.turn))) { clearTimeout(this.idleTimer); this.idleTimer = undefined; }
    // Connected environments receive host keep-alives between turns. Only an
    // explicit host idle policy may shorten that lifetime; stream disconnects do not.
    else if (!this.idleTimer && this.options.idleTimeoutMs !== undefined) { this.idleTimer = setTimeout(() => { this.expired = true; void this.close(); }, this.options.idleTimeoutMs); this.idleTimer.unref(); }
  }
}

function checkpointThreadIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 1000
    || value.some(id => typeof id !== 'string' || !id.length || id.length > 256 || id.trim() !== id)
    || new Set(value).size !== value.length) throw new Error('Invalid native checkpoint thread identities');
  return [...value] as string[];
}



function checkpointThreadPage(value: unknown): { ids: string[]; nextCursor?: string } {
  if (!record(value)) throw new Error('Invalid native thread list');
  const ids = checkpointThreadIds(value.data);
  const cursor = value.nextCursor;
  if (ids.length > 100 || cursor != null && (typeof cursor !== 'string' || !cursor.length || cursor.length > 256 || !ids.length)) {
    throw new Error('Invalid native thread pagination');
  }
  return { ids, ...(typeof cursor === 'string' ? { nextCursor: cursor } : {}) };
}

function checkpointHasActivity(event: CodexRpcEvent): boolean {
  return event.requestId !== undefined || event.method.startsWith('item/')
    || ['thread/started', 'turn/started', 'turn/completed', 'rawResponseItem/completed', 'rawResponse/completed', 'error'].includes(event.method)
    || event.method === 'thread/status/changed' && record(event.params.status) && event.params.status.type === 'active';
}

function nativeInput(input: AgentSessionInputMessageParam[]) { return input.flatMap((message) => message.content.map((part) => part.type === 'input_text' ? { type: 'text', text: part.text } : { type: 'image', url: part.image_url })); }
function terminal(turn: Turn): boolean { return ['completed', 'cancelled', 'failed'].includes(turn.status); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
