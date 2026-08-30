import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type {
  AgentPersonality,
  ReasoningSummary,
  WebSearchMode,
} from '../domain/capabilities.js';
import type { SandboxMode } from '../domain/contracts.js';
import { emitMetric } from '../core/metrics.js';

const CODEX_INVALID_REQUEST = -32600;
const MISSING_ROLLOUT_MESSAGE = 'no rollout found for thread id ';

export class CodexAppServerRequestError extends Error {
  readonly code: number | undefined;
  readonly data: unknown;

  constructor(message: string, code?: number, data?: unknown) {
    super(message);
    this.name = 'CodexAppServerRequestError';
    this.code = code;
    this.data = data;
  }
}

export interface CodexAppServerEvent {
  method: string;
  params: Record<string, unknown>;
  requestId?: string | number;
}

export interface CodexAppServerInitiatedRequest extends CodexAppServerEvent {
  requestId: string | number;
}

export interface CodexTurnController {
  threadId: string;
  turnId: string;
  steer(text: string): Promise<void>;
  interrupt(): Promise<void>;
}

export interface CodexAppServerRequest {
  binary: string;
  binaryArguments?: string[];
  workspace: string;
  environment: NodeJS.ProcessEnv;
  identity?: { uid: number; gid: number };
  timeoutMs: number;
  signal?: AbortSignal;
  prompt: string;
  sandbox: SandboxMode;
  persistent: boolean;
  modelProvider: string;
  model?: string;
  reasoningEffort?: string;
  reasoningSummary?: ReasoningSummary;
  personality?: AgentPersonality;
  outputSchema?: Record<string, unknown>;
  resumeThreadId?: string;
  networkAccess: boolean;
  webSearch?: WebSearchMode;
  skills?: string[];
  apps?: string[];
  mcpServers?: string[];
  dynamicTools?: Array<Record<string, unknown>>;
  onEvent?: (event: CodexAppServerEvent) => void | Promise<void>;
  onServerRequest?: (
    request: CodexAppServerInitiatedRequest,
  ) => unknown | Promise<unknown>;
  onTurnStarted?: (controller: CodexTurnController) => void | Promise<void>;
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
  const child = spawn(request.binary, request.binaryArguments ?? ['app-server'], {
    cwd: request.workspace,
    env: request.environment,
    ...request.identity,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines: string[] = [];
  const stderr: Buffer[] = [];
  const pending = new Map<number, PendingRequest>();
  const callbackTasks = new Set<Promise<void>>();
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
    const event: CodexAppServerEvent = {
      method: message.method,
      params,
      ...(typeof message.id === 'string' || typeof message.id === 'number'
        ? { requestId: message.id }
        : {}),
    };
    if (request.onEvent) trackCallback(Promise.resolve(request.onEvent(event)));
    if (message.id !== undefined) {
      if (typeof message.id !== 'string' && typeof message.id !== 'number') return;
      if (message.method === 'currentTime/read') {
        write({ id: message.id, result: { currentTimeAt: Math.floor(Date.now() / 1_000) } });
        return;
      }
      if (!request.onServerRequest) {
        write({ id: message.id, error: { code: -32601, message: `unsupported server request: ${message.method}` } });
        return;
      }
      const initiated: CodexAppServerInitiatedRequest = { ...event, requestId: message.id };
      trackCallback(
        Promise.resolve(request.onServerRequest(initiated)).then(
          (result) => { write({ id: message.id as string | number, result }); },
          (error: unknown) => {
            write({
              id: message.id as string | number,
              error: {
                code: -32000,
                message: error instanceof Error ? error.message : String(error),
              },
            });
          },
        ),
      );
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

  function trackCallback(task: Promise<unknown>): void {
    const tracked = task.then(() => undefined).catch((error: unknown) => {
      fail(error instanceof Error ? error : new Error(String(error)));
    }).finally(() => {
      callbackTasks.delete(tracked);
    });
    callbackTasks.add(tracked);
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
      capabilities: {
        experimentalApi: Boolean(request.dynamicTools?.length),
        requestAttestation: false,
      },
    });
    notify('initialized');

    const skillInputs = request.skills?.length
      ? await resolveSkillInputs(call, request.workspace, request.skills)
      : [];

    const threadParams: Record<string, unknown> = {
      cwd: request.workspace,
      // The outer MicroVM/IAM/grant envelope is the authorization boundary.
      // Never ask for a mid-Run human authorization decision.
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandbox: request.sandbox,
      modelProvider: request.modelProvider,
      ...(request.model ? { model: request.model } : {}),
      ...(request.personality ? { personality: request.personality } : {}),
      ...appServerConfig(request),
    };
    const startThreadParams = {
      ...threadParams,
      ...(request.dynamicTools ? { dynamicTools: request.dynamicTools } : {}),
    };
    let threadResult: unknown;
    if (request.resumeThreadId) {
      try {
        threadResult = await call('thread/resume', {
          ...threadParams,
          threadId: request.resumeThreadId,
        });
      } catch (error) {
        if (!isMissingCodexThread(error)) throw error;
        // Durable Rat Things replay remains available when Codex has no native
        // checkpoint for the requested thread. Other resume failures surface.
        emitMetric('runner', 'CodexThreadResumeFallback', 1, 'Count');
        threadResult = await call('thread/start', {
          ...startThreadParams,
          ephemeral: !request.persistent,
          serviceName: 'rat-things',
        });
      }
    } else {
      threadResult = await call('thread/start', {
        ...startThreadParams,
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
      input: [
        {
          type: 'text',
          text: skillInputs.length > 0
            ? `${skillInputs.map((skill) => `$${skill.name}`).join(' ')}\n\n${request.prompt}`
            : request.prompt,
        },
        ...skillInputs,
      ],
      cwd: request.workspace,
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandboxPolicy: sandboxPolicyFor(request.sandbox, request.workspace, request.networkAccess),
      ...(request.model ? { model: request.model } : {}),
      ...(request.reasoningEffort ? { effort: request.reasoningEffort } : {}),
      ...(request.reasoningSummary ? { summary: request.reasoningSummary } : {}),
      ...(request.personality ? { personality: request.personality } : {}),
      ...(request.outputSchema ? { outputSchema: request.outputSchema } : {}),
    });
    const turn = isRecord(turnResult) && isRecord(turnResult.turn) ? turnResult.turn : undefined;
    if (!turn || typeof turn.id !== 'string') {
      throw new Error('Codex app-server returned no turn ID');
    }
    expectedTurnId = turn.id;
    if (request.onTurnStarted) {
      await request.onTurnStarted({
        threadId: thread.id,
        turnId: turn.id,
        steer: async (text: string) => {
          if (!text.trim()) throw new Error('steer text is required');
          await call('turn/steer', {
            threadId: thread.id,
            expectedTurnId: turn.id,
            input: [{ type: 'text', text }],
          });
        },
        interrupt: async () => {
          await call('turn/interrupt', { threadId: thread.id, turnId: turn.id });
        },
      });
    }
    await turnCompleted;
    if (callbackTasks.size > 0) await Promise.all(callbackTasks);
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

export function sandboxPolicyFor(
  sandbox: SandboxMode,
  workspace: string,
  networkAccess: boolean,
): Record<string, unknown> {
  switch (sandbox) {
    case 'danger-full-access':
      return { type: 'dangerFullAccess' };
    case 'read-only':
      return { type: 'readOnly', networkAccess };
    case 'workspace-write':
      return {
        type: 'workspaceWrite',
        writableRoots: [workspace],
        networkAccess,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
  }
}

function appServerConfig(request: CodexAppServerRequest): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  if (request.onServerRequest) {
    config['features.default_mode_request_user_input'] = true;
  }
  if (request.sandbox === 'workspace-write') {
    config.sandbox_workspace_write = { network_access: request.networkAccess };
  }
  if (request.webSearch) config.web_search = request.webSearch;
  if (request.apps) config.apps = appsConfig(request.apps);
  if (request.mcpServers) {
    config.mcp_servers = Object.fromEntries(request.mcpServers.map((name) => [
      name,
      { enabled: true },
    ]));
  }
  return Object.keys(config).length > 0 ? { config } : {};
}

interface SkillInput {
  type: 'skill';
  name: string;
  path: string;
}

async function resolveSkillInputs(
  call: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  workspace: string,
  requested: string[],
): Promise<SkillInput[]> {
  const response = await call('skills/list', { cwds: [workspace], forceReload: true });
  const data = isRecord(response) && Array.isArray(response.data) ? response.data : undefined;
  if (!data) throw new Error('Codex app-server returned an invalid skills list');
  const skills = data.flatMap((entry) => (
    isRecord(entry) && Array.isArray(entry.skills) ? entry.skills : []
  ));
  return requested.map((name) => {
    const skill = skills.find((candidate) => isRecord(candidate) && candidate.name === name);
    if (!isRecord(skill) || typeof skill.path !== 'string') {
      throw new Error(`Codex skill ${name} is not installed for this workspace`);
    }
    if (skill.enabled !== true) throw new Error(`Codex skill ${name} is disabled`);
    return { type: 'skill', name, path: skill.path };
  });
}

function appsConfig(apps: string[]): Record<string, unknown> {
  const resolvedReviewer = 'auto_review';
  const result: Record<string, unknown> = {
    _default: {
      enabled: false,
      approvals_reviewer: resolvedReviewer,
      destructive_enabled: false,
      open_world_enabled: false,
      default_tools_approval_mode: 'never',
    },
  };
  for (const app of apps) {
    result[app] = {
      enabled: true,
      approvals_reviewer: resolvedReviewer,
      destructive_enabled: true,
      open_world_enabled: false,
      default_tools_approval_mode: 'never',
      default_tools_enabled: true,
      tools: null,
    };
  }
  return result;
}

function jsonRpcError(value: unknown): Error {
  if (isRecord(value) && typeof value.message === 'string') {
    return new CodexAppServerRequestError(
      value.message,
      typeof value.code === 'number' ? value.code : undefined,
      value.data,
    );
  }
  return new Error(`Codex app-server request failed: ${JSON.stringify(value).slice(0, 1_000)}`);
}

export function isMissingCodexThread(error: unknown): boolean {
  return error instanceof CodexAppServerRequestError
    && error.code === CODEX_INVALID_REQUEST
    && error.message.startsWith(MISSING_ROLLOUT_MESSAGE);
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
