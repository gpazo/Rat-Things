import type { AgentDriverName, RunRequest } from '../domain/contracts.js';
import { runCodexAppServer } from './codex-app-server.js';
import type {
  CodexAppServerEvent,
  CodexAppServerInitiatedRequest,
  CodexTurnController,
} from './codex-app-server.js';
import { codexAuthMode, codexModelProvider } from './codex-auth.js';
import { AGENT_ARTIFACT_DIRECTORY, artifactPrompt } from './artifacts.js';

export interface AgentExecution {
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
    const authMode = codexAuthMode();
    const capabilities = request.agent?.capabilities;
    const networkAccess = capabilities?.networkAccess ?? process.env.CODEX_TOOL_NETWORK_ACCESS === 'true';
    const requestedSandbox = request.agent?.sandbox ?? defaultSandboxMode();
    // App Server's dangerFullAccess policy has no separate network toggle.
    // Honor an explicit network narrowing by selecting the strongest policy
    // that can actually enforce networkAccess=false.
    const sandbox = !networkAccess && requestedSandbox === 'danger-full-access'
      ? 'workspace-write'
      : requestedSandbox;
    const persistentSession = process.env.PERSISTENT_SESSION === 'true';
    const resumeThreadId = process.env.AGENT_THREAD_ID;
    if (resumeThreadId && !persistentSession) {
      throw new Error('Codex thread resume requires a persistent MicroVM session');
    }
    const model = request.agent?.model ?? (
      authMode === 'chatgpt' ? process.env.CODEX_CHATGPT_MODEL : process.env.DEFAULT_MODEL
    );
    const identity = agentIdentity();
    const execution = await runCodexAppServer({
      binary: process.env.CODEX_BINARY ?? 'codex',
      ...(authMode === 'chatgpt'
        ? { binaryArguments: ['-c', 'cli_auth_credentials_store=file', 'app-server'] }
        : {}),
      workspace,
      environment: agentEnvironment(workspace),
      ...(identity ? { identity } : {}),
      timeoutMs,
      ...(signal ? { signal } : {}),
      prompt: artifactPrompt(request.prompt),
      sandbox,
      persistent: persistentSession,
      modelProvider: codexModelProvider(authMode),
      ...(model ? { model } : {}),
      ...(request.agent?.reasoningEffort ? { reasoningEffort: request.agent.reasoningEffort } : {}),
      ...(request.agent?.reasoningSummary ? { reasoningSummary: request.agent.reasoningSummary } : {}),
      ...(request.agent?.personality ? { personality: request.agent.personality } : {}),
      ...(request.agent?.outputSchema ? { outputSchema: request.agent.outputSchema } : {}),
      ...(resumeThreadId ? { resumeThreadId } : {}),
      networkAccess,
      ...(capabilities?.webSearch ? { webSearch: capabilities.webSearch } : {}),
      ...(capabilities?.skills ? { skills: capabilities.skills } : {}),
      ...(capabilities?.apps ? { apps: capabilities.apps } : {}),
      ...(capabilities?.mcpServers ? { mcpServers: capabilities.mcpServers } : {}),
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

function agentEnvironment(workspace: string): NodeJS.ProcessEnv {
  const authMode = codexAuthMode();
  const allowed = new Set([
    'PATH',
    'HOME',
    'CODEX_HOME',
    'LANG',
    'LC_ALL',
    'TMPDIR',
    'AWS_REGION',
    'AWS_DEFAULT_REGION',
    'AWS_EC2_METADATA_DISABLED',
    'AWS_STS_REGIONAL_ENDPOINTS',
  ]);
  if (authMode === 'bedrock') allowed.add('AWS_BEARER_TOKEN_BEDROCK');
  if (process.env.ALLOW_AGENT_AWS_CREDENTIAL_CHAIN === 'true') {
    for (const name of [
      'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
      'AWS_CONTAINER_CREDENTIALS_FULL_URI',
      'AWS_CONTAINER_AUTHORIZATION_TOKEN',
      'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
      'AWS_WEB_IDENTITY_TOKEN_FILE',
      'AWS_ROLE_ARN',
      'AWS_ROLE_SESSION_NAME',
      'AWS_PROFILE',
      'AWS_SHARED_CREDENTIALS_FILE',
      'AWS_CONFIG_FILE',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
    ]) allowed.add(name);
  }
  for (const name of (process.env.AGENT_PASSTHROUGH_ENV ?? '').split(',')) {
    if (name.trim()) allowed.add(name.trim());
  }
  return {
    ...Object.fromEntries(
    [...allowed]
      .map((name) => [name, process.env[name]] as const)
      .filter((entry): entry is readonly [string, string] => entry[1] !== undefined),
    ),
    RAT_THINGS_ARTIFACT_DIR: `${workspace}/${AGENT_ARTIFACT_DIRECTORY}`,
  };
}

function agentIdentity(): { uid: number; gid: number } | undefined {
  const rawUid = process.env.RUN_AGENT_UID;
  const rawGid = process.env.RUN_AGENT_GID;
  if (!rawUid && !rawGid) return undefined;
  const uid = Number(rawUid);
  const gid = Number(rawGid);
  if (!Number.isInteger(uid) || uid < 1 || !Number.isInteger(gid) || gid < 1) {
    throw new Error('RUN_AGENT_UID and RUN_AGENT_GID must both be positive integers');
  }
  return { uid, gid };
}

function defaultSandboxMode(): 'read-only' | 'workspace-write' | 'danger-full-access' {
  const value = process.env.DEFAULT_SANDBOX_MODE ?? 'read-only';
  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(value)) {
    throw new Error('DEFAULT_SANDBOX_MODE is invalid');
  }
  return value as 'read-only' | 'workspace-write' | 'danger-full-access';
}
