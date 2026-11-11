import type { SessionLaunch } from '../domain/session-execution.js';
import type { PersistedAgentTool } from '../domain/agents-api.js';
import type { CodexAppServerRequest } from './codex-app-server.js';
import type { CodexLaunchPlan } from './agent-planning.js';
import { sessionRecoveryItems } from './session-recovery-planning.js';
import type { SessionMcpRuntime } from './session-mcp.js';
import { hostedCodexArguments, hostedProcessEnvironment } from './hosted-environment-planning.js';
import type { SessionEnvironmentCredentialsRuntime } from './session-environment-credentials.js';
import { nativeServiceTier } from '../domain/session-model-validation.js';
import { SHARED_BROWSER_TOOL_NAME, sharedBrowserGranted } from '../domain/shared-browser.js';
import sharedBrowserSource from './shared-browser-worker-source.json' with { type: 'json' };

/** Translate public agent settings once, without changing the requested model or widening authority. */
export function planSessionLaunch(base: CodexLaunchPlan, launch: SessionLaunch, environmentToken?: string, mcp?: Pick<SessionMcpRuntime, 'servers' | 'environment'>, credentials?: Pick<SessionEnvironmentCredentialsRuntime, 'processEnvironment' | 'shellEnvironment'>): Partial<CodexAppServerRequest> {
  const { agent } = launch;
  const maxSubagents = agent.multi_agent.max_concurrent_subagents ?? 6;
  const { RAT_THINGS_ARTIFACT_DIR: _legacyArtifactDirectory, ...environment } = base.environment;
  const search = agent.tools.find((tool) => tool.type === 'web_search');
  if (search && base.webSearch !== search.mode) throw new Error('Session web search exceeds the admitted execution policy');
  const functions = agent.tools.filter((tool) => tool.type === 'function').filter(tool => tool.name !== SHARED_BROWSER_TOOL_NAME);
  const browser = sharedBrowserGranted(agent.tools);
  if (browser && launch.environment.type === 'none') throw new Error('The shared browser requires a managed environment');
  const browserCommand = ['node', '--input-type=module', '-e', sharedBrowserSource];
  const browserServer = browser ? { rat_shared_browser: {
    command: browserCommand[0], args: browserCommand.slice(1), cwd: '/workspace',
    environment_id: launch.environment.type === 'self_hosted' ? 'remote' : 'local', required: true,
    enabled_tools: ['browser'], default_tools_approval_mode: 'approve',
    env: { RAT_BROWSER_ROLE: 'mcp' },
  } } : {};
  if (launch.environment.type === 'self_hosted' && !environmentToken) throw new Error('The self-hosted environment credential is missing');
  return {
    sessionTurnId: launch.turnId,
    prompt: '',
    environment: { ...environment, ...mcp?.environment },
    ...(launch.history?.length ? { recoveryItems: sessionRecoveryItems(launch.history) } : {}),
    model: agent.model,
    developerInstructions: agent.instructions,
    serviceTier: nativeServiceTier(agent.service_tier),
    ...(agent.reasoning.effort !== null ? { reasoningEffort: agent.reasoning.effort } : {}),
    ...(agent.reasoning.summary !== null ? { reasoningSummary: agent.reasoning.summary } : {}),
    ...(agent.text.format.type === 'json_schema' ? { outputSchema: agent.text.format.schema as Record<string, unknown> } : {}),
    input: launch.input.flatMap((message) => message.content.map((part) => part.type === 'input_text' ? { type: 'text', text: part.text } : { type: 'image', url: part.image_url })),
    ...(launch.environment.type === 'none' ? { environments: [] } : {}),
    ...(launch.environment.type === 'openai_hosted' ? {
      permissions: 'rat_managed',
      managedPolicy: { workspace: '/workspace', network: launch.environment.network, credentialProxy: Boolean(credentials) },
      binaryArguments: hostedCodexArguments(base.binaryArguments, launch.environment.network, Boolean(credentials)),
      environments: [{ environmentId: 'local', cwd: '/workspace' }], executionWorkspace: '/workspace',
      // Keep credential placeholders in the app-server process environment as a
      // compatibility fallback for native versions that do not apply
      // shell_environment_policy.set to command/exec. Values are placeholders;
      // the host-side proxy remains the only component that can read secrets.
      environment: { ...environment, ...hostedProcessEnvironment(launch.hostedConfiguration?.env ?? {}, base.environment.PATH), ...credentials?.shellEnvironment, ...mcp?.environment, ...credentials?.processEnvironment },
    } : {}),
    selectedCapabilityRoots: launch.environment.type === 'none' ? [] : launch.environment.capability_directories.map((path, index) => ({
      id: `capability_${index}`, location: { type: 'environment', environmentId: launch.environment.type === 'self_hosted' ? 'remote' : 'local', path },
    })),
    ...(launch.environment.type === 'self_hosted' ? {
      environments: [{ environmentId: 'remote', cwd: launch.environment.workspace_directory }], executionWorkspace: launch.environment.workspace_directory,
      environment: { ...environment, ...mcp?.environment, CODEX_EXEC_SERVER_NOISE_REGISTRY_URL: launch.environment.remote_url, CODEX_EXEC_SERVER_NOISE_ENVIRONMENT_ID: launch.environment.id, CODEX_EXEC_SERVER_NOISE_AUTH_TOKEN: environmentToken! },
    } : {}),
    webSearch: search?.mode ?? 'disabled',
    // Native deferred functions require a namespace. Keep the public function
    // name unchanged; the namespace only routes discovery inside the harness.
    dynamicTools: [
      ...functions.filter((tool) => !tool.defer_loading).map((tool) => ({ type: 'function', name: tool.name, description: tool.description, inputSchema: tool.parameters, deferLoading: false })),
      ...(functions.some((tool) => tool.defer_loading) ? [{ type: 'namespace', name: 'application', description: 'Application function tools.',
        tools: functions.filter((tool) => tool.defer_loading).map((tool) => ({ type: 'function', name: tool.name, description: tool.description, inputSchema: tool.parameters, deferLoading: true })),
      }] : []),
    ],
    sessionConfig: {
      model_verbosity: agent.text.verbosity,
      mcp_servers: { ...mcp?.servers, ...browserServer },
      'features.multi_agent': agent.multi_agent.enabled,
      // The current collaboration family supplies interruption and follow-up work.
      'features.multi_agent_v2': { enabled: agent.multi_agent.enabled, max_concurrent_threads_per_session: maxSubagents + 1 },
      'features.code_mode': agent.tools.some((tool) => tool.type === 'programmatic_tool_calling' && tool.enabled),
      'features.default_mode_request_user_input': false,
      ...(launch.environment.type === 'openai_hosted' ? { shell_environment_policy: { inherit: 'core', set: { ...hostedProcessEnvironment(launch.hostedConfiguration?.env ?? {}, base.environment.PATH), ...credentials?.shellEnvironment } } } : {}),
      ...(search ? { 'tools.web_search': nativeWebSearchConfig(search) } : {}),
    },
  };
}

/** Public nullable fields become absent optional native settings. */
function nativeWebSearchConfig(search: Extract<PersistedAgentTool, { type: 'web_search' }>) {
  return {
    context_size: search.context_size,
    ...(search.allowed_domains !== null ? { allowed_domains: search.allowed_domains } : {}),
    ...(search.location !== null ? { location: Object.fromEntries(Object.entries(search.location).filter(([, value]) => value !== null)) } : {}),
  };
}
