import type {
  CodexAppServerEvent,
  CodexAppServerInitiatedRequest,
  CodexTurnController,
} from './codex-app-server.js';
import type { AgentDriverControl } from './agent-driver.js';
import { randomUUID } from 'node:crypto';
import type { IntegrationApprovalRequest } from '../plugins/integration-types.js';
import type { BrowserApprovalRequest } from './browser.js';

const CHANNEL = 'rat-things-agent-control';

interface PendingServerRequest {
  request: CodexAppServerInitiatedRequest;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export interface RunnerControlBridge {
  hooks: AgentDriverControl;
  requestIntegrationApproval(request: IntegrationApprovalRequest): Promise<boolean>;
  requestBrowserApproval(request: BrowserApprovalRequest): Promise<boolean>;
  close(): void;
}

export function createRunnerControlBridge(runId: string): RunnerControlBridge | undefined {
  if (!process.send || !process.connected) return undefined;
  const pending = new Map<string, PendingServerRequest>();
  const sessionApprovals = new Set<string>();
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
          case 'approve': {
            const requestId = requiredRequestId(value.requestId);
            const waiter = pending.get(requestId);
            if (!waiter) throw new Error(`approval request ${requestId} is not pending`);
            const decision = typeof value.decision === 'string' ? value.decision : '';
            const reason = typeof value.reason === 'string' ? value.reason : undefined;
            waiter.resolve(approvalResponseFor(waiter.request.method, decision, reason));
            pending.delete(requestId);
            break;
          }
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
  const customApproval = async (
    method: string,
    key: string,
    params: Record<string, unknown>,
    allowSessionCache = true,
  ): Promise<boolean> => {
    if (allowSessionCache && sessionApprovals.has(key)) return true;
    if (closed || !process.connected) throw new Error('agent control channel is not connected');
    const requestId = `approval-${randomUUID()}`;
    const response = await new Promise<unknown>((resolve, reject) => {
      const initiated: CodexAppServerInitiatedRequest = {
        method,
        requestId,
        params,
      };
      pending.set(requestId, { request: initiated, resolve, reject });
      send({ type: 'server-request', request: initiated });
    });
    const decision = isRecord(response) ? String(response.decision) : '';
    if (allowSessionCache && decision === 'acceptForSession') sessionApprovals.add(key);
    return ['accept', 'acceptForSession'].includes(decision);
  };
  const requestIntegrationApproval = (
    request: IntegrationApprovalRequest,
  ): Promise<boolean> => customApproval(
    'ratThings/integration/requestApproval',
    `integration:${request.connectionId}:${request.operation.id}`,
    {
      connectionId: request.connectionId,
      connectionAlias: request.connectionAlias,
      pluginId: request.pluginId,
      operation: request.operation,
      approval: request.approval,
      input: request.input,
    },
    request.approval !== 'always',
  );
  const requestBrowserApproval = (
    request: BrowserApprovalRequest,
  ): Promise<boolean> => customApproval(
    'ratThings/browser/requestApproval',
    `browser:${request.tool}`,
    { tool: request.tool, command: request.command },
  );
  return { hooks, requestIntegrationApproval, requestBrowserApproval, close };
}

export function approvalResponseFor(method: string, decision: string, reason?: string): unknown {
  if (!['accept', 'accept-for-session', 'decline', 'cancel'].includes(decision)) {
    throw new Error('approval decision is invalid');
  }
  if (
    method === 'item/commandExecution/requestApproval' ||
    method === 'item/fileChange/requestApproval'
  ) {
    return {
      decision: decision === 'accept-for-session' ? 'acceptForSession' : decision,
    };
  }
  if (
    method === 'ratThings/integration/requestApproval' ||
    method === 'ratThings/browser/requestApproval'
  ) {
    return {
      decision: decision === 'accept-for-session' ? 'acceptForSession' : decision,
      ...(reason ? { reason: reason.slice(0, 1_000) } : {}),
    };
  }
  if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
    const legacy = decision === 'accept'
      ? 'approved'
      : decision === 'accept-for-session'
        ? 'approved_for_session'
        : decision === 'cancel'
          ? 'abort'
          : { denied: { rejection: reason?.slice(0, 1_000) ?? 'declined by user' } };
    return { decision: legacy };
  }
  throw new Error(`server request ${method} requires an explicit response, not an approval decision`);
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
