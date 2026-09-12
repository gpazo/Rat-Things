import type { AgentDriverName, RunRequest } from '../domain/contracts.js';
import { runCodexAppServer } from './codex-app-server.js';
import type {
  CodexAppServerEvent,
  CodexAppServerInitiatedRequest,
  CodexTurnController,
} from './codex-app-server.js';
import { planCodexLaunch } from './agent-planning.js';

export interface AgentExecution {
  outcome?: 'completed' | 'interrupted' | 'failed';
  fullText: string;
  exitCode: number;
  durationMs: number;
  events: Buffer;
  threadId?: string;
  usage?: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    reasoningOutputTokens?: number;
  };
}

export interface AgentDriver {
  readonly name: AgentDriverName;
  execute(
    request: RunRequest,
    workspace: string,
    timeoutMs: number,
    signal?: AbortSignal,
    control?: AgentDriverControl,
  ): Promise<AgentExecution>;
}

export interface AgentDriverControl {
  dynamicTools?: Array<Record<string, unknown>>;
  onEvent?(event: CodexAppServerEvent): void | Promise<void>;
  onServerRequest?(request: CodexAppServerInitiatedRequest): unknown | Promise<unknown>;
  onTurnStarted?(controller: CodexTurnController): void | Promise<void>;
}

export function driverFor(name: AgentDriverName): AgentDriver {
  switch (name) {
    case 'codex':
      return new CodexDriver();
    case 'mock':
      return new MockDriver();
  }
}

export class CodexDriver implements AgentDriver {
  public readonly name = 'codex' as const;

  public async execute(
    request: RunRequest,
    workspace: string,
    timeoutMs: number,
    signal?: AbortSignal,
    control?: AgentDriverControl,
  ): Promise<AgentExecution> {
    const plan = planCodexLaunch(request, workspace, timeoutMs, process.env);
    const execution = await runCodexAppServer({
      ...plan,
      ...(signal ? { signal } : {}),
      ...(control?.onEvent ? { onEvent: control.onEvent } : {}),
      ...(control?.onServerRequest ? { onServerRequest: control.onServerRequest } : {}),
      ...(control?.onTurnStarted ? { onTurnStarted: control.onTurnStarted } : {}),
      ...(control?.dynamicTools ? { dynamicTools: control.dynamicTools } : {}),
    });
    return { ...execution, exitCode: 0 };
  }
}

export class MockDriver implements AgentDriver {
  public readonly name = 'mock' as const;

  public async execute(
    request: RunRequest,
    _workspace?: string,
    _timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<AgentExecution> {
    const startedAt = Date.now();
    const delayMs = mockDelayMs(request.metadata?.mockDelayMs);
    if (delayMs > 0) await abortableMockDelay(delayMs, signal);
    const fullText = `mock-agent: ${request.prompt}`;
    return {
      fullText,
      exitCode: 0,
      durationMs: Date.now() - startedAt,
      events: Buffer.from(`${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: fullText } })}\n`),
      threadId: 'mock-thread',
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
}

function mockDelayMs(value: unknown): number {
  if (value === undefined) return 0;
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 180_000) {
    throw new Error('mockDelayMs must be a whole number from 0 through 180000');
  }
  return Number(value);
}

async function abortableMockDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error('mock execution was cancelled');
  await new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(done, milliseconds);
    const abort = () => done(new Error('mock execution was cancelled'));
    function done(error?: Error) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolvePromise();
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}
