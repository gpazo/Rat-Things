import type {
  CodexAppServerEvent,
  CodexAppServerInitiatedRequest,
  CodexTurnController,
} from './codex-app-server.js';
import type { AgentDriverControl } from './agent-driver.js';
import { canonicalJson } from '../domain/json.js';
import { parseAgentsContract } from '../domain/agents-api-validation.js';

const CHANNEL = 'rat-things-agent-control';

interface PendingServerRequest {
  request: CodexAppServerInitiatedRequest;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export interface RunnerControlBridge {
  hooks: AgentDriverControl;
  setEnvironmentFiles(files: (operation: unknown) => Promise<unknown>): void;
  close(): void;
}

export function createRunnerControlBridge(runId: string): RunnerControlBridge | undefined {
  if (!process.send || !process.connected) return undefined;
  const pending = new Map<string, PendingServerRequest>();
  const operations = new Map<string, { digest: string; promise: Promise<unknown> }>();
  let controller: CodexTurnController | undefined;
  let environmentFiles: ((operation: unknown) => Promise<unknown>) | undefined;
  let closed = false;

  const send = (message: Record<string, unknown>) => {
    if (closed || !process.send || !process.connected) return;
    process.send({ channel: CHANNEL, runId, ...message });
  };
  const commandResult = (commandId: string, result?: unknown, error?: unknown) => {
    send({
      type: 'command-result',
      commandId,
      ok: !error,
      ...(result !== undefined ? { result } : {}),
      ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
    });
  };

  const onMessage = (value: unknown) => {
    if (!isRecord(value) || value.channel !== CHANNEL || value.runId !== runId) return;
    const commandId = typeof value.commandId === 'string' ? value.commandId : undefined;
    if (!commandId || typeof value.type !== 'string') return;
    void (async () => {
      const operationId = typeof value.operationId === 'string' ? value.operationId : value.type === 'respond' ? `response:${String(value.requestId)}` : undefined;
      let resolveOperation: ((value: unknown) => void) | undefined;
      let rejectOperation: ((error: unknown) => void) | undefined;
      try {
        if (operationId) {
          if (operationId.length > 512) throw new Error('control operation ID is too long');
          const { commandId: _commandId, ...command } = value;
          const digest = canonicalJson(command);
          const existing = operations.get(operationId);
          if (existing) {
            if (existing.digest !== digest) throw new Error('control operation ID was reused with different input');
            commandResult(commandId, await existing.promise);
            return;
          }
          if (operations.size >= 10_000) throw new Error('control operation limit reached');
          const promise = new Promise<unknown>((resolve, reject) => { resolveOperation = resolve; rejectOperation = reject; });
          void promise.catch(() => {});
          operations.set(operationId, { digest, promise });
        }
        let result: unknown;
        switch (value.type) {
          case 'environment_files':
            if (!environmentFiles) throw new Error('Environment files are not ready');
            result = environmentFiles(value.operation);
            break;
          case 'session_start': {
            if (!controller?.startSessionTurn) throw new Error('The session harness is not ready');
            const turn = parseAgentsContract('Turn', value.turn);
            const parsed = parseAgentsContract('SessionEvents', { events: [{ type: 'agent.session.input.message', input: value.input }] });
            const input = parsed.events[0];
            if (input?.type !== 'agent.session.input.message') throw new Error('Invalid session input');
            result = controller.startSessionTurn(turn, input.input);
            break;
          }
          case 'steer':
            if (!controller) throw new Error('the Codex turn is not ready for steering');
            if (typeof value.prompt !== 'string' || !value.prompt.trim()) {
              throw new Error('steer prompt is required');
            }
            await controller.steer(value.prompt, value.input === undefined ? undefined : parseAgentsContract('SessionEvents', { events: [{ type: 'agent.session.input.message', input: value.input }] }).events.flatMap((event) => event.type === 'agent.session.input.message' ? event.input : []), requiredRequestId(value.turnId));
            break;
          case 'interrupt':
            if (!controller) throw new Error('the Codex turn is not ready for interruption');
            await controller.interrupt(requiredRequestId(value.turnId));
            break;
          case 'session_items':
            if (!controller?.sessionItems) throw new Error('Session history is not available');
            result = controller.sessionItems();
            break;
          case 'respond': {
            const requestId = requiredRequestId(value.requestId);
            const waiter = pending.get(requestId);
            if (!waiter) throw new Error(`server request ${requestId} is not pending`);
            waiter.resolve(value.result);
            pending.delete(requestId);
            break;
          }
          default:
            throw new Error(`unsupported control command ${value.type}`);
        }
        result = await result;
        resolveOperation?.(result);
        commandResult(commandId, result);
      } catch (error) {
        rejectOperation?.(error);
        if (operationId && rejectOperation) operations.delete(operationId);
        commandResult(commandId, undefined, error);
      }
    })();
  };

  const close = () => {
    if (closed) return;
    closed = true;
    process.removeListener('message', onMessage);
    process.removeListener('disconnect', close);
    for (const waiter of pending.values()) {
      waiter.reject(new Error('agent control channel closed before the request was answered'));
    }
    pending.clear();
    operations.clear();
    controller = undefined;
  };
  process.on('message', onMessage);
  process.once('disconnect', close);

  const hooks: AgentDriverControl = {
    onEvent: (event: CodexAppServerEvent) => {
      send({ type: 'event', event });
    },
    onServerRequest: (request: CodexAppServerInitiatedRequest) => new Promise((resolve, reject) => {
      const requestId = String(request.requestId);
      if (isApprovalRequest(request.method)) {
        reject(new Error(
          'interactive approvals are disabled; capabilities must be admitted before MicroVM launch',
        ));
        return;
      }
      if (pending.has(requestId)) {
        reject(new Error(`duplicate app-server request ${requestId}`));
        return;
      }
      pending.set(requestId, { request, resolve, reject });
      send({ type: 'server-request', request: { ...request, requestId } });
    }),
    onTurnStarted: (next: CodexTurnController) => {
      controller = next;
      send({
        type: 'turn-ready',
        turn: { threadId: next.threadId, turnId: next.turnId },
        session: Boolean(next.sessionItems),
      });
    },
  };
  return {
    hooks,
    setEnvironmentFiles: (files) => { environmentFiles = files; },
    close,
  };
}

export function isApprovalRequest(method: string): boolean {
  return [
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'execCommandApproval',
    'applyPatchApproval',
  ].includes(method);
}

function requiredRequestId(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 256) {
    throw new Error('request ID is invalid');
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
