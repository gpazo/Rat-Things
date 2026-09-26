#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { localTraceExport, recordLocalTrace } from './core/local-trace-planning.js';
import type { SessionRuntimeState } from './core/session-runtime-planning.js';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentDriverName, RunRequest, SandboxMode } from './domain/contracts.js';
import type {
  ConnectionAccessRequest,
  IntegrationAuthScheme,
  IntegrationAccessRequest,
  IntegrationPermissionPreset,
} from './domain/capabilities.js';
import { INTEGRATION_PERMISSION_PRESETS } from './domain/capabilities.js';
import type { IntegrationPluginManifest } from './plugins/integration-types.js';
import { parseRunRequest } from './domain/validation.js';
import {
  CapabilityProfileRegistry,
  createBuiltinCapabilityProfiles,
  resolveAgentProfile,
} from './plugins/capability-profiles.js';
import { codexAuthMode, localCodexAuthMode } from './runner/codex-auth.js';
import { sessionPublicationRequest } from './core/session-publication-planning.js';
import { runAgentsCli } from './agents-cli.js';

interface Arguments {
  command: string;
  values: Map<string, string>;
  multiple: Map<string, string[]>;
  flags: Set<string>;
  positionals: string[];
}

const commands = new Set([
  'local',
  'schedules',
  'console',
  'plugins',
  'profiles',
  'connections',
  'connection',
  'connect',
  'grant',
  'rotate',
  'revoke',
  'connection-sets',
  'connection-set',
  'source-bindings',
  'bind-source',
  'slack-events',
  'doctor',
  'help',
  'publications',
]);

const booleanOptions = new Set([
  'all',
  'events',
  'open',
  'help',
  'json',
  'browser',
  'network',
  'no-browser',
  'no-network',
  'no-wait',
  'oauth',
  'patch',
  'wait',
]);

const repeatableOptions = new Set([
  'allow-operation',
  'app',
  'connection',
  'deny-operation',
  'mcp',
  'skill',
]);

const valueOptions = new Set([
  'agent-id', 'environment-template', 'session',
  'access',
  'alias',
  'api-url',
  'auth-scheme',
  'backend',
  'base-ref',
  'codex-auth',
  'connection-set',
  'credential-file',
  'credential-secret-arn',
  'driver',
  'file',
  'limit',
  'model',
  'name',
  'personality',
  'port',
  'profile',
  'prompt',
  'provider',
  'reasoning-effort',
  'reasoning-summary',
  'ref',
  'region',
  'repo',
  'sandbox',
  'timeout',
  'trace-output',
  'web-search',
  'workspace',
]);

interface SimpleApiCommand {
  method: 'GET' | 'POST';
  path(args: Arguments): string;
  body?(args: Arguments): unknown | Promise<unknown>;
}

const simpleApiCommands: Record<string, SimpleApiCommand> = {
  plugins: { method: 'GET', path: () => '/v1/integrations/plugins' },
  profiles: { method: 'GET', path: () => '/v1/capability-profiles' },
  connections: { method: 'GET', path: () => '/v1/integrations/connections' },
  grant: {
    method: 'POST',
    path: (args) => `/v1/integrations/connections/${positionalPath(args, 0, 'connection ID or alias')}/grant`,
    body: requiredJsonFile,
  },
  revoke: {
    method: 'POST',
    path: (args) => `/v1/integrations/connections/${positionalPath(args, 0, 'connection ID or alias')}/revoke`,
    body: () => ({}),
  },
  'connection-sets': { method: 'GET', path: () => '/v1/integrations/connection-sets' },
  'connection-set': {
    method: 'POST', path: () => '/v1/integrations/connection-sets', body: requiredJsonFile,
  },
  'source-bindings': { method: 'GET', path: () => '/v1/integrations/source-bindings' },
  'bind-source': {
    method: 'POST', path: () => '/v1/integrations/source-bindings', body: requiredJsonFile,
  },
};

async function main(): Promise<void> {
  if (await runAgentsCli(process.argv.slice(2))) return;
  const args = parseArguments(normalizeArguments(process.argv.slice(2)));
  if (args.values.has('api-url')) {
    process.env.RAT_THINGS_API_URL = args.values.get('api-url');
  }
  if (args.values.has('region')) process.env.AWS_REGION = args.values.get('region');
  if (args.flags.has('help')) { help(args.flags.has('all')); return; }
  validateRootPositionals(args);
  const simple = simpleApiCommands[args.command];
  if (simple) {
    print(await api(simple.path(args), simple.method, simple.body ? await simple.body(args) : undefined));
    return;
  }
  switch (args.command) {
    case 'publications':
      await publicationsCommand(args);
      return;
    case 'schedules':
      await schedulesCommand(args);
      return;
    case 'local':
      await local(args);
      return;
    case 'console':
      await openConsole(args);
      return;
    case 'connection':
      await connectionCommand(args);
      return;
    case 'connect':
      await connect(args);
      return;
    case 'rotate':
      await rotateCredential(args);
      return;
    case 'slack-events':
      await enableSlackEvents(args);
      return;
    case 'doctor':
      await doctor(args);
      return;
    case 'help':
    case '--help':
    case '-h':
      help(args.flags.has('all'));
      return;
    default:
      throw new Error(`unknown command ${JSON.stringify(args.command)}; run rat-things help`);
  }
}

/** Prevent provider- or agent-authored text from issuing terminal commands in human output. */
function terminalText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, '�');
}

async function local(args: Arguments): Promise<void> {
  validateCommandOptions(args, {
    flags: ['browser', 'events', 'network', 'no-browser', 'no-network', 'patch'],
    values: [
      'base-ref', 'codex-auth', 'connection-set', 'credential-secret-arn', 'driver', 'file', 'model',
      'personality', 'profile', 'prompt', 'provider', 'reasoning-effort', 'reasoning-summary',
      'ref', 'repo', 'sandbox', 'timeout', 'trace-output', 'web-search', 'workspace',
    ],
    multiple: ['allow-operation', 'app', 'connection', 'deny-operation', 'mcp', 'skill'],
  });
  const requestedAuthMode = args.values.get('codex-auth');
  const parsed = await requestFromArguments(args);
  const resolvedProfile = resolveAgentProfile(
    parsed.agent,
    new CapabilityProfileRegistry(createBuiltinCapabilityProfiles()),
  );
  const request: RunRequest = {
    ...parsed,
    ...(resolvedProfile.agent ? { agent: resolvedProfile.agent } : {}),
  };
  if (request.integrations) {
    throw new Error('local integration connections are not supported; use the remote MicroVM control API');
  }
  if (request.agent?.capabilities?.computerUse === 'browser') {
    throw new Error('local browser computer use is not supported; use a remote MicroVM or --no-browser');
  }
  const [
    { SecretsManagerClient }, { CachedSecretReader }, { CredentialBroker },
    { driverFor }, { loadCodexBedrockToken }, { localArtifactPaths, prepareArtifactDirectory },
    { collectWorkspacePatch, prepareWorkspace },
  ] = await Promise.all([
    import('@aws-sdk/client-secrets-manager'), import('./adapters/aws-runtime.js'), import('./credentials/broker.js'),
    import('./runner/agent-driver.js'), import('./runner/bedrock-auth.js'), import('./runner/artifacts.js'),
    import('./runner/workspace.js'),
  ]);
  const driverName = request.agent?.driver ?? 'mock';
  if (driverName === 'codex') process.env.CODEX_AUTH_MODE = localCodexAuthMode(requestedAuthMode);
  const timeout = (request.execution?.timeoutSeconds ?? 900) * 1_000;
  const explicitWorkspace = args.values.get('workspace');
  let workspace = explicitWorkspace ? resolve(explicitWorkspace) : process.cwd();
  let temporary: string | undefined;
  let loadedBedrockToken = false;
  const credentials = new CredentialBroker(
    new CachedSecretReader(new SecretsManagerClient(regionConfig())),
  );

  if (request.repository) {
    const root = resolve(process.env.WORKSPACE_ROOT ?? join(tmpdir(), 'agent-runtime'));
    await mkdir(root, { recursive: true, mode: 0o700 });
    temporary = await mkdtemp(join(root, 'local-'));
    workspace = temporary;
    await prepareWorkspace(request.repository, workspace, credentials);
  }

  try {
    if (driverName === 'codex') await prepareArtifactDirectory(workspace);
    if (
      driverName === 'codex' &&
      codexAuthMode() === 'bedrock' &&
      !process.env.AWS_BEARER_TOKEN_BEDROCK
    ) {
      loadedBedrockToken = await loadCodexBedrockToken(credentials);
    }
    const tracePath = args.values.get('trace-output');
    const traceSessionId = `local_${randomUUID()}`;
    const traceStart = Date.now() / 1000;
    let traceState: SessionRuntimeState | undefined;
    let traceOutcome: 'completed' | 'failed' | 'interrupted' = 'failed';
    const execute = async () => {
      try {
        const result = await driverFor(driverName).execute(request, workspace, timeout, undefined, tracePath ? {
          captureTraces: true,
          onEvent: event => { traceState = recordLocalTrace(traceState, traceSessionId, { ...event, observedAt: Date.now() / 1000 }); },
        } : undefined);
        traceOutcome = result.outcome ?? (result.exitCode === 0 ? 'completed' : 'failed');
        return result;
      } finally {
        if (tracePath) await writeFile(tracePath, JSON.stringify(localTraceExport(traceState, traceSessionId, request.agent?.model, traceStart, Date.now() / 1000, traceOutcome), null, 2) + '\n', { mode: 0o600 });
      }
    };
    const result = await execute();
    process.stdout.write(`${terminalText(result.fullText)}\n`);
    if (driverName === 'codex') {
      const paths = await localArtifactPaths(workspace);
      if (paths.length > 0) {
        process.stderr.write('\nFiles:\n');
        for (const path of paths) {
          process.stderr.write(`  ${terminalText(path)}\t${terminalText(resolve(workspace, '.rat-things/artifacts', path))}\n`);
        }
      }
    }
    if (args.flags.has('events')) {
      process.stderr.write(`\n--- events.jsonl ---\n${terminalText(result.events.toString('utf8'))}`);
    }
    if (args.flags.has('patch')) {
      const patch = await collectWorkspacePatch(workspace);
      if (patch) process.stderr.write(`\n--- workspace.patch ---\n${terminalText(patch.toString('utf8'))}\n`);
    }
  } finally {
    if (loadedBedrockToken) delete process.env.AWS_BEARER_TOKEN_BEDROCK;
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}

async function openConsole(args: Arguments): Promise<void> {
  validateCommandOptions(args, { flags: ['no-wait'], values: ['port'] });
  const base = process.env.RAT_THINGS_AGENTS_API_URL ?? process.env.RAT_THINGS_API_URL;
  if (!base) throw new Error('RAT_THINGS_AGENTS_API_URL is required to open the signed console');
  const port = Number(args.values.get('port') ?? '4174');
  if (!Number.isInteger(port) || port < 1_024 || port > 65_535) {
    throw new Error('--port must be an integer from 1024 through 65535');
  }
  const cliDirectory = dirname(fileURLToPath(import.meta.url));
  const bundledServer = join(cliDirectory, 'console-server.mjs');
  const sourceRoot = dirname(cliDirectory);
  const bundled = existsSync(bundledServer);
  const executable = bundled ? process.execPath : join(sourceRoot, 'node_modules', '.bin', 'tsx');
  const serverArgs = bundled ? [bundledServer] : [join(sourceRoot, 'scripts', 'console-server.ts')];
  if (!existsSync(executable) || !existsSync(serverArgs[0]!)) {
    throw new Error('the console runtime is missing; run npm run build from a Rat Things checkout');
  }
  const consoleRoot = bundled ? join(cliDirectory, 'console') : join(sourceRoot, 'console');
  const child = spawn(executable, serverArgs, {
    env: {
      ...process.env,
      RAT_THINGS_API_URL: base,
      RAT_THINGS_CONSOLE_PORT: String(port),
      RAT_THINGS_CONSOLE_LAUNCHER: '1',
      RAT_THINGS_CONSOLE_ROOT: consoleRoot,
    },
    stdio: ['ignore', 'pipe', args.flags.has('no-wait') ? 'ignore' : 'inherit'],
    detached: args.flags.has('no-wait'),
  });
  try {
    const boundPort = await waitForLocalConsole(child);
    const url = `http://127.0.0.1:${boundPort}/`;
    launchBrowser(url);
    process.stdout.write(`Rat Things console: ${url}\n`);
    if (args.flags.has('no-wait')) {
      child.stdout?.destroy();
      child.unref();
      return;
    }
    await new Promise<void>((resolvePromise, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => code === 0 || code === null
        ? resolvePromise()
        : reject(new Error(`console server exited with code ${code}`)));
    });
  } catch (error) {
    if (!child.killed) child.kill('SIGTERM');
    throw error;
  }
}

async function waitForLocalConsole(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    let output = '';
    const finish = (error?: Error, port?: number) => {
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      child.off('error', onError);
      child.off('exit', onExit);
      if (error) reject(error);
      else resolvePromise(port!);
    };
    const onError = (error: Error) => finish(error);
    const onExit = () => finish(new Error('console server exited before becoming ready'));
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > 1_024) return finish(new Error('invalid console readiness response'));
      if (!output.includes('\n')) return;
      try {
        const { port } = JSON.parse(output.split('\n')[0]!) as { port: number };
        if (!Number.isInteger(port) || port < 1_024 || port > 65_535) throw new Error('invalid console port');
        finish(undefined, port);
      } catch { finish(new Error('invalid console readiness response')); }
    };
    const timer = setTimeout(() => finish(new Error('console server did not become ready within 6 seconds')), 6_000);
    child.stdout?.on('data', onData);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

function launchBrowser(url: string): void {
  const command = process.platform === 'darwin'
    ? ['open', [url]] as const
    : process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]] as const
      : ['xdg-open', [url]] as const;
  const browser = spawn(command[0], command[1], { detached: true, stdio: 'ignore' });
  browser.unref();
}

async function requiredJsonFile(args: Arguments): Promise<unknown> {
  const path = args.values.get('file');
  if (!path) throw new Error('--file JSON is required');
  try {
    return JSON.parse(await readFile(resolve(path), 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`could not read JSON file: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function connectionCommand(args: Arguments): Promise<void> {
  validateCommandOptions(args, {
    flags: ['json', 'no-browser', 'oauth', 'wait'],
    values: ['credential-file', 'name'],
  });
  const operation = requiredPositional(args, 0, 'connection operation');
  const selector = requiredPositional(args, 1, 'connection ID or alias');
  const path = `/v1/integrations/connections/${encodeURIComponent(selector)}`;
  switch (operation) {
    case 'show':
      validatePositionals(args, 2, 2, 'connection show ACCOUNT');
      print(await api(path, 'GET'));
      return;
    case 'test':
      validatePositionals(args, 2, 2, 'connection test ACCOUNT');
      print(await api(`${path}/test`, 'POST', {}));
      return;
    case 'consumers':
      validatePositionals(args, 2, 2, 'connection consumers ACCOUNT');
      print(await api(`${path}/consumers`, 'GET'));
      return;
    case 'rename': {
      validatePositionals(args, 2, 3, 'connection rename ACCOUNT --name NAME');
      const displayName = args.values.get('name') ?? args.positionals[2];
      if (!displayName?.trim()) throw new Error('connection rename requires --name NAME');
      print(await api(path, 'PATCH', { version: '1', displayName }));
      return;
    }
    case 'reconnect':
      validatePositionals(args, 2, 2, 'connection reconnect ACCOUNT [--oauth] [--wait]');
      await reconnectConnection(args, selector, path);
      return;
    default:
      throw new Error('connection operation must be show, test, consumers, rename, or reconnect');
  }
}

async function reconnectConnection(args: Arguments, selector: string, path: string): Promise<void> {
  const detail = await api(path, 'GET') as Record<string, unknown>;
  const connection = isObject(detail.connection) ? detail.connection : undefined;
  if (!connection || typeof connection.pluginId !== 'string' || !isObject(connection.authorization)) {
    throw new Error('runtime returned an invalid connection');
  }
  const scheme = connection.authorization.scheme;
  if (scheme === 'oauth2' || args.flags.has('oauth')) {
    if (scheme !== 'oauth2') throw new Error('--oauth requires an existing OAuth connection');
    if (args.values.has('credential-file')) {
      throw new Error('--oauth cannot be combined with --credential-file');
    }
    const plugin = await installedIntegrationPlugin(connection.pluginId);
    if (plugin.oauthInstallation?.status !== 'configured') {
      throw new Error(`OAuth application for ${connection.pluginId} is not configured in this deployment`);
    }
    const started = await api(`${path}/oauth/reconnect`, 'POST', { version: '1' }) as {
      authorizationUrl?: unknown;
      expiresAt?: unknown;
    };
    if (typeof started.authorizationUrl !== 'string') {
      throw new Error('runtime returned no OAuth authorization URL');
    }
    if (!args.flags.has('json')) {
      process.stdout.write(`Open this URL to reconnect ${terminalText(String(connection.displayName ?? connection.label ?? selector))}:\n${terminalText(started.authorizationUrl)}\n`);
      if (!args.flags.has('no-browser')) launchBrowser(started.authorizationUrl);
    }
    if (args.flags.has('wait')) {
      print(await waitForOAuthReconnect(
        path,
        typeof connection.updatedAt === 'string' ? connection.updatedAt : undefined,
        isObject(detail.health) && typeof detail.health.checkedAt === 'string'
          ? detail.health.checkedAt
          : undefined,
        started.expiresAt,
      ));
    } else if (args.flags.has('json')) print(started);
    return;
  }
  if (args.flags.has('wait')) throw new Error('--wait is only used with OAuth reconnect');
  const plugin = await installedIntegrationPlugin(connection.pluginId);
  const authentication = plugin.authentication.find((candidate) => candidate.scheme === scheme);
  if (!authentication) throw new Error('connection authentication method is no longer installed');
  const credential = await credentialFile(args, authentication.fields);
  print(await api(`${path}/credential`, 'POST', { version: '1', credential }));
}

async function waitForOAuthReconnect(
  path: string,
  previousUpdatedAt: string | undefined,
  previousCheckedAt: string | undefined,
  expiresAt: unknown,
): Promise<unknown> {
  return waitForOAuth(expiresAt, async () => {
    const detail = await api(path, 'GET') as Record<string, unknown>;
    const connection = isObject(detail.connection) ? detail.connection : undefined;
    const health = isObject(detail.health) ? detail.health : undefined;
    const changed = connection?.updatedAt !== previousUpdatedAt || health?.checkedAt !== previousCheckedAt;
    if (changed && connection?.status === 'active' && health?.status === 'healthy') return detail;
    return undefined;
  }, 'OAuth reconnect expired before the account was verified');
}

async function connect(args: Arguments): Promise<void> {
  validateCommandOptions(args, {
    flags: ['json', 'no-browser', 'oauth', 'wait'],
    values: ['access', 'alias', 'auth-scheme', 'credential-file'],
  });
  const pluginId = requiredPositional(args, 0, 'plugin ID');
  const plugin = await installedIntegrationPlugin(pluginId);
  if (args.flags.has('oauth') && args.values.has('credential-file')) {
    throw new Error('--oauth cannot be combined with --credential-file');
  }
  const requestedScheme = args.flags.has('oauth') ? 'oauth2' : args.values.get('auth-scheme');
  const authentication = requestedScheme
    ? plugin.authentication.find((candidate) => candidate.scheme === requestedScheme)
    : plugin.authentication.length === 1
      ? plugin.authentication[0]
      : undefined;
  if (!authentication) {
    const choices = plugin.authentication.map((candidate) => candidate.scheme).join(', ');
    throw new Error(requestedScheme
      ? `integration plugin ${pluginId} does not support ${requestedScheme}; choose ${choices}`
      : `--auth-scheme is required; choose ${choices}`);
  }
  const access = args.values.get('access') ?? 'read-only';
  if (!['read-only', 'read-write', 'full'].includes(access)) {
    throw new Error('--access must be read-only, read-write, or full');
  }
  const request = {
    version: '1',
    pluginId,
    ...(args.values.get('alias') ? { alias: args.values.get('alias') } : {}),
    grant: { version: '1', preset: access },
  };
  if (args.flags.has('oauth')) {
    if (!authentication.oauth2) throw new Error(`integration plugin ${pluginId} does not support hosted OAuth`);
    if (plugin.oauthInstallation?.status !== 'configured') {
      const callback = plugin.oauthInstallation?.callbackUrl;
      throw new Error(
        `OAuth application for ${pluginId} is not configured in this deployment`
          + (callback ? `; register ${callback} and set integration_oauth_app_secret_arns` : ''),
      );
    }
    const existingConnectionIds = args.flags.has('wait')
      ? await installedConnectionIds(pluginId)
      : new Set<string>();
    const started = await api('/v1/integrations/oauth/authorizations', 'POST', request) as {
      authorizationUrl?: unknown;
      expiresAt?: unknown;
    };
    if (typeof started.authorizationUrl !== 'string') {
      throw new Error('runtime returned no OAuth authorization URL');
    }
    if (!args.flags.has('json')) {
      process.stdout.write(`Open this URL to connect ${terminalText(plugin.title)}:\n${terminalText(started.authorizationUrl)}\n`);
      if (!args.flags.has('no-browser')) launchBrowser(started.authorizationUrl);
    }
    if (args.flags.has('wait')) {
      print(await waitForOAuthConnection(pluginId, existingConnectionIds, started.expiresAt));
    } else if (args.flags.has('json')) print(started);
    return;
  }
  const credential = await credentialFile(args, authentication.fields);
  print(await api('/v1/integrations/connections', 'POST', {
    ...request,
    authScheme: authentication.scheme as IntegrationAuthScheme,
    credential,
  }));
}

async function installedConnectionIds(pluginId: string): Promise<Set<string>> {
  return new Set((await installedConnections()).flatMap(({ connection }) => (
    connection.pluginId === pluginId && typeof connection.connectionId === 'string'
      ? [connection.connectionId]
      : []
  )));
}

async function waitForOAuthConnection(
  pluginId: string,
  existingConnectionIds: Set<string>,
  expiresAt: unknown,
): Promise<unknown> {
  return waitForOAuth(expiresAt, async () => (
    (await installedConnections()).find(({ connection }) => (
      connection.pluginId === pluginId &&
      typeof connection.connectionId === 'string' &&
      !existingConnectionIds.has(connection.connectionId)
    ))
  ), `OAuth authorization for ${pluginId} expired before a connection was installed`);
}

async function enableSlackEvents(args: Arguments): Promise<void> {
  validateCommandOptions(args, { flags: ['json'], values: ['agent-id', 'environment-template'] });
  const agentId = args.values.get('agent-id');
  if (!agentId) throw new Error('--agent-id is required');
  const templateId = args.values.get('environment-template');
  const environment = templateId ? { type: 'openai_hosted', environment_template_id: templateId } : { type: 'none' };
  await api(`/v1/agents/${encodeURIComponent(agentId)}`, 'GET');
  const selector = requiredPositional(args, 0, 'Slack connection ID or alias');
  const item = (await installedConnections()).find(({ connection }) => (
    connection.connectionId === selector || connection.alias === selector
  ));
  const connection = item?.connection;
  if (!connection || connection.pluginId !== 'slack' || connection.status !== 'active') {
    throw new Error(`active Slack connection ${selector} was not found`);
  }
  const teamId = connection.externalTenantId;
  const connectionId = connection.connectionId;
  if (typeof teamId !== 'string' || !teamId || typeof connectionId !== 'string' || !connectionId) {
    throw new Error('Slack connection is missing its verified workspace identity');
  }
  const listedBindings = await api('/v1/integrations/source-bindings', 'GET') as { sourceBindings?: unknown };
  if (!Array.isArray(listedBindings.sourceBindings)) {
    throw new Error('runtime returned an invalid source binding list');
  }
  const existing = listedBindings.sourceBindings.find((candidate) => {
    if (!isObject(candidate) || candidate.sourceKind !== 'slack' || !isObject(candidate.selector)) return false;
    return candidate.selector.teamId === teamId;
  });
  if (existing) {
    const listedSets = await api('/v1/integrations/connection-sets', 'GET') as { connectionSets?: unknown };
    if (!Array.isArray(listedSets.connectionSets)) {
      throw new Error('runtime returned an invalid connection set list');
    }
    const existingSet = listedSets.connectionSets.find((candidate) => (
      isObject(candidate) && candidate.connectionSetId === existing.connectionSetId
    ));
    if (
      !isObject(existingSet) ||
      !Array.isArray(existingSet.connectionIds) ||
      !existingSet.connectionIds.includes(connectionId)
    ) {
      throw new Error(
        `Slack workspace ${teamId} already routes mentions through another connection`,
      );
    }
    if (existing.agentId !== agentId || JSON.stringify(existing.environment) !== JSON.stringify(environment)) throw new Error('The Slack workspace is bound to a different Agent or environment');
    if (!['read-write', 'full'].includes(String(item?.grant?.preset))) {
      await api(`/v1/integrations/connections/${encodeURIComponent(connectionId)}/grant`, 'POST', {
        version: '1',
        preset: 'read-write',
      });
    }
    print({ enabled: true, connection, sourceBinding: existing, unchanged: true });
    return;
  }
  if (!['read-write', 'full'].includes(String(item?.grant?.preset))) {
    await api(`/v1/integrations/connections/${encodeURIComponent(connectionId)}/grant`, 'POST', {
      version: '1',
      preset: 'read-write',
    });
  }
  const set = await api('/v1/integrations/connection-sets', 'POST', {
    version: '1',
    name: `slack-events-${teamId.toLowerCase()}`,
    connections: [connectionId],
    defaults: { slack: connectionId },
  }) as Record<string, unknown>;
  const setId = set.connectionSetId;
  if (typeof setId !== 'string' || !setId) throw new Error('runtime returned an invalid connection set');
  const sourceBinding = await api('/v1/integrations/source-bindings', 'POST', {
    version: '1',
    sourceKind: 'slack',
    selector: { teamId },
    agentId, environment,
    connectionSetId: setId,
  });
  print({ enabled: true, connection, connectionSet: set, sourceBinding });
}

async function installedIntegrationPlugin(pluginId: string): Promise<IntegrationPluginManifest> {
  const catalog = await api('/v1/integrations/plugins', 'GET') as { plugins?: unknown };
  if (!Array.isArray(catalog.plugins)) throw new Error('runtime returned an invalid integration catalog');
  const plugin = (catalog.plugins as IntegrationPluginManifest[]).find(
    (candidate) => candidate.id === pluginId,
  );
  if (!plugin) throw new Error(`integration plugin ${pluginId} is not installed`);
  if (!Array.isArray(plugin.authentication) || plugin.authentication.length === 0) {
    throw new Error(`integration plugin ${pluginId} has no authentication methods`);
  }
  return plugin;
}

async function rotateCredential(args: Arguments): Promise<void> {
  const selector = requiredPositional(args, 0, 'connection ID or alias');
  const record = (await installedConnections()).find(({ connection }) => (
    connection.connectionId === selector || connection.alias === selector
  ));
  if (!record) {
    throw new Error(`integration connection ${selector} was not found`);
  }
  const connection = record.connection;
  if (typeof connection.pluginId !== 'string') throw new Error('runtime returned an invalid connection plugin');
  const authorization = connection.authorization;
  if (!authorization || typeof authorization !== 'object' || Array.isArray(authorization)) {
    throw new Error('runtime returned an invalid connection authorization');
  }
  const scheme = (authorization as Record<string, unknown>).scheme;
  const plugin = await installedIntegrationPlugin(connection.pluginId);
  const authentication = plugin.authentication.find((candidate) => candidate.scheme === scheme);
  if (!authentication) throw new Error('connection authentication method is no longer installed');
  const credential = await credentialFile(args, authentication.fields);
  print(await api(
    `/v1/integrations/connections/${encodeURIComponent(selector)}/credential`,
    'POST',
    { version: '1', credential },
  ));
}

async function credentialFile(
  args: Arguments,
  fields: IntegrationPluginManifest['authentication'][number]['fields'],
): Promise<Record<string, string>> {
  const path = args.values.get('credential-file');
  if (!path) {
    const expected = fields.map((field) => field.key).join(', ');
    throw new Error(`--credential-file JSON is required with fields: ${expected || '(none)'}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(resolve(path), 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`could not read credential JSON file: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('credential file must contain one JSON object');
  }
  const result: Record<string, string> = {};
  const expected = new Set(fields.map((field) => field.key));
  for (const field of fields) {
    const value = (parsed as Record<string, unknown>)[field.key];
    if ((field.required !== false && !field.computed) && (typeof value !== 'string' || !value)) {
      throw new Error(`credential file requires non-empty string field ${field.key}`);
    }
    if (typeof value === 'string' && value) result[field.key] = value;
  }
  for (const key of Object.keys(parsed)) {
    if (!expected.has(key)) throw new Error(`credential field ${key} is not used by ${args.positionals[0]}`);
  }
  return result;
}

async function requestFromArguments(args: Arguments): Promise<RunRequest> {
  const file = args.values.get('file');
  if (file) return parseRunRequest(JSON.parse(await readFile(resolve(file), 'utf8')) as unknown, validationOptions());
  const prompt = args.values.get('prompt') ?? args.positionals.join(' ');
  if (!prompt) throw new Error('provide --prompt TEXT or --file REQUEST.json');
  const request: Record<string, unknown> = {
    version: '1',
    prompt,
    agent: agentFromArguments(args),
    ...withIntegrations(args),
    execution: compact({
      backend: args.values.get('backend'),
      timeoutSeconds: args.values.has('timeout')
        ? positiveNumber(args.values.get('timeout') as string, 'timeout')
        : undefined,
    }),
  };
  const repositoryUrl = args.values.get('repo');
  if (repositoryUrl) {
    request.repository = compact({
      provider: args.values.get('provider') ?? inferProvider(repositoryUrl),
      url: repositoryUrl,
      ref: args.values.get('ref'),
      baseRef: args.values.get('base-ref'),
      credentialSecretArn: args.values.get('credential-secret-arn'),
    });
  }
  return parseRunRequest(request, validationOptions());
}

function agentFromArguments(args: Arguments): Record<string, unknown> {
  if (args.flags.has('network') && args.flags.has('no-network')) {
    throw new Error('--network cannot be combined with --no-network');
  }
  if (args.flags.has('browser') && args.flags.has('no-browser')) {
    throw new Error('--browser cannot be combined with --no-browser');
  }
  const configuredDriver = args.values.get('driver');
  const driver = (configuredDriver ?? 'codex') as AgentDriverName;
  const sandbox = (args.values.get('sandbox') ?? 'read-only') as SandboxMode;
  const capabilities = compact({
    profile: args.values.get('profile'),
    networkAccess: args.flags.has('network')
      ? true
      : args.flags.has('no-network')
        ? false
        : undefined,
    webSearch: args.values.get('web-search'),
    computerUse: args.flags.has('browser')
      ? 'browser'
      : args.flags.has('no-browser')
        ? 'disabled'
        : undefined,
    skills: repeated(args, 'skill'),
    apps: repeated(args, 'app'),
    mcpServers: repeated(args, 'mcp'),
  });
  return compact({
    driver,
    sandbox,
    model: args.values.get('model'),
    reasoningEffort: args.values.get('reasoning-effort'),
    reasoningSummary: args.values.get('reasoning-summary'),
    personality: args.values.get('personality'),
    capabilities: Object.keys(capabilities).length > 0 ? capabilities : undefined,
  });
}

function withIntegrations(args: Arguments): { integrations?: IntegrationAccessRequest } {
  const connectionSet = args.values.get('connection-set');
  const specifications = repeated(args, 'connection') ?? [];
  const allow = connectionOperations(args, 'allow-operation');
  const deny = connectionOperations(args, 'deny-operation');
  const connections = specifications.map((specification): ConnectionAccessRequest => {
    const separator = specification.lastIndexOf('=');
    const rawPreset = separator === -1 ? undefined : specification.slice(separator + 1);
    const hasPreset = rawPreset !== undefined && INTEGRATION_PERMISSION_PRESETS.includes(
      rawPreset as IntegrationPermissionPreset,
    );
    if (rawPreset !== undefined && !hasPreset) {
      throw new Error(`--connection preset ${JSON.stringify(rawPreset)} is invalid`);
    }
    const connection = hasPreset ? specification.slice(0, separator) : specification;
    if (!connection) throw new Error('--connection requires an account alias or ID');
    const allowed = allow.get(connection);
    const denied = deny.get(connection);
    allow.delete(connection);
    deny.delete(connection);
    return {
      connection,
      ...(hasPreset ? { preset: rawPreset as IntegrationPermissionPreset } : {}),
      ...(allowed?.length ? { allowOperations: allowed } : {}),
      ...(denied?.length ? { denyOperations: denied } : {}),
    };
  });
  const undeclared = [...allow.keys(), ...deny.keys()][0];
  if (undeclared) {
    throw new Error(`operation policy refers to undeclared connection ${JSON.stringify(undeclared)}`);
  }
  if (!connectionSet && connections.length === 0) return {};
  return {
    integrations: {
      ...(connectionSet ? { connectionSet } : {}),
      ...(connections.length > 0 ? { connections } : {}),
    },
  };
}

function connectionOperations(
  args: Arguments,
  option: 'allow-operation' | 'deny-operation',
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const value of repeated(args, option) ?? []) {
    const separator = value.indexOf('=');
    if (separator < 1 || separator === value.length - 1) {
      throw new Error(`--${option} must use CONNECTION=PLUGIN.OPERATION[,PLUGIN.OPERATION...]`);
    }
    const connection = value.slice(0, separator);
    const operations = value.slice(separator + 1).split(',').map((operation) => operation.trim());
    if (operations.some((operation) => operation.length === 0)) {
      throw new Error(`--${option} contains an empty operation`);
    }
    result.set(connection, [...(result.get(connection) ?? []), ...operations]);
  }
  return result;
}

function repeated(args: Arguments, name: string): string[] | undefined {
  const values = args.multiple.get(name);
  return values && values.length > 0 ? values : undefined;
}

interface InstalledConnection {
  connection: Record<string, unknown>;
  grant?: Record<string, unknown>;
}

async function installedConnections(): Promise<InstalledConnection[]> {
  const listed = await api('/v1/integrations/connections', 'GET') as { connections?: unknown };
  if (!Array.isArray(listed.connections)) throw new Error('runtime returned an invalid connection list');
  return listed.connections.flatMap((candidate) => {
    if (!isObject(candidate) || !isObject(candidate.connection)) return [];
    return [{
      connection: candidate.connection,
      ...(isObject(candidate.grant) ? { grant: candidate.grant } : {}),
    }];
  });
}

async function waitForOAuth<T>(
  expiresAt: unknown,
  poll: () => Promise<T | undefined>,
  expiredMessage: string,
): Promise<T> {
  const advertisedDeadline = typeof expiresAt === 'string' ? Date.parse(expiresAt) : Number.NaN;
  const deadline = Number.isFinite(advertisedDeadline)
    ? advertisedDeadline
    : Date.now() + 10 * 60 * 1_000;
  while (Date.now() < deadline) {
    const result = await poll();
    if (result !== undefined) return result;
    await delay(2_000);
  }
  throw new Error(expiredMessage);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function api(
  path: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<unknown> {
  const base = process.env.RAT_THINGS_API_URL ?? process.env.AGENT_RUNTIME_API_URL;
  if (!base) throw new Error('RAT_THINGS_API_URL is required for remote commands');
  const url = new URL(path, `${base.replace(/\/$/, '')}/`);
  const encoded = body === undefined ? undefined : JSON.stringify(body);
  const unsignedHeaders: Record<string, string> = {
    host: url.host,
    accept: 'application/json',
    ...(encoded ? { 'content-type': 'application/json' } : {}),
    ...extraHeaders,
  };
  let headers = unsignedHeaders;
  if (process.env.AGENT_RUNTIME_UNSIGNED !== 'true') {
    const region = process.env.AWS_REGION ?? regionFromHostname(url.hostname);
    if (!region) throw new Error('AWS_REGION is required to sign control API requests');
    const [{ Sha256 }, { defaultProvider }, { HttpRequest }, { SignatureV4 }] = await Promise.all([
      import('@aws-crypto/sha256-js'), import('@aws-sdk/credential-provider-node'),
      import('@smithy/protocol-http'), import('@smithy/signature-v4'),
    ]);
    const query = Object.fromEntries(url.searchParams.entries());
    const signer = new SignatureV4({
      credentials: defaultProvider(),
      region,
      service: 'execute-api',
      sha256: Sha256,
    });
    const signed = await signer.sign(new HttpRequest({
      protocol: url.protocol,
      hostname: url.hostname,
      ...(url.port ? { port: Number(url.port) } : {}),
      method,
      path: url.pathname,
      query,
      headers: unsignedHeaders,
      ...(encoded ? { body: encoded } : {}),
    }));
    headers = signed.headers;
  }
  const response = await fetch(url, {
    method,
    headers,
    ...(encoded ? { body: encoded } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  const value = text ? parseResponse(text) : {};
  if (!response.ok) {
    throw new RuntimeApiError(response.status, text);
  }
  return value;
}

class RuntimeApiError extends Error {
  public constructor(public readonly status: number, responseBody: string) {
    super(`runtime API returned HTTP ${status}: ${responseBody.slice(0, 1_000)}`);
    this.name = 'RuntimeApiError';
  }
}

interface DoctorCheck {
  name: string;
  status: 'pass' | 'warning' | 'fail';
  detail: string;
}

async function doctor(args: Arguments): Promise<void> {
  const base = process.env.RAT_THINGS_API_URL ?? process.env.AGENT_RUNTIME_API_URL;
  let validBase = base;
  let inferredRegion: string | undefined;
  if (base) {
    try {
      inferredRegion = regionFromHostname(new URL(base).hostname);
    } catch {
      validBase = undefined;
    }
  }
  const region = process.env.AWS_REGION ?? inferredRegion;
  const checks: DoctorCheck[] = [
    {
      name: 'node',
      status: Number(process.versions.node.split('.')[0]) >= 20 ? 'pass' : 'fail',
      detail: process.version,
    },
    {
      name: 'api-url',
      status: validBase ? 'pass' : base ? 'fail' : 'warning',
      detail: validBase ?? (base
        ? `RAT_THINGS_API_URL is not a valid URL: ${base}`
        : 'RAT_THINGS_API_URL is unset; remote checks skipped'),
    },
    {
      name: 'aws-region',
      status: process.env.AGENT_RUNTIME_UNSIGNED === 'true' || region ? 'pass' : 'warning',
      detail: process.env.AGENT_RUNTIME_UNSIGNED === 'true'
        ? 'unsigned local API mode'
        : region ?? 'set AWS_REGION for non-API-Gateway endpoints',
    },
    { name: 'codex-binary', status: 'pass', detail: process.env.CODEX_BINARY ?? 'codex' },
    { name: 'codex-auth', status: 'pass', detail: process.env.CODEX_AUTH_MODE ?? 'chatgpt' },
  ];
  if (validBase) {
    checks.push(await publicEndpointCheck(validBase, '/health', 'api-health'));
    checks.push(await publicEndpointCheck(validBase, '/.well-known/rat-things', 'discovery'));
    try {
      await api('/v1/capability-profiles', 'GET');
      checks.push({ name: 'authenticated-api', status: 'pass', detail: 'control API authentication works' });
    } catch (error) {
      checks.push({
        name: 'authenticated-api',
        status: 'fail',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (args.flags.has('json')) {
    print({
      version: '1',
      ok: !checks.some((check) => check.status === 'fail'),
      checks,
    });
  } else {
    for (const check of checks) {
      process.stdout.write(`${terminalText(check.status)}\t${terminalText(check.name)}\t${terminalText(check.detail)}\n`);
    }
  }
  if (checks.some((check) => check.status === 'fail')) process.exitCode = 1;
}

async function publicEndpointCheck(base: string, path: string, name: string): Promise<DoctorCheck> {
  try {
    const url = new URL(path, `${base.replace(/\/$/, '')}/`);
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    return response.ok
      ? { name, status: 'pass', detail: `HTTP ${response.status}` }
      : { name, status: 'fail', detail: `HTTP ${response.status}: ${text.slice(0, 300)}` };
  } catch (error) {
    return { name, status: 'fail', detail: error instanceof Error ? error.message : String(error) };
  }
}

function parseArguments(argv: string[]): Arguments {
  const [command = 'help', ...rest] = argv;
  const values = new Map<string, string>();
  const multiple = new Map<string, string[]>();
  const flags = new Set<string>();
  const positionals: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index] as string;
    if (item === '--') {
      positionals.push(...rest.slice(index + 1));
      break;
    }
    if (item === '-h') {
      flags.add('help');
      continue;
    }
    if (!item.startsWith('--')) {
      if (item.startsWith('-')) {
        throw new Error(`unknown option ${JSON.stringify(item)}; use -- before text that starts with a dash`);
      }
      positionals.push(item);
      continue;
    }
    const name = item.slice(2);
    if (!name) throw new Error('use -- only as the end-of-options marker');
    if (booleanOptions.has(name)) {
      flags.add(name);
      continue;
    }
    if (!valueOptions.has(name) && !repeatableOptions.has(name)) {
      throw new Error(`unknown option --${name}; run rat-things help --all`);
    }
    const next = rest[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      if (repeatableOptions.has(name)) {
        multiple.set(name, [...(multiple.get(name) ?? []), next]);
      } else {
        if (values.has(name)) throw new Error(`--${name} may be provided only once`);
        values.set(name, next);
      }
      index += 1;
    } else {
      throw new Error(`--${name} requires a value`);
    }
  }
  return { command, values, multiple, flags, positionals };
}

function normalizeArguments(argv: string[]): string[] {
  const first = argv[0];
  if (!first) return ['help'];
  if (first === '--help' || first === '-h') return ['help', ...argv.slice(1)];
  if (/^(?:things?|routines?)(?:-|$)/.test(first)) throw new Error('Thing and Routine commands were removed. Use agents, sessions, or schedules.');
  if (["chat","handoff","submit","get","cancel","watch","steer","interrupt","respond","computer","conversations","conversation","output","artifact","files","file","publish","list"].includes(first)) throw new Error('This command was removed. Use agents, sessions, files, or publications.');
  if (commands.has(first)) return argv;
  return ['local', ...argv];
}

function validateCommandOptions(
  args: Arguments,
  options: {
    flags?: readonly string[];
    values?: readonly string[];
    multiple?: readonly string[];
  },
): void {
  const allowedFlags = new Set(['help', ...(options.flags ?? [])]);
  const allowedValues = new Set(['api-url', 'region', ...(options.values ?? [])]);
  const allowedMultiple = new Set(options.multiple ?? []);
  for (const flag of args.flags) {
    if (!allowedFlags.has(flag)) throw new Error(`--${flag} is not valid for ${args.command}`);
  }
  for (const name of args.values.keys()) {
    if (!allowedValues.has(name)) throw new Error(`--${name} is not valid for ${args.command}`);
  }
  for (const name of args.multiple.keys()) {
    if (!allowedMultiple.has(name)) throw new Error(`--${name} is not valid for ${args.command}`);
  }
}

function validatePositionals(
  args: Arguments,
  minimum: number,
  maximum: number,
  usage: string,
): void {
  if (args.positionals.length < minimum) throw new Error(`${usage}: missing required argument`);
  if (args.positionals.length > maximum) {
    throw new Error(`${usage}: unexpected argument ${JSON.stringify(args.positionals[maximum])}`);
  }
}

function validateRootPositionals(args: Arguments): void {
  const rules: Record<string, readonly [number, number, string]> = {
    console: [0, 0, 'console'],
    publications: [1, 1, 'publications create --session SESSION_ID --file REQUEST.json'],
    plugins: [0, 0, 'plugins'],
    profiles: [0, 0, 'profiles'],
    connections: [0, 0, 'connections'],
    connection: [2, 3, 'connection show|test|consumers|rename|reconnect ACCOUNT'],
    connect: [1, 1, 'connect PLUGIN'],
    grant: [1, 1, 'grant ACCOUNT --file GRANT.json'],
    rotate: [1, 1, 'rotate ACCOUNT --credential-file CREDENTIAL.json'],
    revoke: [1, 1, 'revoke ACCOUNT'],
    'connection-sets': [0, 0, 'connection-sets'],
    'connection-set': [0, 0, 'connection-set --file SET.json'],
    'source-bindings': [0, 0, 'source-bindings'],
    'bind-source': [0, 0, 'bind-source --file BINDING.json'],
    'slack-events': [1, 1, 'slack-events ACCOUNT --agent-id AGENT_ID [--environment-template TEMPLATE_ID] [--json]'],
    doctor: [0, 0, 'doctor'],
    help: [0, 0, 'help'],
  };
  const rule = rules[args.command];
  if (rule) validatePositionals(args, rule[0], rule[1], rule[2]);
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function validationOptions(): { allowedRepositoryHosts?: string[]; allowedSandboxModes?: SandboxMode[] } {
  const raw = process.env.ALLOWED_REPOSITORY_HOSTS;
  const rawModes = process.env.ALLOWED_SANDBOX_MODES;
  return {
    ...(raw ? { allowedRepositoryHosts: raw.split(',').map((value) => value.trim()).filter(Boolean) } : {}),
    ...(rawModes ? { allowedSandboxModes: rawModes.split(',').map((value) => value.trim()).filter(Boolean) as SandboxMode[] } : {}),
  };
}

function regionConfig(): { region?: string } {
  return process.env.AWS_REGION ? { region: process.env.AWS_REGION } : {};
}

function regionFromHostname(hostname: string): string | undefined {
  return hostname.match(/\.execute-api\.([a-z0-9-]+)\.amazonaws\.com$/)?.[1];
}

function inferProvider(url: string): 'github' | 'gitlab' | 'generic' {
  const host = new URL(url).hostname.toLowerCase();
  if (host === 'github.com') return 'github';
  if (host === 'gitlab.com') return 'gitlab';
  return 'generic';
}

function positiveNumber(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function requiredPositional(args: Arguments, index: number, label: string): string {
  const value = args.positionals[index];
  if (!value) throw new Error(`${label} is required`);
  return value;
}

function positionalPath(args: Arguments, index: number, label: string): string {
  return encodeURIComponent(requiredPositional(args, index, label));
}

function parseResponse(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function help(showAll: boolean): void {
  process.stdout.write('Rat Things\n\n');
  process.stdout.write('  rat-things agents create|list|get|update|delete [ID] [--file REQUEST.json]\n');
  process.stdout.write('  rat-things sessions create|list|get|send|cancel|items|turns|artifacts|delete [ID]\n');
  process.stdout.write('  rat-things environments get|connect|templates [ID]\n');
  process.stdout.write('  rat-things vaults create|list|get|delete|credentials [ID]\n');
  process.stdout.write('  rat-things files create|list|get|delete|content [ID]\n');
  process.stdout.write('  rat-things publications create --session SESSION_ID --file REQUEST.json\n');
  process.stdout.write('  rat-things schedules list|get|create|update|delete|pause|resume [ID] [--file REQUEST.json]\n');
  process.stdout.write('  rat-things console\n  rat-things doctor\n');
  process.stdout.write('  rat-things local [--driver codex|mock] [--model MODEL] "Work on this computer" [--trace-output trace.otlp.json]\n');
  process.stdout.write('\nUnqualified prompts run locally. Use sessions for durable work in AWS.\n');
  process.stdout.write('Set RAT_THINGS_AGENTS_API_URL for standard resources; RAT_THINGS_API_URL for publications, schedules, and connections.\n');
  if (!showAll) return;
  process.stdout.write(`\nIntegrations\n\n`);
  process.stdout.write(`  rat-things plugins\n`);
  process.stdout.write(`  rat-things profiles\n`);
  process.stdout.write(`  rat-things connections\n`);
  process.stdout.write(`  rat-things connection show ACCOUNT\n`);
  process.stdout.write(`  rat-things connection reconnect ACCOUNT --oauth --wait\n`);
  process.stdout.write(`  rat-things connection test ACCOUNT\n`);
  process.stdout.write(`  rat-things connection consumers ACCOUNT\n`);
  process.stdout.write(`  rat-things connection rename ACCOUNT --name NAME\n`);
  process.stdout.write(`  rat-things connect PLUGIN --oauth [--wait] [--no-browser]\n`);
  process.stdout.write(`  rat-things connect PLUGIN --credential-file CREDENTIAL.json\n`);
  process.stdout.write(`    [--auth-scheme SCHEME] [--access read-only|read-write|full] [--alias NAME]\n`);
  process.stdout.write(`  rat-things grant ACCOUNT --file GRANT.json\n`);
  process.stdout.write(`  rat-things rotate ACCOUNT --credential-file CREDENTIAL.json\n`);
  process.stdout.write(`  rat-things revoke ACCOUNT\n`);
  process.stdout.write(`  rat-things connection-sets\n`);
  process.stdout.write(`  rat-things connection-set --file SET.json\n`);
  process.stdout.write(`  rat-things source-bindings\n`);
  process.stdout.write(`  rat-things bind-source --file BINDING.json\n`);
  process.stdout.write(`  rat-things slack-events ACCOUNT --agent-id AGENT_ID [--environment-template TEMPLATE_ID] [--json]\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${terminalText(error instanceof Error ? error.message : String(error))}\n`);
  process.exitCode = 1;
});

async function schedulesCommand(args: Arguments): Promise<void> {
  const operation = requiredPositional(args, 0, 'schedule operation');
  if (!['list', 'get', 'create', 'update', 'delete', 'pause', 'resume'].includes(operation)) throw new Error('schedules requires list, get, create, update, delete, pause, or resume');
  const collection = operation === 'list' || operation === 'create';
  validatePositionals(args, collection ? 1 : 2, collection ? 1 : 2, `schedules ${operation}${collection ? '' : ' ID'}`);
  validateCommandOptions(args, { flags: ['json'], values: operation === 'create' || operation === 'update' ? ['file'] : operation === 'list' ? ['limit'] : [] });
  const path = collection ? '/v1/schedules' : `/v1/schedules/${encodeURIComponent(requiredPositional(args, 1, 'schedule ID'))}${operation === 'pause' || operation === 'resume' ? `/${operation}` : ''}`;
  const method = operation === 'list' || operation === 'get' ? 'GET' : operation === 'update' ? 'PUT' : operation === 'delete' ? 'DELETE' : 'POST';
  print(await api(path + (operation === 'list' && args.values.has('limit') ? `?limit=${encodeURIComponent(args.values.get('limit')!)}` : ''), method, operation === 'create' || operation === 'update' ? await requiredJsonFile(args) : undefined));
}

async function publicationsCommand(args: Arguments): Promise<void> {
  if (args.positionals[0] !== 'create') throw new Error('Use publications create --session SESSION_ID --file REQUEST.json');
  validateCommandOptions(args, { values: ['session', 'file'], flags: ['json'] });
  const session = args.values.get('session');
  if (!session || !/^sess_[A-Za-z0-9_-]+$/.test(session)) throw new Error('--session requires a Session ID');
  const request = sessionPublicationRequest(await requiredJsonFile(args));
  print(await api(`/v1/sessions/${encodeURIComponent(session)}/publications`, 'POST', request));
}
