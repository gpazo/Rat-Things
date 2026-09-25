import type { AgentSessionInputMessageParam, AgentSessionInputParam, Turn } from '../domain/agents-api.js';
import { CodexRpcClient, CodexRpcError, type CodexRpcEvent } from '../adapters/codex-rpc.js';
import { bindSessionTurn, initialSessionRuntime, reduceSessionRuntime, resolveSessionFunction, rootTurnBusy, stoppedSessionRuntime, type SessionRuntimeState } from '../core/session-runtime-planning.js';
import type { CodexAppServerRequest } from './codex-app-server.js';
import { sandboxPolicyFor } from './codex-app-server.js';
import type { SessionModelSettings } from '../domain/session-execution.js';

type ToolResult = Extract<AgentSessionInputParam, { type: 'agent.session.input.tool_result' }>;
interface PendingFunction { nativeTurnId: string; threadId: string; callId: string; resolve(value: unknown): void; reject(error: Error): void }

/** One native harness stays alive across root turns and background subagent work. */
export class SessionRuntime {
  private readonly rpc: Pick<CodexRpcClient, 'initialize' | 'call' | 'close'>;
  private state: SessionRuntimeState | undefined;
  private readonly requests = new Map<string, PendingFunction>();
  private readonly started = new Map<string, Promise<void>>();
  private readonly operations = new Map<string, { digest: string; promise: Promise<void> }>();
  private readonly earlyEvents: CodexRpcEvent[] = [];
  private readonly childEvents: CodexRpcEvent[] = [];
  private starting = false;
  private startingTurn: Turn | undefined;
  private closed = false;
  private expired = false;
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
    client?: (options: ConstructorParameters<typeof CodexRpcClient>[0]) => Pick<CodexRpcClient, 'initialize' | 'call' | 'close'>;
  }) {
    this.finished = new Promise<void>((resolve) => { this.finish = resolve; });
    const request = options.request;
    const args: ConstructorParameters<typeof CodexRpcClient>[0] = {
      binary: request.binary, cwd: request.workspace, environment: request.environment,
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

  public async initialize(): Promise<SessionRuntimeState> {
    const request = this.options.request;
    await this.rpc.initialize();
    const parameters = {
      cwd: request.executionWorkspace ?? request.workspace,
      modelProvider: request.modelProvider, model: request.model,
      approvalPolicy: 'never', approvalsReviewer: 'user', ...(request.permissions ? { permissions: request.permissions } : { sandbox: request.sandbox }),
      ephemeral: false, serviceName: 'rat-things', allowProviderModelFallback: false,
      experimentalRawEvents: true,
      selectedCapabilityRoots: request.selectedCapabilityRoots ?? [],
      developerInstructions: request.developerInstructions,
      serviceTier: request.serviceTier,
      environments: request.environments,
      dynamicTools: request.dynamicTools,
      config: { ...request.sessionConfig, web_search: request.webSearch ?? 'disabled',
        'features.default_mode_request_user_input': false, 'tools.experimental_request_user_input.enabled': false,
        'orchestrator.skills.enabled': false, 'skills.bundled.enabled': false, 'features.goals': false },
    };
    let resumed = false;
    let thread: unknown;
    const resumeThreadId = this.options.previous?.rootThreadId ?? request.resumeThreadId;
    if (resumeThreadId) {
      try {
        const { dynamicTools: _tools, environments: _environments, ...resume } = parameters;
        thread = await this.rpc.call('thread/resume', { ...resume, threadId: resumeThreadId });
        resumed = true;
      } catch (error) {
        if (!(error instanceof CodexRpcError) || !error.missingThread) throw error;
        thread = await this.rpc.call('thread/start', parameters);
      }
    } else thread = await this.rpc.call('thread/start', parameters);
    if (!record(thread) || !record(thread.thread) || typeof thread.thread.id !== 'string') throw new Error('Native session initialization failed');
    this.state = initialSessionRuntime(this.options.sessionId, this.options.agentId, thread.thread.id);
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
    for (const event of this.earlyEvents.splice(0)) this.event(event);
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
    if (!this.state || this.closed) return Promise.reject(new Error('Session runtime is unavailable'));
    if (rootTurnBusy(this.state, this.starting)) return Promise.reject(new Error('The root agent already has an active turn'));
    const promise = this.startTurn(turn, input, this.state.rootThreadId, settings);
    this.started.set(turn.id, promise);
    return promise;
  }

  private async startTurn(turn: Turn, input: AgentSessionInputMessageParam[], rootThreadId: string, settings?: SessionModelSettings): Promise<void> {
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
        serviceTier: settings?.service_tier ?? request.serviceTier, summary: request.reasoningSummary,
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
    });
  }

  public async cancel(turnId: string): Promise<void> {
    const binding = this.binding(turnId);
    if (terminal(binding.turn)) return;
    await this.rpc.call('turn/interrupt', { threadId: binding.threadId, turnId: binding.nativeTurnId });
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
    this.state = resolveSessionFunction(this.state!, result.turn_id, result.call_id);
    this.publish();
  }

  public async close(): Promise<void> {
    await this.rpc.close();
    this.disconnected();
  }

  private binding(turnId: string) {
    const binding = this.state?.turns.find((binding) => binding.turn.id === turnId);
    if (!binding) throw new Error('Turn does not belong to this session runtime');
    return binding;
  }

  private event(event: CodexRpcEvent): void {
    if (!this.state) { this.earlyEvents.push(event); return; }
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

  private declaredFunction(event: CodexRpcEvent): boolean {
    return event.method === 'item/tool/call' && event.params.threadId === this.state?.rootThreadId
      && (this.options.request.dynamicTools ?? []).some((tool) => tool.type === 'namespace'
        ? tool.name === event.params.namespace && Array.isArray(tool.tools)
          && tool.tools.some((child: unknown) => record(child) && child.type === 'function' && child.name === event.params.tool)
        : event.params.namespace == null && tool.name === event.params.tool);
  }

  private async serverRequest(event: CodexRpcEvent & { requestId: string | number }): Promise<unknown> {
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
    this.finish();
  }
  private now() { return this.options.now?.() ?? Math.floor(Date.now() / 1000); }
  private publish() {
    if (!this.state) return;
    this.options.changed?.(this.state);
    if (this.closed) return;
    if (this.state.turns.some((binding) => !terminal(binding.turn))) { clearTimeout(this.idleTimer); this.idleTimer = undefined; }
    // Connected environments receive host keep-alives between turns. Only an
    // explicit host idle policy may shorten that lifetime; stream disconnects do not.
    else if (!this.idleTimer && this.options.idleTimeoutMs !== undefined) { this.idleTimer = setTimeout(() => { this.expired = true; void this.close(); }, this.options.idleTimeoutMs); this.idleTimer.unref(); }
  }
}

function nativeInput(input: AgentSessionInputMessageParam[]) { return input.flatMap((message) => message.content.map((part) => part.type === 'input_text' ? { type: 'text', text: part.text } : { type: 'image', url: part.image_url })); }
function terminal(turn: Turn): boolean { return ['completed', 'cancelled', 'failed'].includes(turn.status); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
