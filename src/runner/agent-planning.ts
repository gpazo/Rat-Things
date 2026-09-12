import type { RunRequest } from '../domain/contracts.js';
import type { CodexAppServerRequest } from './codex-app-server.js';
import { codexAuthMode, codexModelProvider } from './codex-auth.js';
import { AGENT_ARTIFACT_DIRECTORY, artifactPromptText } from './artifact-planning.js';
import { agentProcessIdentity } from './agent-identity.js';

export type CodexLaunchPlan = Omit<
  CodexAppServerRequest,
  'signal' | 'onEvent' | 'onServerRequest' | 'onTurnStarted' | 'dynamicTools'
>;

/** Resolves launch policy and child environment from explicit deployment values. */
export function planCodexLaunch(
  request: RunRequest,
  workspace: string,
  timeoutMs: number,
  environment: Readonly<NodeJS.ProcessEnv>,
): CodexLaunchPlan {
  const authMode = codexAuthMode(environment);
  const capabilities = request.agent?.capabilities;
  const networkAccess = capabilities?.networkAccess ?? environment.CODEX_TOOL_NETWORK_ACCESS === 'true';
  const requestedSandbox = request.agent?.sandbox ?? defaultSandboxMode(environment.DEFAULT_SANDBOX_MODE);
  // App Server's dangerFullAccess policy has no separate network toggle.
  // Honor an explicit network narrowing by selecting the strongest policy
  // that can actually enforce networkAccess=false.
  const sandbox = !networkAccess && requestedSandbox === 'danger-full-access'
    ? 'workspace-write'
    : requestedSandbox;
  const persistentSession = environment.PERSISTENT_SESSION === 'true';
  const resumeThreadId = environment.AGENT_THREAD_ID;
  if (resumeThreadId && !persistentSession) {
    throw new Error('Codex thread resume requires a persistent MicroVM session');
  }
  const model = request.agent?.model ?? (
    authMode === 'chatgpt' ? environment.CODEX_CHATGPT_MODEL : environment.DEFAULT_MODEL
  );
  const identity = agentProcessIdentity(environment.RUN_AGENT_UID, environment.RUN_AGENT_GID);
  return {
    binary: environment.CODEX_BINARY ?? 'codex',
    ...(authMode === 'chatgpt'
      ? { binaryArguments: ['-c', 'cli_auth_credentials_store=file', 'app-server'] }
      : {}),
    workspace,
    environment: agentEnvironment(workspace, environment),
    ...(identity ? { identity } : {}),
    timeoutMs,
    prompt: artifactPromptText(request.prompt, environment.AGENT_PUBLICATION_ENABLED === 'true'),
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
  };
}

function agentEnvironment(workspace: string, environment: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  const authMode = codexAuthMode(environment);
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
  if (environment.ALLOW_AGENT_AWS_CREDENTIAL_CHAIN === 'true') {
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
  for (const name of (environment.AGENT_PASSTHROUGH_ENV ?? '').split(',')) {
    if (name.trim()) allowed.add(name.trim());
  }
  return {
    ...Object.fromEntries(
      [...allowed]
        .map((name) => [name, environment[name]] as const)
        .filter((entry): entry is readonly [string, string] => entry[1] !== undefined),
    ),
    RAT_THINGS_ARTIFACT_DIR: `${workspace}/${AGENT_ARTIFACT_DIRECTORY}`,
  };
}

function defaultSandboxMode(configured: string | undefined): 'read-only' | 'workspace-write' | 'danger-full-access' {
  const value = configured ?? 'read-only';
  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(value)) {
    throw new Error('DEFAULT_SANDBOX_MODE is invalid');
  }
  return value as 'read-only' | 'workspace-write' | 'danger-full-access';
}
