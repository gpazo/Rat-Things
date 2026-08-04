import type { AgentDriverName, RunRequest } from '../domain/contracts.js';
import { runCodexAppServer } from './codex-app-server.js';
import { codexAuthMode, codexModelProvider } from './codex-auth.js';

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
  execute(request: RunRequest, workspace: string, timeoutMs: number, signal?: AbortSignal): Promise<AgentExecution>;
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
  ): Promise<AgentExecution> {
    const authMode = codexAuthMode();
    const sandbox = request.agent?.sandbox ?? 'read-only';
    const toolNetworkAccess = process.env.CODEX_TOOL_NETWORK_ACCESS === 'true';
    const persistentSession = process.env.PERSISTENT_SESSION === 'true';
    const resumeThreadId = process.env.AGENT_THREAD_ID;
    if (resumeThreadId && !persistentSession) {
      throw new Error('Codex thread resume requires a persistent MicroVM session');
    }
    if (toolNetworkAccess && sandbox !== 'workspace-write') {
      throw new Error('Codex tool network access requires the workspace-write sandbox');
    }
    const model = request.agent?.model ?? (
      authMode === 'chatgpt' ? process.env.CODEX_CHATGPT_MODEL : process.env.DEFAULT_MODEL
    );
    const identity = agentIdentity();
    const execution = await runCodexAppServer({
      binary: process.env.CODEX_BINARY ?? 'codex',
      workspace,
      environment: agentEnvironment(),
      ...(identity ? { identity } : {}),
      timeoutMs,
      ...(signal ? { signal } : {}),
      prompt: request.prompt,
      sandbox,
      persistent: persistentSession,
      modelProvider: codexModelProvider(authMode),
      ...(model ? { model } : {}),
      ...(request.agent?.reasoningEffort ? { reasoningEffort: request.agent.reasoningEffort } : {}),
      ...(request.agent?.outputSchema ? { outputSchema: request.agent.outputSchema } : {}),
      ...(resumeThreadId ? { resumeThreadId } : {}),
      toolNetworkAccess,
    });
    return { ...execution, exitCode: 0 };
  }
}

export class MockDriver implements AgentDriver {
  public readonly name = 'mock' as const;

  public async execute(request: RunRequest): Promise<AgentExecution> {
    const fullText = `mock-agent: ${request.prompt}`;
    return {
      fullText,
      exitCode: 0,
      durationMs: 0,
      events: Buffer.from(`${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: fullText } })}\n`),
      threadId: 'mock-thread',
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
}

function agentEnvironment(): NodeJS.ProcessEnv {
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
  return Object.fromEntries(
    [...allowed]
      .map((name) => [name, process.env[name]] as const)
      .filter((entry): entry is readonly [string, string] => entry[1] !== undefined),
  );
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
