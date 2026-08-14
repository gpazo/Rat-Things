#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  LambdaMicrovmsClient,
  ListManagedMicrovmImageVersionsCommand,
} from '@aws-sdk/client-lambda-microvms';
import { defaultProvider } from '@aws-sdk/credential-provider-node';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = join(projectRoot, 'infra', 'github-onboarding.auto.tfvars.json');
const metadataPath = join(projectRoot, '.runtime', 'github-onboarding.json');
const supportedRegions = new Set(['ap-northeast-1', 'eu-west-1', 'us-east-1', 'us-east-2', 'us-west-2']);

export interface GitHubOnboardingOptions {
  command: 'help' | 'setup' | 'status';
  region: string;
  environment: string;
  trigger: string;
  driver: 'mock' | 'codex';
  repo?: string;
  profile?: string;
  baseImageVersion?: string;
  yes: boolean;
  dryRun: boolean;
}

interface SecretArns {
  webhook: string;
  clone: string;
  notify: string;
}

interface OnboardingMetadata {
  version: 1;
  repo: string;
  region: string;
  environment: string;
  trigger: string;
  driver: 'mock' | 'codex';
  webhookUrl: string;
  hookId: number;
  secretArns: SecretArns;
  profile?: string;
}

interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  inherit?: boolean;
  allowFailure?: boolean;
}

interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export function parseGitHubOnboardingOptions(argv: string[]): GitHubOnboardingOptions {
  const args = [...argv];
  let command: GitHubOnboardingOptions['command'] = 'setup';
  if (args[0] === 'setup' || args[0] === 'status') command = args.shift() as 'setup' | 'status';
  if (args.includes('--help') || args.includes('-h')) command = 'help';

  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index] as string;
    if (!item.startsWith('--')) throw new Error(`unexpected argument ${JSON.stringify(item)}`);
    const name = item.slice(2);
    if (name === 'yes' || name === 'dry-run' || name === 'help') {
      flags.add(name);
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`);
    values.set(name, value);
    index += 1;
  }

  const known = new Set([
    'repo',
    'region',
    'environment',
    'trigger',
    'driver',
    'profile',
    'microvm-base-image-version',
  ]);
  for (const name of values.keys()) {
    if (!known.has(name)) throw new Error(`unknown option --${name}`);
  }

  const region = values.get('region') || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-west-2';
  if (!supportedRegions.has(region)) {
    throw new Error(`Lambda MicroVMs are not available in ${region}`);
  }
  const environment = values.get('environment') ?? 'dev';
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(environment)) {
    throw new Error('--environment must contain 1-32 letters, numbers, underscores, or hyphens');
  }
  const trigger = values.get('trigger') ?? '@rat-things';
  if (!trigger.trim() || trigger.length > 64 || /[\r\n]/.test(trigger)) {
    throw new Error('--trigger must be a non-empty single-line value of at most 64 characters');
  }
  const driver = values.get('driver') ?? 'mock';
  if (driver !== 'mock' && driver !== 'codex') throw new Error('--driver must be mock or codex');
  const repo = values.get('repo');
  if (command === 'setup' && !repo) throw new Error('--repo OWNER/REPOSITORY is required');
  if (repo && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error('--repo must use the OWNER/REPOSITORY form');
  }

  return {
    command,
    region,
    environment,
    trigger,
    driver,
    yes: flags.has('yes'),
    dryRun: flags.has('dry-run'),
    ...(repo ? { repo } : {}),
    ...(values.get('profile') ? { profile: values.get('profile') as string } : {}),
    ...(values.get('microvm-base-image-version')
      ? { baseImageVersion: values.get('microvm-base-image-version') as string }
      : {}),
  };
}

export function githubTerraformConfig(
  options: GitHubOnboardingOptions,
  secrets: SecretArns,
  baseImageVersion: string,
): Record<string, unknown> {
  return {
    aws_region: options.region,
    ...(options.profile ? { aws_profile: options.profile } : {}),
    environment: options.environment,
    default_agent_driver: options.driver,
    github_webhook_secret_arn: secrets.webhook,
    github_clone_token_secret_arn: secrets.clone,
    github_notify_token_secret_arn: secrets.notify,
    github_comment_trigger: options.trigger,
    enable_microvm: true,
    enable_s3_files: false,
    microvm_base_image_version: baseImageVersion,
  };
}

async function main(): Promise<void> {
  const options = parseGitHubOnboardingOptions(process.argv.slice(2));
  if (options.command === 'help') {
    printHelp();
    return;
  }
  if (options.command === 'status') {
    await status(options);
    return;
  }
  await setup(options);
}

async function setup(options: GitHubOnboardingOptions): Promise<void> {
  const repo = options.repo as string;
  if (options.dryRun) {
    process.stdout.write([
      'GitHub webhook onboarding dry run',
      `Repository: ${repo}`,
      `AWS:        ${options.profile ? `${options.profile} / ` : ''}${options.region}`,
      `Environment: ${options.environment}`,
      `Trigger:    ${options.trigger}`,
      `Driver:     ${options.driver}`,
      '',
      'Would create or update three Secrets Manager secrets, package the runtime,',
      'apply infra/, and create or update the repository webhook.',
      '',
    ].join('\n'));
    return;
  }

  for (const tool of ['aws', 'gh', 'npm', 'terraform']) requireTool(tool);
  const env = commandEnvironment(options);
  const account = JSON.parse(capture('aws', ['sts', 'get-caller-identity', '--output', 'json'], { env })) as {
    Account?: unknown;
    Arn?: unknown;
  };
  const repository = JSON.parse(capture('gh', ['repo', 'view', repo, '--json', 'nameWithOwner,visibility'], { env })) as {
    nameWithOwner?: unknown;
    visibility?: unknown;
  };
  if (repository.nameWithOwner !== repo) {
    throw new Error(`GitHub resolved ${String(repository.nameWithOwner)} instead of ${repo}`);
  }
  const baseImageVersion = options.baseImageVersion ?? await discoverBaseImageVersion(options, env);

  process.stdout.write([
    'Rat Things will configure a signed GitHub webhook and AWS runtime.',
    `GitHub repository: ${repo} (${String(repository.visibility ?? 'unknown').toLowerCase()})`,
    `AWS account:       ${String(account.Account ?? 'unknown')} (${String(account.Arn ?? 'unknown')})`,
    `AWS region:        ${options.region}`,
    `Environment:       ${options.environment}`,
    `Trigger:           ${options.trigger}`,
    `Agent driver:      ${options.driver}${options.driver === 'codex' ? ' (paid Bedrock model usage)' : ' (token-free smoke replies)'}`,
    `Base image:        al2023-1:${baseImageVersion}`,
    '',
    'The setup stores GitHub credentials in AWS Secrets Manager, applies Terraform,',
    'and creates or updates a repository webhook subscribed to pull requests and comments.',
    '',
  ].join('\n'));
  await confirm(options.yes);

  const temporary = await mkdtemp(join(tmpdir(), 'rat-things-github-'));
  await chmod(temporary, 0o700);
  try {
    const secretPrefix = `rat-things/${options.environment}/${repo.toLowerCase().replace('/', '-')}`;
    const webhookName = `${secretPrefix}/webhook`;
    const cloneName = `${secretPrefix}/clone-token`;
    const notifyName = `${secretPrefix}/notify-token`;
    const webhookExisting = describeSecret(webhookName, options, env);
    const webhookSecret = webhookExisting
      ? secretValue(webhookName, options, env, ['secret', 'webhook_secret'])
      : randomBytes(32).toString('hex');
    const ghToken = capture('gh', ['auth', 'token'], { env });
    const cloneToken = process.env.RAT_THINGS_GITHUB_CLONE_TOKEN ?? ghToken;
    const notifyToken = process.env.RAT_THINGS_GITHUB_NOTIFY_TOKEN ?? ghToken;
    if (!process.env.RAT_THINGS_GITHUB_CLONE_TOKEN || !process.env.RAT_THINGS_GITHUB_NOTIFY_TOKEN) {
      process.stderr.write(
        'warning: reusing the current gh token for onboarding; use separate RAT_THINGS_GITHUB_CLONE_TOKEN and RAT_THINGS_GITHUB_NOTIFY_TOKEN values for production\n',
      );
    }

    const secrets: SecretArns = {
      webhook: await putSecret(webhookName, webhookSecret, 'GitHub webhook signing secret', temporary, options, env),
      clone: await putSecret(cloneName, cloneToken, 'GitHub repository clone token', temporary, options, env),
      notify: await putSecret(notifyName, notifyToken, 'GitHub pull-request comment token', temporary, options, env),
    };
    await writeFile(
      configPath,
      `${JSON.stringify(githubTerraformConfig(options, secrets, baseImageVersion), null, 2)}\n`,
      { mode: 0o600 },
    );

    inherited('npm', ['run', 'package'], { env });
    inherited('terraform', ['-chdir=infra', 'init', '-input=false'], { env });
    inherited('terraform', ['-chdir=infra', 'apply', '-input=false', '-auto-approve'], { env });

    const webhookUrls = JSON.parse(capture('terraform', ['-chdir=infra', 'output', '-json', 'webhook_urls'], { env })) as {
      github?: unknown;
    };
    if (typeof webhookUrls.github !== 'string') throw new Error('Terraform returned no GitHub webhook URL');
    const hookId = upsertGitHubWebhook(
      repo,
      webhookUrls.github,
      webhookSecret,
      env,
      await previousHookId(repo),
    );
    const metadata: OnboardingMetadata = {
      version: 1,
      repo,
      region: options.region,
      environment: options.environment,
      trigger: options.trigger,
      driver: options.driver,
      webhookUrl: webhookUrls.github,
      hookId,
      secretArns: secrets,
      ...(options.profile ? { profile: options.profile } : {}),
    };
    await mkdir(dirname(metadataPath), { recursive: true, mode: 0o700 });
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });

    process.stdout.write([
      '',
      'GitHub webhook onboarding complete.',
      `Webhook: ${webhookUrls.github}`,
      `Trigger: comment ${options.trigger} followed by a request on a pull request`,
      `Status:  npm run webhook:github:status`,
      ...(options.driver === 'mock'
        ? [`Real agent: rerun this command with --driver codex after confirming Bedrock access in ${options.region}`]
        : []),
      '',
    ].join('\n'));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function status(options: GitHubOnboardingOptions): Promise<void> {
  let rawMetadata: string;
  try {
    rawMetadata = await readFile(metadataPath, 'utf8');
  } catch {
    throw new Error('no GitHub onboarding metadata found; run npm run webhook:github first');
  }
  const metadata = JSON.parse(rawMetadata) as OnboardingMetadata;
  if (metadata.version !== 1 || !metadata.repo || !Number.isInteger(metadata.hookId)) {
    throw new Error(`invalid onboarding metadata at ${metadataPath}`);
  }
  const env = commandEnvironment({
    ...options,
    region: metadata.region,
    ...(metadata.profile ? { profile: metadata.profile } : {}),
  });
  requireTool('gh');
  const hook = JSON.parse(capture('gh', ['api', `repos/${metadata.repo}/hooks/${metadata.hookId}`], { env })) as {
    active?: unknown;
    updated_at?: unknown;
  };
  const deliveries = JSON.parse(capture(
    'gh',
    ['api', `repos/${metadata.repo}/hooks/${metadata.hookId}/deliveries?per_page=5`],
    { env },
  )) as Array<{ event?: unknown; status_code?: unknown; delivered_at?: unknown }>;
  const latest = deliveries[0];
  process.stdout.write([
    `Repository: ${metadata.repo}`,
    `Webhook:    ${metadata.webhookUrl}`,
    `Active:     ${String(hook.active ?? 'unknown')}`,
    `Updated:    ${String(hook.updated_at ?? 'unknown')}`,
    `Trigger:    ${metadata.trigger}`,
    `Driver:     ${metadata.driver}`,
    latest
      ? `Last delivery: ${String(latest.event ?? 'unknown')} / HTTP ${String(latest.status_code ?? 'unknown')} / ${String(latest.delivered_at ?? 'unknown')}`
      : 'Last delivery: none reported yet',
    '',
  ].join('\n'));
}

async function discoverBaseImageVersion(
  options: GitHubOnboardingOptions,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const client = new LambdaMicrovmsClient({
    region: options.region,
    ...(options.profile ? { credentials: defaultProvider({ profile: options.profile }) } : {}),
  });
  try {
    const response = await client.send(new ListManagedMicrovmImageVersionsCommand({
      imageIdentifier: `arn:aws:lambda:${options.region}:aws:microvm-image:al2023-1`,
      maxResults: 50,
    }));
    const latest = [...(response.items ?? [])]
      .filter((item) => item.imageVersion)
      .sort((left, right) => (right.createdAt?.getTime() ?? 0) - (left.createdAt?.getTime() ?? 0))[0];
    if (!latest?.imageVersion) throw new Error('AWS returned no available al2023-1 MicroVM image versions');
    return latest.imageVersion;
  } catch (error) {
    const profileHint = env.AWS_PROFILE ? ` for AWS profile ${env.AWS_PROFILE}` : '';
    throw new Error(
      `could not discover an available Lambda MicroVM base image${profileHint}; pass --microvm-base-image-version VERSION: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    client.destroy();
  }
}

async function putSecret(
  name: string,
  value: string,
  description: string,
  temporary: string,
  options: GitHubOnboardingOptions,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const filename = join(temporary, `${name.split('/').at(-1) as string}.txt`);
  await writeFile(filename, value, { mode: 0o600 });
  const existing = describeSecret(name, options, env);
  if (existing) {
    capture('aws', awsArgs(options, [
      'secretsmanager',
      'put-secret-value',
      '--secret-id',
      name,
      '--secret-string',
      `file://${filename}`,
      '--output',
      'json',
    ]), { env });
    return existing.ARN as string;
  }
  const created = JSON.parse(capture('aws', awsArgs(options, [
    'secretsmanager',
    'create-secret',
    '--name',
    name,
    '--description',
    description,
    '--secret-string',
    `file://${filename}`,
    '--tags',
    'Key=Project,Value=rat-things',
    `Key=Environment,Value=${options.environment}`,
    '--output',
    'json',
  ]), { env })) as { ARN?: unknown };
  if (typeof created.ARN !== 'string') throw new Error(`AWS returned no ARN for secret ${name}`);
  return created.ARN;
}

function describeSecret(
  name: string,
  options: GitHubOnboardingOptions,
  env: NodeJS.ProcessEnv,
): { ARN: string } | undefined {
  const result = command('aws', awsArgs(options, [
    'secretsmanager',
    'describe-secret',
    '--secret-id',
    name,
    '--output',
    'json',
  ]), { env, allowFailure: true });
  if (result.status !== 0) {
    if (result.stderr.includes('ResourceNotFoundException')) return undefined;
    throw new Error(`aws secretsmanager describe-secret failed: ${result.stderr.trim()}`);
  }
  const value = JSON.parse(result.stdout) as { ARN?: unknown };
  if (typeof value.ARN !== 'string') throw new Error(`AWS returned no ARN for secret ${name}`);
  return { ARN: value.ARN };
}

function secretValue(
  name: string,
  options: GitHubOnboardingOptions,
  env: NodeJS.ProcessEnv,
  acceptedKeys: string[],
): string {
  const raw = capture('aws', awsArgs(options, [
    'secretsmanager',
    'get-secret-value',
    '--secret-id',
    name,
    '--query',
    'SecretString',
    '--output',
    'text',
  ]), { env });
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const key of acceptedKeys) {
      if (typeof parsed[key] === 'string') return parsed[key];
    }
  } catch {
    return raw;
  }
  throw new Error(`secret ${name} contains none of: ${acceptedKeys.join(', ')}`);
}

async function previousHookId(repo: string): Promise<number | undefined> {
  try {
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as Partial<OnboardingMetadata>;
    return metadata.repo === repo && Number.isInteger(metadata.hookId) ? metadata.hookId : undefined;
  } catch {
    return undefined;
  }
}

function upsertGitHubWebhook(
  repo: string,
  url: string,
  secret: string,
  env: NodeJS.ProcessEnv,
  previousId?: number,
): number {
  const hooks = JSON.parse(capture('gh', ['api', `repos/${repo}/hooks?per_page=100`], { env })) as Array<{
    id?: unknown;
    config?: { url?: unknown };
  }>;
  const existing = hooks.find((hook) => (
    typeof hook.id === 'number' && (hook.id === previousId || hook.config?.url === url)
  ));
  const payload = JSON.stringify({
    name: 'web',
    active: true,
    events: ['pull_request', 'issue_comment'],
    config: { url, content_type: 'json', secret, insecure_ssl: '0' },
  });
  const endpoint = existing
    ? `repos/${repo}/hooks/${existing.id as number}`
    : `repos/${repo}/hooks`;
  const response = JSON.parse(capture(
    'gh',
    ['api', '--method', existing ? 'PATCH' : 'POST', endpoint, '--input', '-'],
    { env, input: payload },
  )) as { id?: unknown };
  if (typeof response.id !== 'number') throw new Error('GitHub returned no webhook ID');
  return response.id;
}

async function confirm(yes: boolean): Promise<void> {
  if (yes) return;
  if (!process.stdin.isTTY) throw new Error('confirmation requires a terminal; rerun with --yes after reviewing --dry-run');
  const prompts = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompts.question('Continue? [y/N] ');
    if (!/^y(?:es)?$/i.test(answer.trim())) throw new Error('onboarding cancelled');
  } finally {
    prompts.close();
  }
}

function awsArgs(options: GitHubOnboardingOptions, args: string[]): string[] {
  return [
    ...args,
    '--region',
    options.region,
    ...(options.profile ? ['--profile', options.profile] : []),
  ];
}

function commandEnvironment(options: Pick<GitHubOnboardingOptions, 'profile' | 'region'>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AWS_REGION: options.region,
    AWS_DEFAULT_REGION: options.region,
    AWS_PAGER: '',
    ...(options.profile ? { AWS_PROFILE: options.profile } : {}),
  };
}

function requireTool(name: string): void {
  const result = command(name, ['--version'], { allowFailure: true });
  if (result.status !== 0) throw new Error(`${name} is required for GitHub webhook onboarding`);
}

function capture(name: string, args: string[], options: CommandOptions = {}): string {
  const result = command(name, args, options);
  return result.stdout.trim();
}

function inherited(name: string, args: string[], options: CommandOptions = {}): void {
  command(name, args, { ...options, inherit: true });
}

function command(name: string, args: string[], options: CommandOptions = {}): CommandResult {
  const result = spawnSync(name, args, {
    cwd: options.cwd ?? projectRoot,
    env: options.env ?? process.env,
    encoding: 'utf8',
    ...(options.inherit
      ? { stdio: 'inherit' as const }
      : { input: options.input, stdio: ['pipe', 'pipe', 'pipe'] as const }),
  });
  if (result.error) throw result.error;
  const status = result.status ?? 1;
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  if (status !== 0 && !options.allowFailure) {
    throw new Error(`${name} ${args.join(' ')} failed (${status}): ${stderr.trim() || stdout.trim()}`);
  }
  return { status, stdout, stderr };
}

function printHelp(): void {
  process.stdout.write(`GitHub webhook onboarding\n\n`);
  process.stdout.write(`  npm run webhook:github -- --repo OWNER/REPOSITORY [options]\n`);
  process.stdout.write(`  npm run webhook:github:status\n\n`);
  process.stdout.write(`Options:\n`);
  process.stdout.write(`  --driver mock|codex                 mock is the token-free default\n`);
  process.stdout.write(`  --trigger TEXT                      default: @rat-things\n`);
  process.stdout.write(`  --region REGION                     default: AWS_REGION or us-west-2\n`);
  process.stdout.write(`  --profile PROFILE                   AWS shared-credentials profile\n`);
  process.stdout.write(`  --environment NAME                  default: dev\n`);
  process.stdout.write(`  --microvm-base-image-version VALUE  override automatic discovery\n`);
  process.stdout.write(`  --dry-run                            describe changes without external calls\n`);
  process.stdout.write(`  --yes                                skip the interactive confirmation\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
