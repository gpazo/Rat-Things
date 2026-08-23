#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Sha256 } from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';
import { CachedSecretReader } from './adapters/aws-runtime.js';
import { fetchSharedResource } from './adapters/publication-client.js';
import { CredentialBroker } from './credentials/broker.js';
import type {
  AgentDriverName,
  RunRecord,
  RunRequest,
  SandboxMode,
} from './domain/contracts.js';
import type {
  ConnectionAccessRequest,
  IntegrationAuthScheme,
  IntegrationAccessRequest,
  IntegrationPermissionPreset,
} from './domain/capabilities.js';
import { INTEGRATION_PERMISSION_PRESETS } from './domain/capabilities.js';
import type { IntegrationPluginManifest } from './plugins/integration-types.js';
import type { AgentRuntimeSnapshot } from './domain/interaction.js';
import { isTerminal } from './domain/state.js';
import { parseRunRequest } from './domain/validation.js';
import {
  CapabilityProfileRegistry,
  createBuiltinCapabilityProfiles,
  resolveAgentProfile,
} from './plugins/capability-profiles.js';
import { driverFor } from './runner/agent-driver.js';
import { loadCodexBedrockToken } from './runner/bedrock-auth.js';
import { codexAuthMode, localCodexAuthMode } from './runner/codex-auth.js';
import { localArtifactPaths, prepareArtifactDirectory } from './runner/artifacts.js';
import { collectWorkspacePatch, prepareWorkspace } from './runner/workspace.js';

interface Arguments {
  command: string;
  values: Map<string, string>;
  multiple: Map<string, string[]>;
  flags: Set<string>;
  positionals: string[];
}

interface ConversationMessageReceipt {
  conversationId: string;
  messageId: string;
  status: 'appended' | 'duplicate';
}

interface ConversationMessageStatus {
  conversationId: string;
  messageId: string;
  state: 'pending' | 'consumed' | 'dead_letter';
  conversation: {
    status: 'idle' | 'pending' | 'running' | 'awaiting_resume' | 'failed';
    pendingCount: number;
    session?: { id: string; state: 'running' | 'suspended' | 'unknown' };
  };
  run?: RunRecord;
}

interface ArtifactMetadata {
  id: string;
  path: string;
  mediaType: string;
  bytes: number;
  createdAt: string;
  sourceRunId: string;
  sha256: string;
}

interface ArtifactDescriptor extends ArtifactMetadata {
  url: string;
  expiresAt: string;
  primaryPath?: string;
  paths?: string[];
}

const commands = new Set([
  'local',
  'chat',
  'submit',
  'get',
  'cancel',
  'watch',
  'steer',
  'interrupt',
  'approve',
  'respond',
  'plugins',
  'profiles',
  'connections',
  'connect',
  'grant',
  'rotate',
  'revoke',
  'connection-sets',
  'connection-set',
  'source-bindings',
  'bind-source',
  'things',
  'thing',
  'thing-create',
  'thing-update',
  'thing-version',
  'thing-versions',
  'thing-test',
  'thing-publish',
  'thing-run',
  'thing-pause',
  'thing-resume',
  'thing-archive',
  'thing-explain',
  'routines',
  'routine',
  'routine-create',
  'routine-run',
  'routine-pause',
  'routine-resume',
  'routine-delete',
  'output',
  'artifact',
  'files',
  'file',
  'publish',
  'list',
  'doctor',
  'help',
]);

const booleanOptions = new Set([
  'all',
  'events',
  'follow',
  'help',
  'json',
  'browser',
  'network',
  'new',
  'no-browser',
  'no-network',
  'no-wait',
  'output',
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

async function main(): Promise<void> {
  const args = parseArguments(normalizeArguments(process.argv.slice(2)));
  if (args.values.has('api-url')) {
    process.env.RAT_THINGS_API_URL = args.values.get('api-url');
  }
  if (args.values.has('region')) process.env.AWS_REGION = args.values.get('region');
  if (args.flags.has('help')) {
    help(args.flags.has('all'));
    return;
  }
  switch (args.command) {
    case 'local':
      await local(args);
      return;
    case 'chat':
      await chat(args);
      return;
    case 'submit':
      await submit(args);
      return;
    case 'get':
      print(await api(`/v1/runs/${requiredPositional(args, 0, 'run ID')}`, 'GET'));
      return;
    case 'cancel':
      print(await api(`/v1/runs/${requiredPositional(args, 0, 'run ID')}/cancel`, 'POST'));
      return;
    case 'watch':
      await watch(args);
      return;
    case 'steer':
      await steer(args);
      return;
    case 'interrupt':
      print(await api(
        `/v1/runs/${encodeURIComponent(requiredPositional(args, 0, 'run ID'))}/interrupt`,
        'POST',
        {},
      ));
      return;
    case 'approve':
      await approve(args);
      return;
    case 'respond':
      await respond(args);
      return;
    case 'plugins':
      print(await api('/v1/integrations/plugins', 'GET'));
      return;
    case 'profiles':
      print(await api('/v1/capability-profiles', 'GET'));
      return;
    case 'connections':
      print(await api('/v1/integrations/connections', 'GET'));
      return;
    case 'connect':
      await connect(args);
      return;
    case 'grant':
      print(await api(
        `/v1/integrations/connections/${encodeURIComponent(requiredPositional(args, 0, 'connection ID or alias'))}/grant`,
        'POST',
        await requiredJsonFile(args),
      ));
      return;
    case 'rotate':
      await rotateCredential(args);
      return;
    case 'revoke':
      print(await api(
        `/v1/integrations/connections/${encodeURIComponent(requiredPositional(args, 0, 'connection ID or alias'))}/revoke`,
        'POST',
        {},
      ));
      return;
    case 'connection-sets':
      print(await api('/v1/integrations/connection-sets', 'GET'));
      return;
    case 'connection-set':
      print(await api('/v1/integrations/connection-sets', 'POST', await requiredJsonFile(args)));
      return;
    case 'source-bindings':
      print(await api('/v1/integrations/source-bindings', 'GET'));
      return;
    case 'bind-source':
      print(await api('/v1/integrations/source-bindings', 'POST', await requiredJsonFile(args)));
      return;
    case 'things': {
      const query = new URLSearchParams();
      if (args.values.get('limit')) query.set('limit', args.values.get('limit') as string);
      if (args.values.get('next-token')) query.set('nextToken', args.values.get('next-token') as string);
      if (args.flags.has('all')) query.set('includeArchived', 'true');
      print(await api(`/v1/things${query.size > 0 ? `?${query.toString()}` : ''}`, 'GET'));
      return;
    }
    case 'thing':
      print(await api(
        `/v1/things/${encodeURIComponent(requiredPositional(args, 0, 'Thing ID'))}`,
        'GET',
      ));
      return;
    case 'thing-create':
      print(await api('/v1/things', 'POST', await requiredJsonFile(args)));
      return;
    case 'thing-update': {
      const thingId = encodeURIComponent(requiredPositional(args, 0, 'Thing ID'));
      const current = await api(`/v1/things/${thingId}`, 'GET');
      print(await api(
        `/v1/things/${thingId}/versions`,
        'POST',
        {
          version: '1',
          expectedDraftRevision: thingDraftRevision(current),
          spec: await requiredJsonFile(args),
        },
      ));
      return;
    }
    case 'thing-version':
      print(await api(
        `/v1/things/${encodeURIComponent(requiredPositional(args, 0, 'Thing ID'))}/versions/${encodeURIComponent(requiredPositional(args, 1, 'revision'))}`,
        'GET',
      ));
      return;
    case 'thing-versions':
      print(await api(
        `/v1/things/${encodeURIComponent(requiredPositional(args, 0, 'Thing ID'))}/versions`,
        'GET',
      ));
      return;
    case 'thing-explain':
      {
        const target = args.values.get('target');
        if (target && target !== 'draft' && target !== 'active') {
          throw new Error('--target must be draft or active');
        }
      print(await api(
        `/v1/things/${encodeURIComponent(requiredPositional(args, 0, 'Thing ID'))}/explain${target ? `?target=${target}` : ''}`,
        'GET',
      ));
      return;
      }
    case 'thing-test':
    case 'thing-run': {
      const headers: Record<string, string> = {};
      const key = args.values.get('idempotency-key');
      if (key) headers['idempotency-key'] = key;
      print(await api(
        `/v1/things/${encodeURIComponent(requiredPositional(args, 0, 'Thing ID'))}/${args.command === 'thing-test' ? 'test' : 'run'}`,
        'POST',
        {},
        headers,
      ));
      return;
    }
    case 'thing-publish': {
      const thingId = encodeURIComponent(requiredPositional(args, 0, 'Thing ID'));
      const current = await api(`/v1/things/${thingId}`, 'GET');
      print(await api(
        `/v1/things/${thingId}/publish`,
        'POST',
        { version: '1', expectedDraftRevision: thingDraftRevision(current) },
      ));
      return;
    }
    case 'thing-pause':
    case 'thing-resume':
    case 'thing-archive': {
      const operation = args.command.slice('thing-'.length);
      print(await api(
        `/v1/things/${encodeURIComponent(requiredPositional(args, 0, 'Thing ID'))}/${operation}`,
        'POST',
        {},
      ));
      return;
    }
    case 'routines': {
      const query = new URLSearchParams();
      if (args.values.get('limit')) query.set('limit', args.values.get('limit') as string);
      if (args.values.get('next-token')) query.set('nextToken', args.values.get('next-token') as string);
      print(await api(`/v1/routines${query.size > 0 ? `?${query.toString()}` : ''}`, 'GET'));
      return;
    }
    case 'routine':
      print(await api(
        `/v1/routines/${encodeURIComponent(requiredPositional(args, 0, 'routine ID'))}`,
        'GET',
      ));
      return;
    case 'routine-create':
      print(await api('/v1/routines', 'POST', await requiredJsonFile(args)));
      return;
    case 'routine-run': {
      const headers: Record<string, string> = {};
      const key = args.values.get('idempotency-key');
      if (key) headers['idempotency-key'] = key;
      print(await api(
        `/v1/routines/${encodeURIComponent(requiredPositional(args, 0, 'routine ID'))}/run`,
        'POST',
        {},
        headers,
      ));
      return;
    }
    case 'routine-pause':
    case 'routine-resume':
    case 'routine-delete': {
      const operation = args.command.slice('routine-'.length);
      print(await api(
        `/v1/routines/${encodeURIComponent(requiredPositional(args, 0, 'routine ID'))}/${operation}`,
        'POST',
        {},
      ));
      return;
    }
    case 'output':
      await writeArtifact(requiredPositional(args, 0, 'run ID'), 'output');
      return;
    case 'artifact':
      await writeArtifact(
        requiredPositional(args, 0, 'run ID'),
        requiredPositional(args, 1, 'artifact name'),
      );
      return;
    case 'files':
      await listFiles(args);
      return;
    case 'file':
      await file(args);
      return;
    case 'publish':
      await publish(args);
      return;
    case 'list': {
      const query = new URLSearchParams();
      if (args.values.get('limit')) query.set('limit', args.values.get('limit') as string);
      if (args.values.get('next-token')) query.set('nextToken', args.values.get('next-token') as string);
      print(await api(`/v1/runs${query.size > 0 ? `?${query.toString()}` : ''}`, 'GET'));
      return;
    }
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

async function chat(args: Arguments): Promise<void> {
  if (args.flags.has('new') && (args.values.has('thread') || args.values.has('conversation'))) {
    throw new Error('--new cannot be combined with --thread or --conversation');
  }
  const conversationId = args.flags.has('new')
    ? `thread-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`
    : args.values.get('thread') ?? args.values.get('conversation') ?? 'main';
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(conversationId)) {
    throw new Error('thread must be 1-128 safe ASCII characters');
  }
  if (args.flags.has('new')) process.stderr.write(`thread=${conversationId}\n`);
  const messageId = args.values.get('idempotency-key') ?? randomUUID();
  const encodedConversation = encodeURIComponent(conversationId);
  const receipt = await api(
    `/v1/conversations/${encodedConversation}/messages`,
    'POST',
    await conversationRequestFromArguments(args),
    { 'idempotency-key': messageId },
  ) as ConversationMessageReceipt;
  if (args.flags.has('no-wait')) {
    print(receipt);
    return;
  }

  const interval = positiveNumber(args.values.get('poll-seconds') ?? '2', 'poll-seconds');
  const waitSeconds = positiveNumber(
    args.values.get('wait-timeout') ?? '2400',
    'wait-timeout',
  );
  const deadline = Date.now() + waitSeconds * 1_000;
  const statusPath = `/v1/conversations/${encodedConversation}/messages/${encodeURIComponent(receipt.messageId)}`;
  let lastProgress = '';
  while (Date.now() < deadline) {
    const current = await api(statusPath, 'GET') as ConversationMessageStatus;
    const progress = [
      `message=${current.state}`,
      `conversation=${current.conversation.status}`,
      current.run ? `run=${current.run.status}` : 'run=unscheduled',
      current.conversation.session ? `microvm=${current.conversation.session.state}` : undefined,
    ].filter(Boolean).join(' ');
    if (progress !== lastProgress) {
      process.stderr.write(`${progress}\n`);
      lastProgress = progress;
    }
    if (current.state === 'dead_letter') {
      throw new Error(`conversation message ${receipt.messageId} was dead-lettered`);
    }
    if (current.run && isTerminal(current.run.status)) {
      if (current.run.status !== 'succeeded') {
        print(current.run);
        process.exitCode = 1;
        return;
      }
      const completed = current.conversation.status === 'idle' &&
        current.conversation.pendingCount === 0 &&
        current.conversation.session?.state === 'suspended';
      if (completed) {
        if (args.flags.has('json')) print(current);
        else {
          await writeArtifact(current.run.runId, 'output');
        }
        return;
      }
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, interval * 1_000));
  }
  throw new Error(
    `conversation message ${receipt.messageId} did not complete within ${waitSeconds} seconds`,
  );
}

async function local(args: Arguments): Promise<void> {
  const requestedAuthMode = args.values.get('codex-auth');
  const parsed = await requestFromArguments(args, true);
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
    const result = await driverFor(driverName).execute(request, workspace, timeout);
    process.stdout.write(`${result.fullText}\n`);
    if (driverName === 'codex') {
      const paths = await localArtifactPaths(workspace);
      if (paths.length > 0) {
        process.stderr.write('\nFiles:\n');
        for (const path of paths) {
          process.stderr.write(`  ${path}\t${resolve(workspace, '.rat-things/artifacts', path)}\n`);
        }
      }
    }
    if (args.flags.has('events')) {
      process.stderr.write(`\n--- events.jsonl ---\n${result.events.toString('utf8')}`);
    }
    if (args.flags.has('patch')) {
      const patch = await collectWorkspacePatch(workspace);
      if (patch) process.stderr.write(`\n--- workspace.patch ---\n${patch.toString('utf8')}\n`);
    }
  } finally {
    if (loadedBedrockToken) delete process.env.AWS_BEARER_TOKEN_BEDROCK;
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}

async function submit(args: Arguments): Promise<void> {
  const request = await requestFromArguments(args, false);
  const headers: Record<string, string> = {};
  const key = args.values.get('idempotency-key');
  if (key) headers['idempotency-key'] = key;
  const record = await api('/v1/runs', 'POST', request, headers) as RunRecord;
  if (!args.flags.has('wait')) {
    print(record);
    return;
  }
  const interval = positiveNumber(args.values.get('poll-seconds') ?? '2', 'poll-seconds');
  let current = record;
  while (!isTerminal(current.status)) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, interval * 1_000));
    current = await api(`/v1/runs/${record.runId}`, 'GET') as RunRecord;
    process.stderr.write(`run ${current.runId}: ${current.status}\n`);
  }
  print(current);
  if (current.status === 'succeeded' && args.flags.has('output')) {
    await writeArtifact(current.runId, 'output');
  }
  if (current.status !== 'succeeded') process.exitCode = 1;
}

async function watch(args: Arguments): Promise<void> {
  const runId = requiredPositional(args, 0, 'run ID');
  let after = nonNegativeNumber(args.values.get('after') ?? '0', 'after');
  const interval = positiveNumber(args.values.get('poll-seconds') ?? '1', 'poll-seconds');
  while (true) {
    const query = new URLSearchParams({ after: String(after), limit: '100' });
    const snapshot = await api(
      `/v1/runs/${encodeURIComponent(runId)}/events?${query}`,
      'GET',
    ) as AgentRuntimeSnapshot;
    if (args.flags.has('json')) print(snapshot);
    else {
      for (const event of snapshot.events) {
        process.stdout.write(`${JSON.stringify(event)}\n`);
      }
      for (const pending of snapshot.pendingRequests) {
        process.stderr.write(
          `approval pending: ${pending.requestId} ${pending.method}\n`,
        );
      }
    }
    const last = snapshot.events.at(-1);
    if (last) after = last.sequence;
    if (!args.flags.has('follow')) return;
    const run = await api(`/v1/runs/${encodeURIComponent(runId)}`, 'GET') as RunRecord;
    if (isTerminal(run.status)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, interval * 1_000));
  }
}

async function steer(args: Arguments): Promise<void> {
  const runId = requiredPositional(args, 0, 'run ID');
  const prompt = args.values.get('prompt') ?? args.positionals.slice(1).join(' ');
  if (!prompt.trim()) throw new Error('steer prompt is required');
  print(await api(
    `/v1/runs/${encodeURIComponent(runId)}/steer`,
    'POST',
    { prompt },
  ));
}

async function approve(args: Arguments): Promise<void> {
  const runId = requiredPositional(args, 0, 'run ID');
  const requestId = requiredPositional(args, 1, 'approval request ID');
  const decision = args.values.get('decision') ?? 'accept';
  print(await api(
    `/v1/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(requestId)}`,
    'POST',
    compact({ decision, reason: args.values.get('reason') }),
  ));
}

async function respond(args: Arguments): Promise<void> {
  const runId = requiredPositional(args, 0, 'run ID');
  const requestId = requiredPositional(args, 1, 'server request ID');
  const raw = args.values.get('result');
  if (raw === undefined) throw new Error('--result requires a JSON value');
  let result: unknown;
  try {
    result = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('--result must be valid JSON');
  }
  print(await api(
    `/v1/runs/${encodeURIComponent(runId)}/requests/${encodeURIComponent(requestId)}/respond`,
    'POST',
    { result },
  ));
}

async function requiredJsonFile(args: Arguments): Promise<unknown> {
  const path = args.values.get('file');
  if (!path) throw new Error('--file JSON is required; credentials are not accepted on the command line');
  try {
    return JSON.parse(await readFile(resolve(path), 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`could not read JSON file: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function connect(args: Arguments): Promise<void> {
  const pluginId = requiredPositional(args, 0, 'plugin ID');
  const plugin = await installedIntegrationPlugin(pluginId);
  const requestedScheme = args.values.get('auth-scheme');
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
  const credential = await credentialFile(args, authentication.fields);
  const access = args.values.get('access') ?? 'read-only';
  if (!['read-only', 'read-write', 'full'].includes(access)) {
    throw new Error('--access must be read-only, read-write, or full');
  }
  print(await api('/v1/integrations/connections', 'POST', {
    version: '1',
    pluginId,
    ...(args.values.get('alias') ? { alias: args.values.get('alias') } : {}),
    authScheme: authentication.scheme as IntegrationAuthScheme,
    credential,
    grant: { version: '1', preset: access },
  }));
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
  const listed = await api('/v1/integrations/connections', 'GET') as { connections?: unknown };
  if (!Array.isArray(listed.connections)) throw new Error('runtime returned an invalid connection list');
  const record = (listed.connections as Array<{ connection?: unknown }>).find((candidate) => {
    const connection = candidate.connection;
    if (!connection || typeof connection !== 'object' || Array.isArray(connection)) return false;
    const value = connection as Record<string, unknown>;
    return value.connectionId === selector || value.alias === selector;
  });
  if (!record?.connection || typeof record.connection !== 'object' || Array.isArray(record.connection)) {
    throw new Error(`integration connection ${selector} was not found`);
  }
  const connection = record.connection as Record<string, unknown>;
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
    if (typeof value !== 'string' || !value) {
      throw new Error(`credential file requires non-empty string field ${field.key}`);
    }
    result[field.key] = value;
  }
  for (const key of Object.keys(parsed)) {
    if (!expected.has(key)) throw new Error(`credential field ${key} is not used by ${args.positionals[0]}`);
  }
  return result;
}

async function writeArtifact(runId: string, name: string): Promise<void> {
  if (!['input', 'output', 'events', 'patch'].includes(name)) {
    throw new Error('artifact name must be input, output, events, or patch');
  }
  const descriptor = await api(`/v1/runs/${runId}/artifacts/${name}`, 'GET') as {
    url?: unknown;
    primaryPath?: string;
    paths?: string[];
  };
  if (typeof descriptor.url !== 'string') throw new Error('runtime returned no artifact URL');
  const response = await fetchSharedResource(
    descriptor.url,
    30_000,
    publicationAssetPath(descriptor),
  );
  if (!response.ok) throw new Error(`artifact download returned HTTP ${response.status}`);
  process.stdout.write(await response.text());
  if (name === 'output') process.stdout.write('\n');
}

async function listFiles(args: Arguments): Promise<void> {
  const scope = artifactScope(args);
  const files = await artifactList(scope);
  if (args.flags.has('json')) {
    print({ scope, files });
    return;
  }
  if (files.length === 0) {
    process.stdout.write('No files.\n');
    return;
  }
  for (const file of files) {
    process.stdout.write(`${file.path}\t${file.mediaType}\t${file.bytes}\t${file.id}\n`);
  }
}

async function file(args: Arguments): Promise<void> {
  const name = requiredPositional(args, 0, 'file name or ID');
  const scope = artifactScope(args);
  const files = await artifactList(scope);
  const matches = files.filter((candidate) => (
    candidate.id === name ||
    candidate.path === name ||
    candidate.path.split('/').at(-1) === name
  ));
  if (matches.length === 0) throw new Error(`file ${JSON.stringify(name)} was not found`);
  if (matches.length > 1) {
    throw new Error(`file name ${JSON.stringify(name)} is ambiguous; use its path or ID`);
  }
  const descriptor = await artifactDescriptorFor(scope, matches[0]!.id);
  const destination = args.values.get('download');
  if (!destination) {
    if (args.flags.has('json')) print(descriptor);
    else process.stdout.write(`${descriptor.url}\n`);
    return;
  }
  const response = await fetchSharedResource(
    descriptor.url,
    120_000,
    publicationAssetPath(descriptor),
  );
  if (!response.ok) throw new Error(`file download returned HTTP ${response.status}`);
  const target = resolve(destination);
  await writeFile(target, Buffer.from(await response.arrayBuffer()));
  process.stdout.write(`${target}\n`);
}

async function publish(args: Arguments): Promise<void> {
  const kind = requiredPositional(args, 0, 'publication kind');
  if (!['file', 'site', 'video'].includes(kind)) {
    throw new Error('publication kind must be file, site, or video');
  }
  const source = requiredPositional(args, 1, kind === 'site' ? 'site root' : 'file name');
  const title = args.values.get('title');
  const spec = kind === 'site'
    ? {
        version: '1',
        kind,
        ...(source === '.' ? {} : { root: source }),
        ...(args.values.get('entrypoint') ? { entrypoint: args.values.get('entrypoint') } : {}),
        ...(title ? { title } : {}),
      }
    : kind === 'video'
      ? {
          version: '1',
          kind,
          path: source,
          ...(args.values.get('poster') ? { poster: args.values.get('poster') } : {}),
          ...(title ? { title } : {}),
        }
      : { version: '1', kind, path: source, ...(title ? { title } : {}) };
  const scope = artifactScope(args);
  const descriptor = await api(`${artifactBasePath(scope)}/publications`, 'POST', spec);
  if (args.flags.has('json')) print(descriptor);
  else process.stdout.write(`${(descriptor as { url: string }).url}\n`);
}

function publicationAssetPath(descriptor: {
  primaryPath?: string;
  paths?: string[];
}): string | undefined {
  return descriptor.primaryPath ?? descriptor.paths?.find((path) => path !== 'index.html');
}

type ArtifactScope = { kind: 'run' | 'conversation'; id: string };

function artifactScope(args: Arguments): ArtifactScope {
  const runId = args.values.get('run');
  const thread = args.values.get('thread') ?? args.values.get('conversation');
  if (runId && thread) throw new Error('--run cannot be combined with --thread or --conversation');
  if (runId) return { kind: 'run', id: runId };
  const conversationId = thread ?? 'main';
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(conversationId)) {
    throw new Error('thread must be 1-128 safe ASCII characters');
  }
  return { kind: 'conversation', id: conversationId };
}

async function artifactList(scope: ArtifactScope): Promise<ArtifactMetadata[]> {
  const result = await api(`${artifactBasePath(scope)}/artifacts`, 'GET') as { files?: unknown };
  if (!Array.isArray(result.files)) throw new Error('runtime returned an invalid file list');
  return result.files as ArtifactMetadata[];
}

async function artifactDescriptorFor(
  scope: ArtifactScope,
  id: string,
): Promise<ArtifactDescriptor> {
  const result = await api(
    `${artifactBasePath(scope)}/artifacts/${encodeURIComponent(id)}`,
    'GET',
  );
  if (!result || typeof result !== 'object' || typeof (result as { url?: unknown }).url !== 'string') {
    throw new Error('runtime returned no file URL');
  }
  return result as ArtifactDescriptor;
}

function artifactBasePath(scope: ArtifactScope): string {
  return scope.kind === 'run'
    ? `/v1/runs/${encodeURIComponent(scope.id)}`
    : `/v1/conversations/${encodeURIComponent(scope.id)}`;
}

async function requestFromArguments(args: Arguments, localMode: boolean): Promise<RunRequest> {
  const file = args.values.get('file');
  if (file) return parseRunRequest(JSON.parse(await readFile(resolve(file), 'utf8')) as unknown, validationOptions());
  const prompt = args.values.get('prompt') ?? args.positionals.join(' ');
  if (!prompt) throw new Error('provide --prompt TEXT or --file REQUEST.json');
  const request: Record<string, unknown> = {
    version: '1',
    prompt,
    agent: agentFromArguments(args, localMode),
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

async function conversationRequestFromArguments(args: Arguments): Promise<unknown> {
  const file = args.values.get('file');
  if (file) return JSON.parse(await readFile(resolve(file), 'utf8')) as unknown;
  const prompt = args.values.get('prompt') ?? args.positionals.join(' ');
  if (!prompt) throw new Error('provide --prompt TEXT, positional prompt text, or --file REQUEST.json');
  return {
    version: '1',
    prompt,
    agent: agentFromArguments(args, false),
    ...withIntegrations(args),
  };
}

function agentFromArguments(args: Arguments, localMode: boolean): Record<string, unknown> {
  if (args.flags.has('network') && args.flags.has('no-network')) {
    throw new Error('--network cannot be combined with --no-network');
  }
  if (args.flags.has('browser') && args.flags.has('no-browser')) {
    throw new Error('--browser cannot be combined with --no-browser');
  }
  const configuredDriver = args.values.get('driver');
  const driver = (configuredDriver ?? (localMode ? 'codex' : undefined)) as AgentDriverName | undefined;
  const sandbox = (args.values.get('sandbox') ?? (localMode ? 'read-only' : undefined)) as
    SandboxMode | undefined;
  const capabilities = compact({
    profile: args.values.get('profile'),
    approvalPolicy: args.values.get('approval-policy') ?? args.values.get('approval'),
    approvalsReviewer: args.values.get('approval-reviewer'),
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
      throw new Error(`--${option} must use CONNECTION=PLUGIN.OPERATION`);
    }
    const connection = value.slice(0, separator);
    const operation = value.slice(separator + 1);
    result.set(connection, [...(result.get(connection) ?? []), operation]);
  }
  return result;
}

function repeated(args: Arguments, name: string): string[] | undefined {
  const values = args.multiple.get(name);
  return values && values.length > 0 ? values : undefined;
}

async function api(
  path: string,
  method: 'GET' | 'POST',
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
    throw new Error(`runtime API returned HTTP ${response.status}: ${text.slice(0, 1_000)}`);
  }
  return value;
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
    { name: 'codex-auth', status: 'pass', detail: process.env.CODEX_AUTH_MODE ?? 'bedrock' },
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
      process.stdout.write(`${check.status}\t${check.name}\t${check.detail}\n`);
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
    if (!item.startsWith('--')) {
      positionals.push(item);
      continue;
    }
    const name = item.slice(2);
    if (booleanOptions.has(name)) {
      flags.add(name);
      continue;
    }
    const next = rest[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      if (repeatableOptions.has(name)) {
        multiple.set(name, [...(multiple.get(name) ?? []), next]);
      } else {
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
  if (commands.has(first)) return argv;
  return ['chat', ...argv];
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

function nonNegativeNumber(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return parsed;
}

function requiredPositional(args: Arguments, index: number, label: string): string {
  const value = args.positionals[index];
  if (!value) throw new Error(`${label} is required`);
  return value;
}

function thingDraftRevision(value: unknown): number {
  if (
    !value ||
    typeof value !== 'object' ||
    !('draft' in value) ||
    !value.draft ||
    typeof value.draft !== 'object' ||
    !('revision' in value.draft) ||
    typeof value.draft.revision !== 'number' ||
    !Number.isSafeInteger(value.draft.revision) ||
    value.draft.revision < 1
  ) {
    throw new Error('Thing response does not contain a valid draft revision');
  }
  return value.draft.revision;
}

function parseResponse(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function help(showAll: boolean): void {
  process.stdout.write(`Rat Things\n\n`);
  process.stdout.write(`  rat-things \"Ask Rat Things to do something\"\n`);
  process.stdout.write(`  rat-things --thread NAME \"Continue a named thread\"\n`);
  process.stdout.write(`  rat-things --new \"Start a fresh thread\"\n`);
  process.stdout.write(`  rat-things local \"Run on this computer\"\n`);
  process.stdout.write(`  rat-things files [--thread NAME]\n`);
  process.stdout.write(`  rat-things file NAME [--thread NAME]\n`);
  process.stdout.write(`  rat-things publish file|site|video PATH [--thread NAME]\n`);
  process.stdout.write(`\nRepeat a thread name to continue the same Codex thread.\n`);
  process.stdout.write(`Run rat-things help --all for agent and automation options.\n`);
  if (!showAll) return;
  process.stdout.write(`\nAgent and automation options\n\n`);
  process.stdout.write(`  rat-things chat [--thread NAME] [--driver codex] [--model ID]\n`);
  process.stdout.write(`    [--sandbox MODE] [--reasoning-effort LEVEL] [--reasoning-summary MODE]\n`);
  process.stdout.write(`    [--profile NAME] [--approval-policy POLICY] [--approval-reviewer REVIEWER]\n`);
  process.stdout.write(`    [--network|--no-network] [--web-search MODE] [--browser|--no-browser]\n`);
  process.stdout.write(`    [--skill NAME]... [--app NAME]... [--mcp NAME]...\n`);
  process.stdout.write(`    [--connection-set NAME] [--connection ACCOUNT[=PRESET]]...\n`);
  process.stdout.write(`    [--allow-operation ACCOUNT=PLUGIN.OP]... [--deny-operation ACCOUNT=PLUGIN.OP]...\n`);
  process.stdout.write(`    [--json] [--no-wait]\n`);
  process.stdout.write(`    [--idempotency-key KEY] [--poll-seconds N] [--wait-timeout N] \"...\"\n`);
  process.stdout.write(`  --api-url URL and --region REGION override RAT_THINGS_API_URL and AWS_REGION\n`);
  process.stdout.write(`\nLocal execution\n\n`);
  process.stdout.write(`  rat-things local [--sandbox MODE] [--network] [--events] \"...\"\n`);
  process.stdout.write(`    defaults to Codex with the device's cached ChatGPT login; use --driver mock for tests\n`);
  process.stdout.write(`\nRun management\n\n`);
  process.stdout.write(`  rat-things submit --file examples/run-request.json [--wait]\n`);
  process.stdout.write(`  rat-things get RUN_ID\n`);
  process.stdout.write(`  rat-things cancel RUN_ID\n`);
  process.stdout.write(`  rat-things watch RUN_ID [--follow] [--after SEQUENCE] [--json]\n`);
  process.stdout.write(`  rat-things steer RUN_ID "Additional direction"\n`);
  process.stdout.write(`  rat-things interrupt RUN_ID\n`);
  process.stdout.write(`  rat-things approve RUN_ID REQUEST_ID [--decision DECISION] [--reason TEXT]\n`);
  process.stdout.write(`  rat-things respond RUN_ID REQUEST_ID --result JSON\n`);
  process.stdout.write(`\nIntegrations\n\n`);
  process.stdout.write(`  rat-things plugins\n`);
  process.stdout.write(`  rat-things profiles\n`);
  process.stdout.write(`  rat-things connections\n`);
  process.stdout.write(`  rat-things connect PLUGIN --credential-file CREDENTIAL.json\n`);
  process.stdout.write(`    [--auth-scheme SCHEME] [--access read-only|read-write|full] [--alias NAME]\n`);
  process.stdout.write(`  rat-things grant ACCOUNT --file GRANT.json\n`);
  process.stdout.write(`  rat-things rotate ACCOUNT --credential-file CREDENTIAL.json\n`);
  process.stdout.write(`  rat-things revoke ACCOUNT\n`);
  process.stdout.write(`  rat-things connection-sets\n`);
  process.stdout.write(`  rat-things connection-set --file SET.json\n`);
  process.stdout.write(`  rat-things source-bindings\n`);
  process.stdout.write(`  rat-things bind-source --file BINDING.json\n`);
  process.stdout.write(`\nThings\n\n`);
  process.stdout.write(`  rat-things things [--limit 25] [--all]\n`);
  process.stdout.write(`  rat-things thing THING_ID\n`);
  process.stdout.write(`  rat-things thing-create --file THING.json\n`);
  process.stdout.write(`  rat-things thing-update THING_ID --file THING.json\n`);
  process.stdout.write(`  rat-things thing-version THING_ID REVISION\n`);
  process.stdout.write(`  rat-things thing-versions THING_ID\n`);
  process.stdout.write(`  rat-things thing-explain THING_ID [--target draft|active]\n`);
  process.stdout.write(`  rat-things thing-test THING_ID [--idempotency-key KEY]\n`);
  process.stdout.write(`  rat-things thing-publish THING_ID\n`);
  process.stdout.write(`  rat-things thing-run THING_ID [--idempotency-key KEY]\n`);
  process.stdout.write(`  rat-things thing-pause|thing-resume|thing-archive THING_ID\n`);
  process.stdout.write(`\nRoutines\n\n`);
  process.stdout.write(`  rat-things routines [--limit 25]\n`);
  process.stdout.write(`  rat-things routine ROUTINE_ID\n`);
  process.stdout.write(`  rat-things routine-create --file ROUTINE.json\n`);
  process.stdout.write(`  rat-things routine-run ROUTINE_ID [--idempotency-key KEY]\n`);
  process.stdout.write(`  rat-things routine-pause ROUTINE_ID\n`);
  process.stdout.write(`  rat-things routine-resume ROUTINE_ID\n`);
  process.stdout.write(`  rat-things routine-delete ROUTINE_ID\n`);
  process.stdout.write(`  rat-things output RUN_ID\n`);
  process.stdout.write(`  rat-things artifact RUN_ID input|output|events|patch\n`);
  process.stdout.write(`  rat-things files [--thread NAME | --run RUN_ID] [--json]\n`);
  process.stdout.write(`  rat-things file NAME [--thread NAME | --run RUN_ID] [--download PATH] [--json]\n`);
  process.stdout.write(`  rat-things publish file PATH [--thread NAME | --run RUN_ID] [--title TEXT]\n`);
  process.stdout.write(`  rat-things publish site ROOT [--entrypoint PATH] [--thread NAME | --run RUN_ID]\n`);
  process.stdout.write(`  rat-things publish video PATH [--poster PATH] [--thread NAME | --run RUN_ID]\n`);
  process.stdout.write(`  rat-things list [--limit 25]\n`);
  process.stdout.write(`  rat-things doctor [--json]\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
