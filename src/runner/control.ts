import type {
  CodexAppServerEvent,
  CodexAppServerInitiatedRequest,
  CodexTurnController,
} from './codex-app-server.js';
import type { AgentDriverControl } from './agent-driver.js';

const CHANNEL = 'rat-things-agent-control';

interface PendingServerRequest {
  request: CodexAppServerInitiatedRequest;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export interface RunnerControlBridge {
  hooks: AgentDriverControl;
  close(): void;
}

export function createRunnerControlBridge(runId: string): RunnerControlBridge | undefined {
  if (!process.send || !process.connected) return undefined;
  const pending = new Map<string, PendingServerRequest>();
  let controller: CodexTurnController | undefined;
  let closed = false;

  const send = (message: Record<string, unknown>) => {
    if (closed || !process.send || !process.connected) return;
    process.send({ channel: CHANNEL, runId, ...message });
  };
  const commandResult = (commandId: string, error?: unknown) => {
    send({
      type: 'command-result',
      commandId,
      ok: !error,
      ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
    });
  };

  const onMessage = (value: unknown) => {
    if (!isRecord(value) || value.channel !== CHANNEL || value.runId !== runId) return;
    const commandId = typeof value.commandId === 'string' ? value.commandId : undefined;
    if (!commandId || typeof value.type !== 'string') return;
    void (async () => {
      try {
        switch (value.type) {
          case 'steer':
            if (!controller) throw new Error('the Codex turn is not ready for steering');
            if (typeof value.prompt !== 'string' || !value.prompt.trim()) {
              throw new Error('steer prompt is required');
            }
            await controller.steer(value.prompt);
            break;
          case 'interrupt':
            if (!controller) throw new Error('the Codex turn is not ready for interruption');
            await controller.interrupt();
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
        commandResult(commandId);
      } catch (error) {
        commandResult(commandId, error);
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
      });
    },
  };
  return { hooks, close };
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
