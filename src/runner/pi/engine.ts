export type { PiEffectTool, PiToolEffect, PiToolEffectHandler, PiRootCheckpoint, PiFunctionResult } from './protocol.js';
import type { Models, ModelThinkingLevel } from '@earendil-works/pi-ai';
import { AgentDoc, Harness, InboxDoc, LiveDoc, configure, createRegistry, defineTool, type AgentChange, type JsonObject, type Storage } from '@earendil-works/pi-durable';
import type { SessionRuntimeState } from '../../core/session-runtime-planning.js';
import type { AgentSessionInputMessageParam, AgentSessionItem, Turn } from '../../domain/agents-api.js';
import type { SessionLaunch, SessionModelSettings } from '../../domain/session-execution.js';
import { PI_REGISTRY, piModel, validateRuntimeAgent, type RuntimePin } from '../../domain/session-runtime.js';
import { canonicalJson } from '../../domain/json.js';
import { ChildKeeperTask, coordinationTools } from './coordination.js';
import { functionTools, resolvePiFunction } from './functions.js';
import { applyPiCommit, piImageHasLiveTasks, projectPi, readPiImage, type PiCommittedImage } from './projection.js';
import { CommandsDoc, FunctionsDoc, LinksDoc, PI_CONTEXT, admitPiInput, asConversationId, json, piInput, publicCallId, type PiEffectTool, type PiFunctionResult, type PiRootCheckpoint, type PiToolEffectHandler } from './protocol.js';

export interface PiEngineOptions {
  storage: Storage;
  models: Models;
  launch: SessionLaunch;
  effect: PiToolEffectHandler;
  effectTools?: readonly PiEffectTool[];
  nativeSeq?: number;
  changed?: (snapshot: SessionRuntimeState, nativeSeq: number) => void | Promise<void>;
  mode?: 'persistent' | 'bounded';
  seed?: PiRootCheckpoint;
  now?: () => number;
}
export interface PiEngine {
  start(turn: Turn, input: AgentSessionInputMessageParam[], settings?: SessionModelSettings): Promise<void>;
  steer(turnId: string, input: AgentSessionInputMessageParam[], operationId: string): Promise<void>;
  cancel(turnId: string): Promise<void>;
  toolResult(callId: string, result: PiFunctionResult): Promise<void>;
  snapshot(): SessionRuntimeState;
  readonly nativeSeq: number;
  checkpoint(): Promise<PiRootCheckpoint>;
  resume(): void;
  close(): Promise<void>;
  readonly finished: Promise<void>;
}

export async function openPiEngine(options: PiEngineOptions): Promise<PiEngine> {
  const { launch } = options;
  const pin = launch.runtime;
  if (pin?.kind !== 'pi' || pin.engine !== '1.3.0' || pin.schema !== 1 || pin.registryDigest !== PI_REGISTRY) throw new Error('Pi 1.3.0 runtime pin is required');
  validateRuntimeAgent(pin, launch.agent);
  if (launch.environment.type === 'self_hosted') throw new Error('Pi self-hosted environments are unsupported');
  const effectTools = options.effectTools ?? [];
  if (launch.environment.type === 'none' && effectTools.some(tool => tool.kind === 'managed')) throw new Error('The none environment cannot expose managed tools');
  const now = options.now ?? Date.now;
  const registry = createRegistry();
  let harness: Harness;
  const tools = [...functionTools(launch), ...coordinationTools(launch, () => harness, now), ...effectTools.map(tool => defineTool({
    name: tool.name, description: tool.description, parameters: tool.parameters, replay: 'unsafe',
    execute: (args, api, context) => {
      if (!context.abortSignal) throw new Error('Pi tool requires an invocation cancellation signal');
      return options.effect({ kind: tool.kind, name: tool.name, arguments: json(args) as JsonObject, callId: publicCallId(api.taskId), taskId: api.taskId, conversationId: api.conversationId }, context.abortSignal);
    },
  }))];
  if (new Set(tools.map(tool => tool.name)).size !== tools.length) throw new Error('Pi tool names must be unique');
  registry.install({ name: 'rat', tools, tasks: [ChildKeeperTask] });
  const initialAgent = agentChange(pin, launch, undefined, options.models);
  if (options.seed && (options.seed.schema !== 1 || canonicalJson(options.seed.runtime) !== canonicalJson(pin))) throw new Error('Pi fork runtime does not match its immutable pin');
  harness = await Harness.open(options.storage, { models: options.models, registry, now,
    settings: { progress: { partialIntervalMs: 250, outputIntervalMs: 250 } },
  }, PI_CONTEXT);
  let initialSeq = options.nativeSeq ?? 0;
  const stopInitial = harness.subscribeCommits(publication => { initialSeq = publication.seq; });
  const root = await harness.root(PI_CONTEXT, { agent: initialAgent, init: async (tx, rootId) => {
    const links = await tx.doc(LinksDoc);
    links.sessionId = launch.sessionId;
    links.agentId = launch.turn?.agent_id ?? launch.agent.id ?? launch.sessionId;
    links.rootId = rootId;
    links.effects = json(effectTools.map(({ name, kind, serverLabel, toolName }) => ({ name, kind, serverLabel, toolName })));
    await tx.doc(CommandsDoc);
    await tx.doc(FunctionsDoc);
    if (options.seed) {
      const change = agentChange(pin, launch, { model: options.seed.model, service_tier: 'auto', reasoning: { effort: options.seed.reasoning as SessionModelSettings['reasoning']['effort'] } }, options.models);
      await configure(tx, rootId, change);
      await tx.appendEntry(rootId, { kind: 'rat.fork_context', model: structuredClone(options.seed.messages) });
      links.inherited = json(options.seed.history.map(binding => ({ ...binding, threadId: `pi_thread_${rootId}`, nativeTurnId: `pi_fork_${binding.nativeTurnId}`, items: binding.items.map(forkItem), turn: { ...binding.turn, session_id: launch.sessionId, agent_id: links.agentId, usage: null } })));
    }
  } });
  const links = await harness.snapshot(LinksDoc, PI_CONTEXT);
  if (links?.sessionId !== launch.sessionId) { await harness.close(PI_CONTEXT); throw new Error('Pi storage belongs to a different Session'); }
  let image: PiCommittedImage = await readPiImage(options.storage, initialSeq);
  stopInitial();
  let state = projectPi(image, launch, effectTools);
  let publishing = Promise.resolve();
  let operations: Promise<unknown> = Promise.resolve();
  let started = Object.keys(links.turns).length > 0;
  let resumed = false;
  let closed = false;
  let resolveFinished!: () => void;
  let rejectFinished!: (error: unknown) => void;
  const finished = new Promise<void>((resolve, reject) => { resolveFinished = resolve; rejectFinished = reject; });
  void finished.catch(() => undefined);
  const enqueue = <T>(effect: () => Promise<T>): Promise<T> => {
    const result = operations.then(() => { if (closed) throw new Error('Pi engine is closed'); return effect(); });
    operations = result.catch(() => undefined);
    return result;
  };
  const completeIfIdle = () => {
    if (options.mode !== 'bounded' || !started || !resumed) return;
    if (!piImageHasLiveTasks(image)) void publishing.then(resolveFinished, rejectFinished);
  };
  const publish = () => {
    const snapshot = structuredClone(state);
    const seq = image.seq;
    publishing = publishing.then(() => options.changed?.(snapshot, seq));
    void publishing.catch(error => { rejectFinished(error); void harness.close(PI_CONTEXT); });
    completeIfIdle();
  };
  const unsubscribe = harness.subscribeCommits(publication => {
    try {
      image = applyPiCommit(image, publication);
      state = projectPi(image, launch, effectTools);
      publish();
    } catch (error) {
      rejectFinished(error);
      void Promise.resolve().then(() => harness.close(PI_CONTEXT));
    }
  });
  void harness.closed.then(async end => {
    closed = true;
    unsubscribe();
    await publishing.catch(() => undefined);
    if (end.reason === 'failed') rejectFinished(end.error); else resolveFinished();
  });
  publish();

  const cancelAccepted = async (turnId: string): Promise<void> => {
    const key = `cancel:${turnId}`;
    for (;;) {
      const target = await harness.commit(async tx => {
        const links = await tx.doc(LinksDoc);
        const link = links.turns[turnId];
        if (!link) throw new Error('Unknown Pi Turn');
        const live = await tx.doc(LiveDoc, asConversationId(link.conversationId));
        const commands = await tx.doc(CommandsDoc);
        const previous = commands.operations[key];
        if (previous?.status === 'settled' || previous?.status === 'stale') return undefined;
        const inbox = await tx.doc(InboxDoc, asConversationId(link.conversationId));
        const cancelled = inbox.items.filter(item => item.id === link.submissionId || link.steerIds?.includes(item.id));
        for (const item of cancelled) tx.settleSubmission(item.id, { status: 'unanswered', reason: 'aborted' });
        inbox.items = inbox.items.filter(item => !cancelled.some(cancelled => cancelled.id === item.id));
        if (!live.run?.inputs.some(id => id === link.submissionId || link.steerIds?.includes(id))) {
          commands.operations[key] = { kind: 'cancel', turnId, fingerprint: turnId, status: previous || cancelled.length ? 'settled' : 'stale' };
          return undefined;
        }
        const taskId = live.run.taskId;
        commands.operations[key] = { kind: 'cancel', turnId, fingerprint: turnId, status: 'accepted', taskId };
        return { taskId, conversationId: asConversationId(link.conversationId) };
      }, PI_CONTEXT);
      if (target === undefined) return;
      await harness.abortTask(target.taskId, PI_CONTEXT);
      const live = await harness.snapshot(LiveDoc, target.conversationId, PI_CONTEXT);
      if (live?.run?.taskId === target.taskId) return;
    }
  };
  const pendingCancels = await harness.snapshot(CommandsDoc, PI_CONTEXT);
  for (const command of Object.values(pendingCancels?.operations ?? {})) if (command.kind === 'cancel' && command.status === 'accepted') await cancelAccepted(command.turnId);

  return {
    get nativeSeq() { return image.seq; }, finished,
    snapshot: () => structuredClone(state),
    resume: () => { if (closed) throw new Error('Pi engine is closed'); resumed = true; harness.resume(); completeIfIdle(); },
    start: (turn, input, settings) => enqueue(async () => {
      if (turn.session_id !== launch.sessionId || turn.subagent_id !== null) throw new Error('Pi root Turn belongs to a different Session');
      const change = agentChange(pin, launch, settings, options.models);
      const content = piInput(input);
      assertInput(pin, settings?.model ?? launch.agent.model, input);
      await harness.commit(async tx => {
        const links = await tx.doc(LinksDoc);
        if (links.turns[turn.id]) return;
        await configure(tx, root.id, change);
        const requestId = `turn:${turn.id}`;
        const submissionId = await admitPiInput(tx, root.id, requestId, content, now());
        links.turns[turn.id] = { turn: json(turn), conversationId: root.id, requestId, submissionId };
      }, PI_CONTEXT);
      started = true;
      completeIfIdle();
    }),
    steer: (turnId, input, operationId) => enqueue(async () => {
      if (!operationId) throw new Error('Pi steering requires an operation ID');
      const content = piInput(input);
      const fingerprint = canonicalJson({ turnId, content });
      const commandId = `steer:${operationId}`;
      await harness.commit(async tx => {
        const commands = await tx.doc(CommandsDoc);
        const previous = commands.operations[commandId];
        if (previous) {
          if (previous.kind !== 'steer' || previous.fingerprint !== fingerprint) throw new Error('Pi operation ID already identifies a different command');
          return;
        }
        const links = await tx.doc(LinksDoc);
        const link = links.turns[turnId];
        if (!link) throw new Error('Unknown Pi Turn');
        const conversationId = asConversationId(link.conversationId);
        const live = await tx.doc(LiveDoc, conversationId);
        const agent = await tx.doc(AgentDoc, conversationId);
        assertInput(pin, agent.model?.modelId ?? launch.agent.model, input);
        if (!live.run?.inputs.some(id => id === link.submissionId || link.steerIds?.includes(id))) {
          commands.operations[commandId] = { kind: 'steer', turnId, status: 'stale', fingerprint };
          return;
        }
        const inbox = await tx.doc(InboxDoc, conversationId);
        const submission = await tx.createSubmission({ conversationId, requestId: `steer:${operationId}`, type: 'input', status: 'queued' });
        inbox.items.push({ id: submission.id, mode: 'steer', content: json(content) });
        link.steerIds = [...link.steerIds ?? [], submission.id];
        commands.operations[commandId] = { kind: 'steer', turnId, status: 'accepted', fingerprint, taskId: live.run.taskId, submissionId: submission.id };
      }, PI_CONTEXT);
    }),
    cancel: turnId => enqueue(() => cancelAccepted(turnId)),
    toolResult: (callId, result) => enqueue(() => resolvePiFunction(harness, callId, result)),
    checkpoint: () => enqueue(async () => {
      const inspection = await harness.inspect(PI_CONTEXT);
      if (piImageHasLiveTasks(image) || inspection.tasks.some(task => task.record.kind !== 'rat.child') || inspection.submissions.length || state.requiredActions.length) throw new Error('Pi checkpoint requires quiescent root and children');
      const context = await root.context(PI_CONTEXT);
      const agent = await root.agent(PI_CONTEXT);
      return { schema: 1, runtime: structuredClone(pin), model: agent.model!.modelId, reasoning: agent.thinkingLevel === 'off' ? null : agent.thinkingLevel,
        messages: structuredClone([...context.messages]), history: structuredClone(state.turns.filter(binding => binding.threadId === state.rootThreadId).map(binding => ({ ...binding, turn: { ...binding.turn, usage: null } }))) };
    }),
    close: async () => {
      if (!closed) { closed = true; await operations; await harness.close(PI_CONTEXT); }
      await publishing;
    },
  };
}
function agentChange(pin: Extract<RuntimePin, { kind: 'pi' }>, launch: SessionLaunch, settings: SessionModelSettings | undefined, models: Models): AgentChange {
  const agent = { ...launch.agent, ...settings, reasoning: { ...launch.agent.reasoning, ...settings?.reasoning } };
  validateRuntimeAgent(pin, agent);
  const model = models.getModel('amazon-bedrock', agent.model);
  if (!model || model.api !== 'bedrock-converse-stream') throw new Error('Pinned Pi Bedrock model is unavailable');
  const effort = agent.reasoning.effort;
  const thinkingLevel: ModelThinkingLevel = effort === null || effort === 'none' ? 'off' : effort as ModelThinkingLevel;
  return { model: { provider: 'amazon-bedrock', modelId: agent.model }, thinkingLevel, instructions: agent.instructions };
}
function assertInput(pin: Extract<RuntimePin, { kind: 'pi' }>, model: string, input: readonly AgentSessionInputMessageParam[]): void {
  if (!piModel(pin, model).input.includes('image') && input.some(message => message.content.some(part => part.type === 'input_image'))) throw new Error('Pi model does not support image input');
}

function forkItem(item: AgentSessionItem): AgentSessionItem {
  if (item.id === null) return item;
  if ('call_id' in item) return { ...item, id: `pi_fork_${item.id}`, call_id: `pi_fork_${item.call_id}` };
  return { ...item, id: `pi_fork_${item.id}` };
}
