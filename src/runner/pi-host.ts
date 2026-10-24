import { syncWorkspaceStorage } from './workspace-sync.js';
import { checkpointWorkspace } from './workspace-handoff.js';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { AgentDriverControl, AgentExecution } from './agent-driver.js';
import type { NativeLease } from '../core/session-native-store.js';
import type { SessionRuntimeState } from '../core/session-runtime-planning.js';
import type { SessionLaunch, SessionReplayCommand } from '../domain/session-execution.js';
import type { RunRequest } from '../domain/contracts.js';
import { AgentsResourceConflictError } from '../domain/agents-api-validation.js';
import { planCodexLaunch } from './agent-planning.js';
import { createPiEffectBroker } from './pi-effect-broker.js';
import { decodePiChildMessage, decodePiCommandResult, type PiCommandOperation, type PiCommandResults, type PiHostMessage, type PiHostOperation } from './pi/ipc.js';

type HostPhase = 'initialize' | 'replay' | 'running' | 'checkpoint' | 'close';
type FailureClass = 'resource_conflict' | 'operation_failed';
type HostDiagnostic =
  | { event: 'pi_operation_failed'; operation: PiHostOperation; phase: HostPhase; failure: FailureClass }
  | { event: 'pi_child_exit'; phase: HostPhase; code: number | null; signal: NodeJS.Signals | null };

function classifyHostFailure(error: unknown): FailureClass {
  return error instanceof AgentsResourceConflictError ? 'resource_conflict' : 'operation_failed';
}

function writeHostDiagnostic(diagnostic: HostDiagnostic): void {
  console.error(JSON.stringify(diagnostic));
}

export interface PiHostDependencies {
  lease: NativeLease;
  allowedModelIds: readonly string[];
  token(): Promise<string>;
  changed(snapshot: SessionRuntimeState, nativeSeq: number): Promise<void>;
  saveForkContext?(checkpoint: unknown): Promise<void>;
}

export async function executePiWorker(request: RunRequest, workspace: string, timeoutMs: number, control: AgentDriverControl, dependencies: PiHostDependencies, signal?: AbortSignal): Promise<AgentExecution> {
  const launch = control.session;
  if (!launch || launch.runtime?.kind !== 'pi') throw new Error('Pi requires a pinned Agents Session');
  // The host stores bytes under its private state root; tools see the verified bind mount.
  const plan = planCodexLaunch(request, launch.environment.type === 'openai_hosted' ? '/workspace' : workspace, timeoutMs, process.env);
  if (!plan.identity) throw new Error('Pi requires a separate non-root process identity');
  const broker = await createPiEffectBroker({ launch, plan, lease: dependencies.lease, ...(launch.environment.type === 'openai_hosted' ? { flushWorkspace: () => syncWorkspaceStorage(workspace) } : {}), ...(control.sessionMcp ? { mcp: control.sessionMcp } : {}), ...(control.sessionEnvironmentCredentials ? { credentials: control.sessionEnvironmentCredentials } : {}), ...(signal ? { signal } : {}) });
  const child = fork(fileURLToPath(new URL('./pi-child.mjs', import.meta.url)), [], {
    cwd: workspace, ...plan.identity, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    execArgv: [], serialization: 'json',
    env: piChildEnvironment(),
  });
  let exited = false;
  let ready = false;
  let phase: HostPhase = 'initialize';
  let checkpointPromise: Promise<unknown> | undefined;
  let snapshot: SessionRuntimeState | undefined;
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  const effects = new Map<string, AbortController>();
  let openEffects!: () => void;
  const effectsReady = new Promise<void>(resolve => { openEffects = resolve; });
  const send = (message: PiHostMessage) => { if (child.connected) child.send(message); };
  const invoke = <O extends PiCommandOperation>(operation: O) => new Promise<PiCommandResults[O['method']]>((resolve, reject) => {
    if (exited) return reject(new Error('Pi child is unavailable'));
    const id = randomUUID();
    pending.set(id, { resolve: value => { try { resolve(decodePiCommandResult<O['method']>(operation.method, value)); } catch { reject(new Error('Invalid Pi command result')); } }, reject });
    send({ kind: 'command', id, ...operation });
  });
  let finish!: () => void;
  let fail!: (error: Error) => void;
  const finished = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
  void finished.catch(() => {});
  const stopped = new Promise<void>(resolve => child.once('exit', () => resolve()));
  child.on('message', raw => {
    const message = decodePiChildMessage(raw);
    if (message.kind === 'invalid') { fail(new Error('Invalid Pi protocol')); if (message.kill) child.kill('SIGKILL'); return; }
    if (message.kind === 'invalid-request') {
      writeHostDiagnostic({ event: 'pi_operation_failed', operation: message.operation, phase, failure: 'operation_failed' });
      send({ kind: 'response', id: message.id, ok: false });
      return;
    }
    if (message.kind === 'result' || message.kind === 'invalid-result') {
      const waiter = pending.get(message.id); pending.delete(message.id);
      if (message.kind === 'result' && message.ok) waiter?.resolve(message.value); else waiter?.reject(new Error('Pi command failed'));
      return;
    }
    if (message.kind === 'finished') { finish(); return; }
    const id = message.id;
    const operationPhase = phase;
    const operation = message.method;
    void (async () => {
      let result: unknown;
      switch (message.method) {
        case 'load': result = await dependencies.lease.load(); break;
        case 'reserve': {
          result = await dependencies.lease.reserveIds(message.value.count, message.value.requestId); break;
        }
        case 'commit': {
          result = await dependencies.lease.commit(message.value); break;
        }
        case 'projection': {
          snapshot = message.value.snapshot as SessionRuntimeState;
          if (snapshot.sessionId !== launch.sessionId || snapshot.agentId !== launch.agent.id) throw new Error('Invalid projection identity');
          await dependencies.changed(snapshot, message.value.seq); break;
        }
        case 'token':
          await effectsReady; signal?.throwIfAborted(); await dependencies.lease.assertActive(); result = await dependencies.token(); break;
        case 'effect': {
          await effectsReady; signal?.throwIfAborted(); await dependencies.lease.assertActive();
          const abort = new AbortController(); effects.set(id, abort);
          try { result = await broker.execute(message.value, abort.signal); }
          finally { effects.delete(id); }
          break;
        }
        case 'effect_cancel': effects.get(message.value)?.abort(); break;
      }
      send({ kind: 'response', id, ok: true, value: result });
    })().catch(error => {
      writeHostDiagnostic({ event: 'pi_operation_failed', operation, phase: operationPhase, failure: classifyHostFailure(error) });
      send({ kind: 'response', id, ok: false });
    });
  });
  child.once('error', () => fail(new Error('Pi child failed to start')));
  child.once('exit', (code, exitSignal) => {
    exited = true;
    writeHostDiagnostic({ event: 'pi_child_exit', phase, code, signal: exitSignal });
    for (const waiter of pending.values()) waiter.reject(new Error('Pi child stopped'));
    pending.clear();
    for (const effect of effects.values()) effect.abort();
    if (code !== 0 || !ready) fail(new Error('Pi child stopped unexpectedly')); else finish();
  });
  const abort = () => { openEffects(); for (const effect of effects.values()) effect.abort(); child.kill('SIGTERM'); };
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  const started = Date.now();
  try {
    await dependencies.lease.assertActive();
    const childLaunch: SessionLaunch = { runtime: launch.runtime, sessionId: launch.sessionId, turnId: launch.turnId, agent: launch.agent,
      environment: launch.environment, input: launch.input, ...(launch.turn ? { turn: launch.turn } : {}), ...(launch.piForkContext ? { piForkContext: launch.piForkContext } : {}) };
    phase = 'initialize';
    await invoke({ method: 'initialize', value: { launch: childLaunch, allowedModelIds: dependencies.allowedModelIds, tools: broker.tools, mode: control.sessionRuntime?.lifetime === 'host-managed' ? 'persistent' : 'bounded' } });
    for (const command of launch.replay ?? (launch.turn ? [{ type: 'start', turn: launch.turn, input: launch.input } satisfies SessionReplayCommand] : [])) {
      phase = 'replay';
      await invoke({ method: 'replay', value: command });
    }
    ready = true;
    openEffects();
    phase = 'running';
    await invoke({ method: 'resume' });
    await control.onTurnStarted?.({ threadId: snapshot?.rootThreadId ?? 'pi-root', turnId: launch.turnId,
      steer: async (_text, input, turnId, operationId) => { if (turnId === undefined || input === undefined) throw new Error('Pi steering requires Turn input'); await invoke({ method: 'replay', value: { type: 'steer', turnId, input, operationId: operationId ?? randomUUID() } }); },
      interrupt: async turnId => { if (turnId === undefined) throw new Error('Pi cancellation requires a Turn'); await invoke({ method: 'replay', value: { type: 'cancel', turnId } }); },
      sessionItems: async () => snapshot?.turns.flatMap(turn => turn.items) ?? [],
      startSessionTurn: async (turn, input, settings) => { await invoke({ method: 'replay', value: { type: 'start', turn, input, ...(settings ? { settings } : {}) } }); },
      respondSessionTool: async (callId, result) => { await invoke({ method: 'replay', value: piToolResultCommand(callId, result) }); },
      ...(control.sessionRuntime?.checkpoint ? { checkpoint: async () => {
        const checkpoint = control.sessionRuntime!.checkpoint!;
        phase = 'checkpoint';
        checkpointPromise = checkpointWorkspace({ ...checkpoint,
          inspectIdle: () => ({ idle: Boolean(snapshot && !snapshot.requiredActions.length && snapshot.turns.every(binding => ['completed', 'failed', 'cancelled'].includes(binding.turn.status))), threadIds: snapshot ? [snapshot.rootThreadId, ...snapshot.subagents.map(agent => agent.id)] : [] }),
          shutdownNative: async () => {
            const context = await invoke({ method: 'checkpoint' });
            await dependencies.saveForkContext?.(context);
            phase = 'close';
            await invoke({ method: 'close' });
            await stopped;
            await broker.close();
            return { threadIds: snapshot ? [snapshot.rootThreadId, ...snapshot.subagents.map(agent => agent.id)] : [], flushed: true, forced: false };
          },
          commit: async () => { if (!snapshot) throw new Error('Pi checkpoint has no projection'); return checkpoint.commit(snapshot); },
          settle: () => {},
        });
        return checkpointPromise;
      } } : {}),
    });
    await finished;
    await checkpointPromise;
    return { fullText: snapshot?.turns.at(-1)?.items.flatMap(item => item.type === 'message' && item.role === 'assistant' ? item.content.flatMap(part => part.type === 'output_text' ? [part.text] : []) : []).join('\n\n') ?? '', exitCode: 0, durationMs: Date.now() - started, events: Buffer.alloc(0), ...(snapshot ? { threadId: snapshot.rootThreadId } : {}) };
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort); openEffects();
    if (!exited) { child.kill('SIGTERM'); const kill = setTimeout(() => child.kill('SIGKILL'), 1000); await stopped; clearTimeout(kill); }
    await broker.close();
  }
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

export function piToolResultCommand(callId: string, value: unknown): { type: 'tool_result'; callId: string; success: boolean; output: unknown } {
  if (!record(value) || typeof value.success !== 'boolean') throw new Error('Invalid Pi function result');
  return { type: 'tool_result', callId, success: value.success, output: value.output };
}

export function piChildEnvironment(): NodeJS.ProcessEnv {
  return { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp', LANG: 'C.UTF-8', AWS_EC2_METADATA_DISABLED: 'true', AWS_SHARED_CREDENTIALS_FILE: '/dev/null', AWS_CONFIG_FILE: '/dev/null' };
}
