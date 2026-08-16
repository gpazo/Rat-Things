import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface CodexAppServerRequest {
  binary: string;
  workspace: string;
  environment: NodeJS.ProcessEnv;
  identity?: { uid: number; gid: number };
  timeoutMs: number;
  signal?: AbortSignal;
  prompt: string;
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
  persistent: boolean;
  modelProvider: string;
  model?: string;
  reasoningEffort?: string;
  outputSchema?: Record<string, unknown>;
  resumeThreadId?: string;
  toolNetworkAccess: boolean;
}

export interface CodexAppServerExecution {
  fullText: string;
  durationMs: number;
  events: Buffer;
  threadId: string;
  usage?: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    reasoningOutputTokens?: number;
  };
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export async function runCodexAppServer(
  request: CodexAppServerRequest,
): Promise<CodexAppServerExecution> {
  const started = Date.now();
  const child = spawn(request.binary, ['app-server'], {
    cwd: request.workspace,
    env: request.environment,
    ...request.identity,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines: string[] = [];
  const stderr: Buffer[] = [];
  const pending = new Map<number, PendingRequest>();
  let nextRequestId = 0;
  let fullText = '';
  let usage: CodexAppServerExecution['usage'];
  let expectedThreadId: string | undefined;
  let expectedTurnId: string | undefined;
  let turnCompleteResolve: (() => void) | undefined;
  let turnCompleteReject: ((error: Error) => void) | undefined;
  let settled = false;

  const turnCompleted = new Promise<void>((resolve, reject) => {
    turnCompleteResolve = resolve;
    turnCompleteReject = reject;
  });
  const fail = (error: Error) => {
    if (settled) return;
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
    turnCompleteReject?.(error);
  };
  const timeout = setTimeout(() => {
    fail(new Error(`Codex app-server timed out after ${request.timeoutMs}ms`));
    child.kill('SIGTERM');
  }, request.timeoutMs);
  const abort = () => {
    fail(new Error('Codex app-server execution was cancelled'));
    child.kill('SIGTERM');
  };
  request.signal?.addEventListener('abort', abort, { once: true });

  child.stderr.on('data', (chunk: Buffer) => {
    stderr.push(chunk);
    while (stderr.reduce((total, part) => total + part.length, 0) > 32_768) stderr.shift();
  });
  child.once('error', (error) => fail(new Error(`Codex app-server failed to start: ${error.message}`)));
  child.once('exit', (code, signal) => {
    if (settled) return;
    const diagnostic = Buffer.concat(stderr).toString('utf8').trim().slice(-2_000);
    fail(new Error(
      `Codex app-server exited before turn completion (${code ?? signal ?? 'unknown'}): ${diagnostic || 'no diagnostic output'}`,
    ));
  });

  const output = createInterface({ input: child.stdout });
  output.on('line', (line) => {
    if (!line) return;
    lines.push(line);
    let message: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isRecord(parsed)) return;
      message = parsed;
    } catch {
      return;
    }

    if (typeof message.id === 'number' && (message.result !== undefined || message.error !== undefined)) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error !== undefined) waiter.reject(jsonRpcError(message.error));
      else waiter.resolve(message.result);
      return;
    }

    if (typeof message.method !== 'string') return;
    const params = isRecord(message.params) ? message.params : {};
    if (message.id !== undefined) {
      write({ id: message.id, error: { code: -32601, message: `unsupported server request: ${message.method}` } });
      return;
    }
    if (message.method === 'item/completed') {
      const item = isRecord(params.item) ? params.item : undefined;
      if (item?.type === 'agentMessage' && typeof item.text === 'string') fullText = item.text;
      return;
    }
    if (message.method === 'thread/tokenUsage/updated') {
      const tokenUsage = isRecord(params.tokenUsage) ? params.tokenUsage : undefined;
      const last = isRecord(tokenUsage?.last) ? tokenUsage.last : undefined;
      if (last) usage = tokenUsageBreakdown(last);
      return;
    }
    if (message.method === 'error') {
      const error = terminalNotificationError(params);
      if (error) turnCompleteReject?.(error);
      return;
    }
    if (message.method === 'turn/completed') {
      const turn = isRecord(params.turn) ? params.turn : undefined;
      if (!turn || params.threadId !== expectedThreadId || turn.id !== expectedTurnId) return;
      if (turn.status !== 'completed') {
        turnCompleteReject?.(new Error(`Codex turn ended with status ${String(turn.status ?? 'unknown')}`));
      } else {
        turnCompleteResolve?.();
      }
    }
  });

  function write(message: Record<string, unknown>): void {
    if (!child.stdin.writable) throw new Error('Codex app-server stdin is not writable');
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function notify(method: string, params?: Record<string, unknown>): void {
    write({ method, ...(params ? { params } : {}) });
  }

  function call(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = nextRequestId;
    nextRequestId += 1;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      write({ id, method, params });
    });
  }

  try {
    await call('initialize', {
      clientInfo: {
        name: 'rat-things',
        title: 'Rat Things Agent Runtime',
        version: process.env.npm_package_version ?? '0.1.0',
      },
    });
    notify('initialized');

    const threadParams: Record<string, unknown> = {
      cwd: request.workspace,
      approvalPolicy: 'never',
      sandbox: request.sandbox,
      modelProvider: request.modelProvider,
      ...(request.model ? { model: request.model } : {}),
      ...(request.toolNetworkAccess ? {
        config: { sandbox_workspace_write: { network_access: true } },
      } : {}),
    };
    let threadResult: unknown;
    if (request.resumeThreadId) {
      try {
        threadResult = await call('thread/resume', {
          ...threadParams,
          threadId: request.resumeThreadId,
        });
      } catch (error) {
        // The durable Rat Things replay in the prompt is authoritative. If a
        // native Codex checkpoint is incompatible or absent, start a successor
        // thread without losing the normalized conversation history.
        threadResult = await call('thread/start', {
          ...threadParams,
          ephemeral: !request.persistent,
          serviceName: 'rat-things',
        });
      }
    } else {
      threadResult = await call('thread/start', {
        ...threadParams,
        ephemeral: !request.persistent,
        serviceName: 'rat-things',
      });
    }
    const thread = isRecord(threadResult) && isRecord(threadResult.thread)
      ? threadResult.thread
      : undefined;
    if (!thread || typeof thread.id !== 'string') {
      throw new Error('Codex app-server returned no thread ID');
    }
    expectedThreadId = thread.id;

    const turnResult = await call('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: request.prompt }],
      cwd: request.workspace,
      ...(request.model ? { model: request.model } : {}),
      ...(request.reasoningEffort ? { effort: request.reasoningEffort } : {}),
      ...(request.outputSchema ? { outputSchema: request.outputSchema } : {}),
    });
    const turn = isRecord(turnResult) && isRecord(turnResult.turn) ? turnResult.turn : undefined;
    if (!turn || typeof turn.id !== 'string') {
      throw new Error('Codex app-server returned no turn ID');
    }
    expectedTurnId = turn.id;
    await turnCompleted;
    if (!fullText) throw new Error('Codex completed without an agent message');
    settled = true;
    return {
      fullText,
      durationMs: Date.now() - started,
      events: Buffer.from(`${lines.join('\n')}\n`),
      threadId: thread.id,
      ...(usage ? { usage } : {}),
    };
  } finally {
    settled = true;
    clearTimeout(timeout);
    request.signal?.removeEventListener('abort', abort);
    output.close();
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
}

function jsonRpcError(value: unknown): Error {
  if (isRecord(value) && typeof value.message === 'string') return new Error(value.message);
  return new Error(`Codex app-server request failed: ${JSON.stringify(value).slice(0, 1_000)}`);
}

export function terminalNotificationError(params: Record<string, unknown>): Error | undefined {
  // Codex emits error notifications for transient stream interruptions while
  // app-server reconnects on its own. Per the v2 protocol, willRetry means the
  // notification does not interrupt the active turn.
  if (params.willRetry === true) return undefined;
  const error = isRecord(params.error) ? params.error : params;
  if (typeof error.message === 'string') return new Error(error.message);
  return new Error(`Codex app-server error: ${JSON.stringify(params).slice(0, 1_000)}`);
}

function tokenUsageBreakdown(
  value: Record<string, unknown>,
): NonNullable<CodexAppServerExecution['usage']> {
  const usage: NonNullable<CodexAppServerExecution['usage']> = {};
  assignNumber(usage, 'inputTokens', value.inputTokens);
  assignNumber(usage, 'cachedInputTokens', value.cachedInputTokens);
  assignNumber(usage, 'outputTokens', value.outputTokens);
  assignNumber(usage, 'reasoningOutputTokens', value.reasoningOutputTokens);
  return usage;
}

function assignNumber(
  target: Record<string, number | undefined>,
  key: string,
  value: unknown,
): void {
  if (typeof value === 'number' && Number.isFinite(value)) target[key] = value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
