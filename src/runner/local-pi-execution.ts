import { randomUUID } from 'node:crypto';
import type { Models } from '@earendil-works/pi-ai';
import type { AgentsStore } from '../core/agents-ports.js';
import type { SessionExecution, SessionState, SessionTurnBinding } from '../core/session-ports.js';
import { SessionRuntimeStore } from '../core/session-runtime-store.js';
import { nativeLease } from '../core/session-native-store.js';
import { runtimeSubagents } from '../core/session-runtime-planning.js';
import { terminalTurn } from '../core/session-planning.js';
import type { AgentSession, EnvironmentParam, Turn } from '../domain/agents-api.js';
import { AgentsApiError } from '../domain/agents-api-validation.js';
import type { RuntimePin } from '../domain/session-runtime.js';
import { LocalRuntimeLifecycle } from '../adapters/local-runtime-lifecycle.js';
import { openPiStorage } from './pi/storage.js';
import { openPiEngine, type PiEngine } from './pi/engine.js';
import { PI_CONTEXT } from './pi/protocol.js';

/** Host inference and durable state. No host filesystem, shell, MCP or ambient credentials become tools. */
export class LocalPiExecution implements SessionExecution {
  private readonly runtimes = new Map<string, Promise<PiEngine>>();
  private readonly lifecycle = new LocalRuntimeLifecycle();
  private readonly journal: SessionRuntimeStore;
  private closing = false;
  public constructor(private readonly options: {
    store: AgentsStore; maxSessions: number;
    models: (pin: Extract<RuntimePin, { kind: 'pi' }>) => Models;
  }) { this.journal = new SessionRuntimeStore(options.store); }

  public async prepare(_owner: string, _id: string, environment: EnvironmentParam, agent: AgentSession['agent'], vaultIds: string[]) {
    if (environment.type !== 'none') throw new AgentsApiError(400, 'Local Pi currently requires No environment. Managed tools require an isolated Pi worker.', 'unsupported_environment', 'environment');
    if (vaultIds.length || agent.tools.some(tool => tool.type !== 'function' && !(tool.type === 'programmatic_tool_calling' && !tool.enabled))) {
      throw new AgentsApiError(400, 'Local Pi supports application functions and subagents. Vaults and MCP require a configured isolated worker.', 'unsupported_tool', 'agent.tools');
    }
    return { type: 'none' as const };
  }
  public initialize(owner: string, session: AgentSession) { return this.reconcile(owner, session); }
  public reconcile(owner: string, session: AgentSession) {
    return this.lifecycle.run(session.id, async () => {
      if (this.closing || this.runtimes.has(session.id)) return;
      const state = await this.options.store.get<SessionState>(owner, 'sessions', session.id);
      // Undispatched commands must be replayed before the engine can resume inference.
      if (!state || state.value.closing || Object.values(state.value.receipts).some(receipt => !receipt.dispatched)) return;
      const saved = await this.journal.get(owner, session.id);
      if (saved?.value.native?.head && !saved.value.closed && (saved.value.projectionSeq !== saved.value.native.head.seq
        || saved.value.snapshot?.turns.some(binding => !terminalTurn(binding.turn)))) {
        const engine = await this.engine(owner, session);
        engine.resume();
      }
    });
  }
  public start(owner: string, session: AgentSession, binding: SessionTurnBinding) {
    return this.lifecycle.run(session.id, async () => {
      const engine = await this.engine(owner, session);
      await engine.start(binding.turn, binding.input, binding.modelSettings);
      const state = await this.options.store.get<SessionState>(owner, 'sessions', session.id);
      if (state?.value.turns.find(turn => turn.turn.id === binding.turn.id)?.cancelRequested) await engine.cancel(binding.turn.id);
      engine.resume();
    });
  }
  public steer(owner: string, session: AgentSession, turn: string, input: Parameters<SessionExecution['steer']>[3], operation: string) {
    return this.lifecycle.run(session.id, async () => {
      const engine = await this.engine(owner, session);
      await engine.steer(turn, input, operation);
      engine.resume();
    });
  }
  public cancel(owner: string, session: AgentSession, turn: string) {
    return this.lifecycle.run(session.id, async () => {
      if (!this.runtimes.has(session.id) && !(await this.journal.get(owner, session.id))?.value.native?.head) return;
      const engine = await this.engine(owner, session);
      if (engine.snapshot().turns.some(binding => binding.turn.id === turn)) await engine.cancel(turn);
      engine.resume();
    });
  }
  public toolResult(owner: string, session: AgentSession, event: Parameters<SessionExecution['toolResult']>[2]) {
    return this.lifecycle.run(session.id, async () => {
      const engine = await this.engine(owner, session);
      const action = engine.snapshot().requiredActions.find(action => action.type === 'function_call' && action.call_id === event.call_id);
      if (action?.type === 'function_call' && action.turn_id !== event.turn_id) throw new AgentsApiError(409, 'Function result belongs to a different Turn.', 'conflict');
      await engine.toolResult(event.call_id, { success: event.success, output: event.success ? event.output : event.error ?? 'Function failed' });
      engine.resume();
    });
  }
  public async observe(owner: string, session: AgentSession, turn: Turn) {
    const snapshot = await this.snapshot(owner, session.id);
    return { turn: snapshot?.turns.find(binding => binding.turn.id === turn.id)?.turn ?? turn, requiredActions: snapshot?.requiredActions ?? [] };
  }
  public async items(owner: string, session: AgentSession, turn: string) { return (await this.snapshot(owner, session.id))?.turns.find(binding => binding.turn.id === turn)?.items ?? []; }
  public async traceSteps(owner: string, session: AgentSession, turn: string) { return (await this.snapshot(owner, session.id))?.turns.find(binding => binding.turn.id === turn)?.traceSteps ?? []; }
  public async subagents(owner: string, session: AgentSession) { const state = await this.snapshot(owner, session.id); return state ? runtimeSubagents(state) : []; }
  public async artifacts() { return []; }
  public async artifactContent(): Promise<ReadableStream<Uint8Array>> { throw new AgentsApiError(404, 'Artifact not found.', 'resource_not_found'); }
  public close(owner: string, session: AgentSession) {
    return this.lifecycle.run(session.id, async () => {
      await this.retire(session.id);
      await this.journal.close(owner, session.id);
    });
  }
  public shutdown() {
    this.closing = true;
    return this.lifecycle.close(async () => { await Promise.all([...this.runtimes.keys()].map(id => this.retire(id))); });
  }
  private async snapshot(owner: string, id: string) {
    return (await this.journal.get(owner, id))?.value.snapshot;
  }
  private async retire(id: string, expected?: Promise<PiEngine>) {
    const pending = this.runtimes.get(id);
    if (expected && expected !== pending) return;
    const engine = await pending?.catch(() => undefined);
    await engine?.close();
    if (pending === this.runtimes.get(id)) this.runtimes.delete(id);
  }
  private engine(owner: string, session: AgentSession): Promise<PiEngine> {
    if (this.closing) return Promise.reject(new AgentsApiError(503, 'Local workspace is shutting down.', 'service_unavailable'));
    const existing = this.runtimes.get(session.id);
    if (existing) return existing;
    if (this.runtimes.size >= this.options.maxSessions) return Promise.reject(new AgentsApiError(503, 'All local Pi Session slots are busy. Work stays queued until a slot is free.', 'local_capacity'));
    const pending = this.open(owner, session);
    this.runtimes.set(session.id, pending);
    void pending.then(engine => engine.finished).then(() => {
      if (!this.closing) return this.lifecycle.run(session.id, () => this.retire(session.id, pending));
    }).catch(() => { if (!this.closing) void this.lifecycle.run(session.id, () => this.retire(session.id, pending)).catch(() => {}); });
    return pending;
  }
  private async open(owner: string, session: AgentSession): Promise<PiEngine> {
    const state = await this.options.store.get<SessionState>(owner, 'sessions', session.id);
    if (state?.value.runtime?.kind !== 'pi' || state.value.closing || session.environment.type !== 'none') throw new Error('A pinned local Pi Session with no environment is required');
    const pin = state.value.runtime;
    const previous = await this.journal.get(owner, session.id);
    const runId = randomUUID();
    await this.journal.claim(owner, session.id, runId, session.created_at, previous);
    const lease = nativeLease(this.options.store, owner, session.id, runId, (previous?.value.epoch ?? -1) + 1);
    const storage = await openPiStorage(lease);
    try {
      return await openPiEngine({ storage, models: this.options.models(pin), mode: 'bounded', nativeSeq: previous?.value.native?.head?.seq ?? 0,
        launch: { sessionId: session.id, turnId: '', runtime: pin, agent: session.agent, environment: session.environment, input: [] },
        effect: async () => { throw new Error('No host effects are admitted in this Session'); },
        changed: async (snapshot, seq) => { await this.journal.publishNative(owner, session.id, runId, seq, snapshot); },
      });
    } catch (error) { await storage.close(PI_CONTEXT); throw error; }
  }
}
