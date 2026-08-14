#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Sha256 } from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';
import { CachedSecretReader } from './adapters/aws-runtime.js';
import { CredentialBroker } from './credentials/broker.js';
import type { AgentDriverName, RunRecord, RunRequest, SandboxMode } from './domain/contracts.js';
import { isTerminal } from './domain/state.js';
import { parseRunRequest } from './domain/validation.js';
import { driverFor } from './runner/agent-driver.js';
import { loadCodexBedrockToken } from './runner/bedrock-auth.js';
import { codexAuthMode, localCodexAuthMode } from './runner/codex-auth.js';
import { collectWorkspacePatch, prepareWorkspace } from './runner/workspace.js';

interface Arguments {
  command: string;
  values: Map<string, string>;
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

const commands = new Set([
  'local',
  'chat',
  'submit',
  'get',
  'cancel',
  'output',
  'artifact',
  'list',
  'doctor',
  'help',
]);

const booleanOptions = new Set([
  'all',
  'events',
  'help',
  'json',
  'network',
  'new',
  'no-wait',
  'output',
  'patch',
  'wait',
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
    case 'output':
      await writeArtifact(requiredPositional(args, 0, 'run ID'), 'output');
      return;
    case 'artifact':
      await writeArtifact(
        requiredPositional(args, 0, 'run ID'),
        requiredPositional(args, 1, 'artifact name'),
      );
      return;
    case 'list': {
      const query = new URLSearchParams();
      if (args.values.get('limit')) query.set('limit', args.values.get('limit') as string);
      if (args.values.get('next-token')) query.set('nextToken', args.values.get('next-token') as string);
      print(await api(`/v1/runs${query.size > 0 ? `?${query.toString()}` : ''}`, 'GET'));
      return;
    }
    case 'doctor':
      await doctor();
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
        else await writeArtifact(current.run.runId, 'output');
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
  if (args.flags.has('network')) process.env.CODEX_TOOL_NETWORK_ACCESS = 'true';
  const request = await requestFromArguments(args, true);
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
    if (
      driverName === 'codex' &&
      codexAuthMode() === 'bedrock' &&
      !process.env.AWS_BEARER_TOKEN_BEDROCK
    ) {
      loadedBedrockToken = await loadCodexBedrockToken(credentials);
    }
    const result = await driverFor(driverName).execute(request, workspace, timeout);
    process.stdout.write(`${result.fullText}\n`);
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

async function writeArtifact(runId: string, name: string): Promise<void> {
  if (!['input', 'output', 'events', 'patch'].includes(name)) {
    throw new Error('artifact name must be input, output, events, or patch');
  }
  const descriptor = await api(`/v1/runs/${runId}/artifacts/${name}`, 'GET') as {
    url?: unknown;
  };
  if (typeof descriptor.url !== 'string') throw new Error('runtime returned no artifact URL');
  const response = await fetch(descriptor.url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`artifact download returned HTTP ${response.status}`);
  process.stdout.write(await response.text());
  if (name === 'output') process.stdout.write('\n');
}

async function requestFromArguments(args: Arguments, localMode: boolean): Promise<RunRequest> {
  const file = args.values.get('file');
  if (file) return parseRunRequest(JSON.parse(await readFile(resolve(file), 'utf8')) as unknown, validationOptions());
  const prompt = args.values.get('prompt') ?? args.positionals.join(' ');
  if (!prompt) throw new Error('provide --prompt TEXT or --file REQUEST.json');
  const configuredDriver = args.values.get('driver');
  const driver = (configuredDriver ?? (localMode ? 'codex' : undefined)) as AgentDriverName | undefined;
  const sandbox = (args.values.get('sandbox') ?? 'read-only') as SandboxMode;
  const request: Record<string, unknown> = {
    version: '1',
    prompt,
    agent: compact({
      driver,
      sandbox,
      model: args.values.get('model'),
      reasoningEffort: args.values.get('reasoning-effort'),
    }),
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
    agent: compact({
      driver: args.values.get('driver'),
      sandbox: args.values.get('sandbox') ?? 'read-only',
      model: args.values.get('model'),
      reasoningEffort: args.values.get('reasoning-effort'),
    }),
  };
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

async function doctor(): Promise<void> {
  const checks = [
    { name: 'node', value: process.version, ok: Number(process.versions.node.split('.')[0]) >= 20 },
    { name: 'AWS_REGION', value: process.env.AWS_REGION ?? '(unset)', ok: Boolean(process.env.AWS_REGION) },
    {
      name: 'RAT_THINGS_API_URL',
      value: process.env.RAT_THINGS_API_URL ?? process.env.AGENT_RUNTIME_API_URL ?? '(unset)',
      ok: Boolean(process.env.RAT_THINGS_API_URL ?? process.env.AGENT_RUNTIME_API_URL),
    },
    { name: 'CODEX_BINARY', value: process.env.CODEX_BINARY ?? 'codex', ok: true },
    { name: 'CODEX_AUTH_MODE', value: process.env.CODEX_AUTH_MODE ?? 'bedrock', ok: true },
  ];
  for (const check of checks) process.stdout.write(`${check.ok ? 'ok' : 'warn'}\t${check.name}\t${check.value}\n`);
  if (!checks[0]?.ok) process.exitCode = 1;
}

function parseArguments(argv: string[]): Arguments {
  const [command = 'help', ...rest] = argv;
  const values = new Map<string, string>();
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
      values.set(name, next);
      index += 1;
    } else {
      throw new Error(`--${name} requires a value`);
    }
  }
  return { command, values, flags, positionals };
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

function requiredPositional(args: Arguments, index: number, label: string): string {
  const value = args.positionals[index];
  if (!value) throw new Error(`${label} is required`);
  return value;
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
  process.stdout.write(`\nRepeat a thread name to continue the same Codex thread.\n`);
  process.stdout.write(`Run rat-things help --all for agent and automation options.\n`);
  if (!showAll) return;
  process.stdout.write(`\nAgent and automation options\n\n`);
  process.stdout.write(`  rat-things chat [--thread NAME] [--driver codex] [--model ID]\n`);
  process.stdout.write(`    [--sandbox MODE] [--reasoning-effort LEVEL] [--json] [--no-wait]\n`);
  process.stdout.write(`    [--idempotency-key KEY] [--poll-seconds N] [--wait-timeout N] \"...\"\n`);
  process.stdout.write(`  --api-url URL and --region REGION override RAT_THINGS_API_URL and AWS_REGION\n`);
  process.stdout.write(`\nLocal execution\n\n`);
  process.stdout.write(`  rat-things local [--sandbox MODE] [--network] [--events] \"...\"\n`);
  process.stdout.write(`    defaults to Codex with the device's cached ChatGPT login; use --driver mock for tests\n`);
  process.stdout.write(`\nRun management\n\n`);
  process.stdout.write(`  rat-things submit --file examples/run-request.json [--wait]\n`);
  process.stdout.write(`  rat-things get RUN_ID\n`);
  process.stdout.write(`  rat-things cancel RUN_ID\n`);
  process.stdout.write(`  rat-things output RUN_ID\n`);
  process.stdout.write(`  rat-things artifact RUN_ID input|output|events|patch\n`);
  process.stdout.write(`  rat-things list [--limit 25]\n`);
  process.stdout.write(`  rat-things doctor\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
