import type {
  CodexAppServerEvent,
  CodexAppServerInitiatedRequest,
  CodexTurnController,
} from './codex-app-server.js';
import type { AgentDriverControl } from './agent-driver.js';
import type { HumanBrowserAction } from '../domain/interaction.js';
import type { BrowserToolSession } from './browser.js';

const CHANNEL = 'rat-things-agent-control';

interface PendingServerRequest {
  request: CodexAppServerInitiatedRequest;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export interface RunnerControlBridge {
  hooks: AgentDriverControl;
  setBrowserSession(session: BrowserToolSession): void;
  close(): void;
}

export function createRunnerControlBridge(runId: string): RunnerControlBridge | undefined {
  if (!process.send || !process.connected) return undefined;
  const pending = new Map<string, PendingServerRequest>();
  let controller: CodexTurnController | undefined;
  let browser: BrowserToolSession | undefined;
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
      try {
        let result: unknown;
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
          case 'computer_snapshot':
            result = requiredBrowser(browser).computer(runId);
            break;
          case 'computer_takeover_start':
            result = requiredBrowser(browser).takeComputer(runId);
            break;
          case 'computer_takeover_stop':
            result = requiredBrowser(browser).returnComputer(runId);
            break;
          case 'computer_action':
            if (!isRecord(value.action) || typeof value.action.type !== 'string') {
              throw new Error('browser action is invalid');
            }
            result = requiredBrowser(browser).actOnComputer(
              runId,
              value.action as HumanBrowserAction,
            );
            break;
          case 'teach_start':
            result = requiredBrowser(browser).startTeaching(runId, {
              name: requiredText(value.name, 'demonstration name', 120),
              ...(value.goal === undefined
                ? {}
                : { goal: requiredText(value.goal, 'demonstration goal', 4_000) }),
            });
            break;
          case 'teach_stop':
            if (typeof value.discard !== 'boolean') {
              throw new Error('demonstration discard must be boolean');
            }
            result = requiredBrowser(browser).stopTeaching(value.discard);
            break;
          default:
            throw new Error(`unsupported control command ${value.type}`);
        }
        commandResult(commandId, await result);
      } catch (error) {
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
    controller = undefined;
    browser = undefined;
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
  return {
    hooks,
    setBrowserSession: (session) => {
      if (closed) throw new Error('agent control channel is closed');
      browser = session;
    },
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

function requiredBrowser(browser: BrowserToolSession | undefined): BrowserToolSession {
  if (!browser) throw new Error('this Run does not have browser computer use enabled');
  return browser;
}

function requiredText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
