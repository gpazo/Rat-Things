#!/usr/bin/env node

import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Sha256 } from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';
import { CachedSecretReader } from './adapters/aws-runtime.js';
import type { AgentDriverName, RunRecord, RunRequest, SandboxMode } from './domain/contracts.js';
import { isTerminal } from './domain/state.js';
import { parseRunRequest } from './domain/validation.js';
import { driverFor } from './runner/agent-driver.js';
import { collectWorkspacePatch, prepareWorkspace } from './runner/workspace.js';

interface Arguments {
  command: string;
  values: Map<string, string>;
  flags: Set<string>;
  positionals: string[];
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  switch (args.command) {
    case 'local':
      await local(args);
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
      help();
      return;
    default:
      throw new Error(`unknown command ${JSON.stringify(args.command)}; run agent-runtime help`);
  }
}

async function local(args: Arguments): Promise<void> {
  const request = await requestFromArguments(args, true);
  const driverName = request.agent?.driver ?? 'mock';
  const timeout = (request.execution?.timeoutSeconds ?? 900) * 1_000;
  const explicitWorkspace = args.values.get('workspace');
  let workspace = explicitWorkspace ? resolve(explicitWorkspace) : process.cwd();
  let temporary: string | undefined;

  if (request.repository) {
    const root = resolve(process.env.WORKSPACE_ROOT ?? join(tmpdir(), 'agent-runtime'));
    await mkdir(root, { recursive: true, mode: 0o700 });
    temporary = await mkdtemp(join(root, 'local-'));
    workspace = temporary;
    const secrets = new CachedSecretReader(new SecretsManagerClient(regionConfig()));
    await prepareWorkspace(request.repository, workspace, secrets);
  }

  try {
    const result = await driverFor(driverName).execute(request, workspace, timeout);
    process.stdout.write(`${result.fullText}\n`);
    if (args.flags.has('patch')) {
      const patch = await collectWorkspacePatch(workspace);
      if (patch) process.stderr.write(`\n--- workspace.patch ---\n${patch.toString('utf8')}\n`);
    }
  } finally {
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
  const driver = (configuredDriver ?? (localMode ? 'mock' : undefined)) as AgentDriverName | undefined;
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

async function api(
  path: string,
  method: 'GET' | 'POST',
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<unknown> {
  const base = process.env.AGENT_RUNTIME_API_URL;
  if (!base) throw new Error('AGENT_RUNTIME_API_URL is required for remote commands');
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
    { name: 'AGENT_RUNTIME_API_URL', value: process.env.AGENT_RUNTIME_API_URL ?? '(unset)', ok: Boolean(process.env.AGENT_RUNTIME_API_URL) },
    { name: 'CODEX_BINARY', value: process.env.CODEX_BINARY ?? 'codex', ok: true },
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
    const next = rest[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      values.set(name, next);
      index += 1;
    } else {
      flags.add(name);
    }
  }
  return { command, values, flags, positionals };
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

function help(): void {
  process.stdout.write(`indubitably-agent-runtime\n\n`);
  process.stdout.write(`  agent-runtime local --driver mock --prompt \"...\"\n`);
  process.stdout.write(`  agent-runtime submit --file examples/run-request.json [--wait]\n`);
  process.stdout.write(`  agent-runtime get RUN_ID\n`);
  process.stdout.write(`  agent-runtime cancel RUN_ID\n`);
  process.stdout.write(`  agent-runtime output RUN_ID\n`);
  process.stdout.write(`  agent-runtime artifact RUN_ID input|output|events|patch\n`);
  process.stdout.write(`  agent-runtime list [--limit 25]\n`);
  process.stdout.write(`  agent-runtime doctor\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
