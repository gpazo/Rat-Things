import { chown, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentDriverName, RunRequest } from '../domain/contracts.js';
import { codexAuthMode, codexModelProvider } from './codex-auth.js';
import { runProcess } from './process.js';

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
    if (toolNetworkAccess && sandbox !== 'workspace-write') {
      throw new Error('Codex tool network access requires the workspace-write sandbox');
    }
    const args = [
      '--ask-for-approval',
      'never',
      '--config',
      `model_provider=${JSON.stringify(codexModelProvider(authMode))}`,
      ...(toolNetworkAccess
        ? ['--config', 'sandbox_workspace_write.network_access=true']
        : []),
      'exec',
      '--ephemeral',
      '--json',
      '--sandbox',
      sandbox,
      '--skip-git-repo-check',
      '--cd',
      workspace,
    ];
    const model = request.agent?.model ?? (
      authMode === 'chatgpt' ? process.env.CODEX_CHATGPT_MODEL : process.env.DEFAULT_MODEL
    );
    if (model) args.push('--model', model);
    if (request.agent?.reasoningEffort) {
      args.push('--config', `model_reasoning_effort=${JSON.stringify(request.agent.reasoningEffort)}`);
    }
    let schemaPath: string | undefined;
    if (request.agent?.outputSchema) {
      schemaPath = join(workspace, '.agent-output-schema.json');
      await writeFile(schemaPath, JSON.stringify(request.agent.outputSchema), { mode: 0o600 });
      const identity = agentIdentity();
      if (identity) await chown(schemaPath, identity.uid, identity.gid);
      args.push('--output-schema', schemaPath);
    }
    args.push(request.prompt);

    let fullText = '';
    let threadId: string | undefined;
    let usage: AgentExecution['usage'];
    const lines: string[] = [];
    let result: Awaited<ReturnType<typeof runProcess>>;
    try {
      result = await runProcess(process.env.CODEX_BINARY ?? 'codex', args, {
        cwd: workspace,
        env: agentEnvironment(),
        ...agentIdentity(),
        timeoutMs,
        ...(signal ? { signal } : {}),
        onStdoutLine: (line) => {
          if (!line) return;
          lines.push(line);
          try {
            const event = JSON.parse(line) as Record<string, unknown>;
            if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
              threadId = event.thread_id;
            }
            if (event.type === 'item.completed') {
              const item = isRecord(event.item) ? event.item : undefined;
              if (item?.type === 'agent_message' && typeof item.text === 'string') fullText = item.text;
            }
            if (event.type === 'turn.completed' && isRecord(event.usage)) {
              usage = tokenUsage(event.usage);
            }
          } catch {
            // --json is a protocol boundary. Diagnostic text must not masquerade as an answer.
          }
        },
      });
    } finally {
      if (schemaPath) await unlink(schemaPath).catch(() => undefined);
    }
    if (!fullText) {
      throw new Error(`Codex completed without an agent message (exit ${result.exitCode})`);
    }
    if (result.exitCode !== 0) {
      throw new Error(`Codex exited with ${result.exitCode}: ${result.stderr.toString('utf8').slice(-1_000)}`);
    }
    const execution: AgentExecution = {
      fullText,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      events: Buffer.from(`${lines.join('\n')}\n`),
    };
    if (threadId) execution.threadId = threadId;
    if (usage) execution.usage = usage;
    return execution;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tokenUsage(value: Record<string, unknown>): NonNullable<AgentExecution['usage']> {
  const output: NonNullable<AgentExecution['usage']> = {};
  assignNumber(output, 'inputTokens', value.input_tokens);
  assignNumber(output, 'cachedInputTokens', value.cached_input_tokens);
  assignNumber(output, 'outputTokens', value.output_tokens);
  assignNumber(output, 'reasoningOutputTokens', value.reasoning_output_tokens);
  return output;
}

function assignNumber(
  target: Record<string, number | undefined>,
  key: string,
  value: unknown,
): void {
  if (typeof value === 'number' && Number.isFinite(value)) target[key] = value;
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
