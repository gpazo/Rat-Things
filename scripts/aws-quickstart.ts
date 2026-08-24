#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  LambdaMicrovmsClient,
  ListManagedMicrovmImageVersionsCommand,
} from '@aws-sdk/client-lambda-microvms';
import { defaultProvider } from '@aws-sdk/credential-provider-node';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const quickstartRoot = join(projectRoot, '.runtime', 'aws-quickstart');
const configPath = join(quickstartRoot, 'quickstart.tfvars.json');
const statePath = join(quickstartRoot, 'terraform.tfstate');
const metadataPath = join(quickstartRoot, 'result.json');
const thingPath = join(quickstartRoot, 'first-thing.json');
const debugLogPath = join(quickstartRoot, 'quickstart.log');
const terraformDataDir = join(quickstartRoot, 'terraform-data');
const terraformPluginCache = join(projectRoot, '.runtime', 'terraform-plugin-cache');
const supportedRegions = new Set([
  'ap-northeast-1',
  'eu-west-1',
  'us-east-1',
  'us-east-2',
  'us-west-2',
]);

export interface AwsQuickstartOptions {
  command: 'setup' | 'status' | 'destroy' | 'help';
  region: string;
  environment: string;
  driver: 'codex' | 'mock';
  model: string;
  profile?: string;
  baseImageVersion?: string;
  yes: boolean;
  dryRun: boolean;
  json: boolean;
}

interface CommandOptions {
  env?: NodeJS.ProcessEnv;
  allowFailure?: boolean;
}

interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

interface QuickstartResult {
  version: 1;
  status: 'ready' | 'destroyed';
  apiUrl: string;
  region: string;
  environment: string;
  driver: 'codex' | 'mock';
  model?: string;
  baseImageVersion: string;
  thingId: string;
  testRunId: string;
  outputPreview: string;
  startedAt: string;
  completedAt: string;
  destroyedAt?: string;
  elapsedSeconds: number;
  underTenMinutes: boolean;
}

export function parseAwsQuickstartOptions(argv: string[]): AwsQuickstartOptions {
  const args = [...argv];
  let command: AwsQuickstartOptions['command'] = 'setup';
  if (['setup', 'status', 'destroy'].includes(args[0] ?? '')) {
    command = args.shift() as AwsQuickstartOptions['command'];
  }
  if (args.includes('--help') || args.includes('-h')) command = 'help';

  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index] as string;
    if (!item.startsWith('--')) throw new Error(`unexpected argument ${JSON.stringify(item)}`);
    const name = item.slice(2);
    if (['yes', 'dry-run', 'json', 'help'].includes(name)) {
      flags.add(name);
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`);
    values.set(name, value);
    index += 1;
  }
  const known = new Set([
    'region',
    'profile',
    'environment',
    'driver',
    'model',
    'microvm-base-image-version',
  ]);
  for (const name of values.keys()) {
    if (!known.has(name)) throw new Error(`unknown option --${name}`);
  }

  const region = values.get('region') ?? process.env.AWS_REGION ??
    process.env.AWS_DEFAULT_REGION ?? 'us-west-2';
  if (!supportedRegions.has(region)) {
    throw new Error(`Lambda MicroVM quickstart is not supported in ${region}`);
  }
  const environment = values.get('environment') ?? 'quickstart';
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(environment)) {
    throw new Error('--environment must contain 1-32 letters, numbers, underscores, or hyphens');
  }
  const driver = values.get('driver') ?? 'codex';
  if (driver !== 'codex' && driver !== 'mock') throw new Error('--driver must be codex or mock');
  const model = values.get('model') ?? 'openai.gpt-5.6-terra';
  if (!model || /[\r\n]/.test(model)) throw new Error('--model must be a non-empty single-line value');

  return {
    command,
    region,
    environment,
    driver,
    model,
    yes: flags.has('yes'),
    dryRun: flags.has('dry-run'),
    json: flags.has('json'),
    ...(values.get('profile') ? { profile: values.get('profile') as string } : {}),
    ...(values.get('microvm-base-image-version')
      ? { baseImageVersion: values.get('microvm-base-image-version') as string }
      : {}),
  };
}

export function awsQuickstartTerraformConfig(
  options: AwsQuickstartOptions,
  baseImageVersion: string,
): Record<string, unknown> {
  return {
    aws_region: options.region,
    ...(options.profile ? { aws_profile: options.profile } : {}),
    environment: options.environment,
    artifact_retention_days: 1,
    log_retention_days: 1,
    force_destroy_data: true,
    enable_point_in_time_recovery: false,
    enable_detailed_api_metrics: false,
    default_agent_driver: options.driver,
    default_sandbox_mode: 'read-only',
    default_agent_network_access: false,
    allow_agent_aws_credential_chain: false,
    codex_bedrock_model_ids: [options.model],
    enable_microvm: true,
    enable_s3_files: false,
    microvm_base_image_version: baseImageVersion,
    tags: {
      ManagedBy: 'rat-things-quickstart',
      Purpose: 'ten-minute-golden-path',
    },
  };
}

export function awsQuickstartThing(
  driver: 'codex' | 'mock',
  marker: string,
): Record<string, unknown> {
  return {
    version: '1',
    name: 'My first Rat Thing',
    goal: `Reply with this exact marker and one short sentence explaining that the Thing is ready: ${marker}`,
    trigger: { kind: 'manual' },
    agent: {
      driver,
      sandbox: 'read-only',
      capabilities: {
        profile: 'read-only',
        approvalPolicy: 'untrusted',
        approvalsReviewer: 'user',
        networkAccess: false,
        webSearch: 'disabled',
        computerUse: 'disabled',
      },
    },
    execution: { backend: 'microvm', timeoutSeconds: driver === 'codex' ? 300 : 120 },
    deliver: [{ kind: 'none' }],
  };
}

async function main(): Promise<void> {
  const options = parseAwsQuickstartOptions(process.argv.slice(2));
  if (options.command === 'help') return printHelp();
  if (options.command === 'status') return status(options);
  if (options.command === 'destroy') return destroy(options);
  return setup(options);
}

async function setup(options: AwsQuickstartOptions): Promise<void> {
  if (options.dryRun) {
    const baseImageVersion = options.baseImageVersion ?? '<newest AVAILABLE al2023-1 version>';
    printValue({
      action: 'setup',
      changesExternalState: false,
      driver: options.driver,
      modelUsage: options.driver === 'codex' ? 'paid Amazon Bedrock tokens' : 'none (deterministic mock)',
      terraform: awsQuickstartTerraformConfig(options, baseImageVersion),
      finish: 'create, explain, test, and publish one safe manual Thing',
    }, options.json);
    return;
  }

  for (const tool of ['aws', 'npm', 'terraform']) requireTool(tool);
  await mkdir(quickstartRoot, { recursive: true, mode: 0o700 });
  await mkdir(terraformPluginCache, { recursive: true, mode: 0o700 });
  await writeFile(debugLogPath, `Rat Things AWS quickstart\nStarted ${new Date().toISOString()}\n`, {
    mode: 0o600,
  });
  const env = commandEnvironment(options);
  const identity = JSON.parse(capture('aws', ['sts', 'get-caller-identity', '--output', 'json'], { env })) as {
    Account?: unknown;
    Arn?: unknown;
  };
  const baseImageVersion = options.baseImageVersion ?? await discoverBaseImageVersion(options);
  const started = Date.now();
  const startedAt = new Date(started).toISOString();

  progress([
    'Rat Things ten-minute AWS quickstart',
    `AWS account: ${String(identity.Account ?? 'unknown')} (${String(identity.Arn ?? 'unknown')})`,
    `Region:      ${options.region}`,
    `Runtime:     Lambda MicroVM al2023-1:${baseImageVersion}`,
    `Agent:       ${options.driver === 'codex'
      ? `real Codex via paid Bedrock model ${options.model}`
      : 'deterministic mock (infrastructure proof only, not a model)'}`,
    'Scope:       one manual Thing; no OAuth accounts, VPC/NAT, schedules, or public sharing',
    'State:       .runtime/aws-quickstart/terraform.tfstate',
    'Debug log:   .runtime/aws-quickstart/quickstart.log',
    '',
  ].join('\n'));
  await confirm(options.yes, 'Deploy this disposable quickstart stack?');

  await writeFile(
    configPath,
    `${JSON.stringify(awsQuickstartTerraformConfig(options, baseImageVersion), null, 2)}\n`,
    { mode: 0o600 },
  );
  progress('[1/4] Package Rat Things');
  await loggedCommand('npm', ['run', 'package'], { env });
  progress('      ready');

  progress('[2/4] Deploy the disposable AWS backend');
  await loggedCommand('terraform', ['-chdir=infra', 'init', '-input=false'], {
    env: terraformEnvironment(env),
  });
  await loggedCommand('terraform', [
    '-chdir=infra',
    'apply',
    `-state=${statePath}`,
    `-var-file=${configPath}`,
    '-input=false',
    '-auto-approve',
    '-compact-warnings',
  ], { env: terraformEnvironment(env) });
  progress('      ready');

  const apiUrl = capture('terraform', [
    '-chdir=infra',
    'output',
    `-state=${statePath}`,
    '-raw',
    'api_endpoint',
  ], { env: terraformEnvironment(env) });
  const cliEnv = {
    ...env,
    RAT_THINGS_API_URL: apiUrl,
  };
  progress('[3/4] Verify discovery and the authenticated API');
  await loggedCommand(process.execPath, cliArguments(['doctor', '--json']), { env: cliEnv });
  progress('      healthy');

  const marker = `RAT-THINGS-READY-${randomUUID().slice(0, 8).toUpperCase()}`;
  await writeFile(thingPath, `${JSON.stringify(awsQuickstartThing(options.driver, marker), null, 2)}\n`, {
    mode: 0o600,
  });
  progress('[4/4] Create → explain → test → publish the exact Thing revision');
  const release = JSON.parse(await captureWithProgress(process.execPath, cliArguments([
    'thing-release',
    '--file',
    thingPath,
    '--poll-seconds',
    '2',
    '--wait-timeout',
    '420',
  ]), { env: cliEnv })) as {
    released?: unknown;
    created?: { thingId?: unknown };
    testRun?: { runId?: unknown; status?: unknown; result?: { preview?: unknown } };
    thing?: { status?: unknown };
  };
  const thingId = requiredString(release.created?.thingId, 'release returned no Thing ID');
  const testRunId = requiredString(release.testRun?.runId, 'release returned no test Run ID');
  const outputPreview = requiredString(
    release.testRun?.result?.preview,
    'the successful test Run returned no output preview',
  );
  if (
    release.released !== true ||
    release.testRun?.status !== 'succeeded' ||
    release.thing?.status !== 'active'
  ) throw new Error('the first Thing did not reach active after a successful exact-draft test');
  if (!outputPreview.includes(marker)) {
    throw new Error(`the first Thing output did not contain its proof marker ${marker}`);
  }
  progress('      active and proven');

  const completed = Date.now();
  const result: QuickstartResult = {
    version: 1,
    status: 'ready',
    apiUrl,
    region: options.region,
    environment: options.environment,
    driver: options.driver,
    ...(options.driver === 'codex' ? { model: options.model } : {}),
    baseImageVersion,
    thingId,
    testRunId,
    outputPreview,
    startedAt,
    completedAt: new Date(completed).toISOString(),
    elapsedSeconds: Math.ceil((completed - started) / 1_000),
    underTenMinutes: completed - started <= 600_000,
  };
  await writeFile(metadataPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  printValue(result, options.json);
  if (!result.underTenMinutes) {
    throw new Error(`the golden path completed, but exceeded ten minutes (${result.elapsedSeconds}s)`);
  }
}

async function status(options: AwsQuickstartOptions): Promise<void> {
  const result = await readMetadata();
  if (result.status === 'destroyed') {
    printValue(result, options.json);
    return;
  }
  const env = commandEnvironment({ ...options, region: result.region });
  const doctor = JSON.parse(capture(process.execPath, cliArguments(['doctor', '--json']), {
    env: { ...env, RAT_THINGS_API_URL: result.apiUrl },
  })) as unknown;
  const thing = JSON.parse(capture(process.execPath, cliArguments(['thing', result.thingId]), {
    env: { ...env, RAT_THINGS_API_URL: result.apiUrl },
  })) as unknown;
  printValue({ status: 'ready', deployment: result, doctor, thing }, options.json);
}

async function destroy(options: AwsQuickstartOptions): Promise<void> {
  const result = await readMetadata();
  if (result.status === 'destroyed') {
    printValue(result, options.json);
    return;
  }
  if (options.dryRun) {
    printValue({ action: 'destroy', changesExternalState: false, environment: result.environment }, options.json);
    return;
  }
  await confirm(options.yes, `Destroy the ${result.environment} quickstart stack in ${result.region}?`);
  const env = commandEnvironment({
    region: result.region,
    ...(options.profile ? { profile: options.profile } : {}),
  });
  const terraformEnv = terraformEnvironment(env);
  const microvm = command('terraform', [
    '-chdir=infra',
    'output',
    `-state=${statePath}`,
    '-json',
    'microvm',
  ], { env: terraformEnv, allowFailure: true });
  if (microvm.status === 0) {
    const imageArn = (JSON.parse(microvm.stdout) as { image_arn?: unknown }).image_arn;
    if (typeof imageArn === 'string' && imageArn) {
      progress('[1/2] Terminate quickstart MicroVMs');
      const termination = await loggedCommand(
        process.execPath,
        [join(projectRoot, 'scripts', 'terminate-microvms.mjs'), result.region, imageArn],
        { env },
      );
      if (termination.stdout.trim()) progress(`      ${termination.stdout.trim()}`);
    }
  }
  progress('[2/2] Destroy the quickstart AWS backend');
  await loggedCommand('terraform', [
    '-chdir=infra',
    'destroy',
    `-state=${statePath}`,
    `-var-file=${configPath}`,
    '-input=false',
    '-auto-approve',
    '-compact-warnings',
  ], { env: terraformEnv });
  progress('      destroyed');
  const destroyed = { ...result, status: 'destroyed' as const, destroyedAt: new Date().toISOString() };
  await writeFile(metadataPath, `${JSON.stringify(destroyed, null, 2)}\n`, { mode: 0o600 });
  printValue(destroyed, options.json);
}

async function discoverBaseImageVersion(options: AwsQuickstartOptions): Promise<string> {
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
    if (!latest?.imageVersion) throw new Error('AWS returned no available al2023-1 versions');
    return latest.imageVersion;
  } catch (error) {
    throw new Error(
      `could not discover a Lambda MicroVM base image; pass --microvm-base-image-version VERSION: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    client.destroy();
  }
}

async function readMetadata(): Promise<QuickstartResult> {
  try {
    return JSON.parse(await readFile(metadataPath, 'utf8')) as QuickstartResult;
  } catch {
    throw new Error('no AWS quickstart result exists; run npm run quickstart:aws first');
  }
}

function cliArguments(args: string[]): string[] {
  return [join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(projectRoot, 'src', 'cli.ts'), ...args];
}

function terraformEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    TF_DATA_DIR: terraformDataDir,
    TF_PLUGIN_CACHE_DIR: terraformPluginCache,
  };
}

function commandEnvironment(options: Pick<AwsQuickstartOptions, 'profile' | 'region'>): NodeJS.ProcessEnv {
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
  if (result.status !== 0) throw new Error(`${name} is required for the AWS quickstart`);
}

function capture(name: string, args: string[], options: CommandOptions = {}): string {
  return command(name, args, options).stdout.trim();
}

async function loggedCommand(
  name: string,
  args: string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  const child = spawn(name, args, {
    cwd: projectRoot,
    env: options.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const started = Date.now();
  const heartbeat = setInterval(() => {
    progress(`      still working · ${Math.ceil((Date.now() - started) / 1_000)}s`);
  }, 30_000);
  heartbeat.unref();
  const status = await new Promise<number>((resolveStatus, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolveStatus(code ?? 1));
  }).finally(() => clearInterval(heartbeat));
  const result = { status, stdout, stderr };
  await appendCommandLog(name, args, result);
  assertCommandSucceeded(name, args, result);
  return result;
}

async function captureWithProgress(
  name: string,
  args: string[],
  options: CommandOptions = {},
): Promise<string> {
  const child = spawn(name, args, {
    cwd: projectRoot,
    env: options.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
    process.stderr.write(chunk);
  });
  const status = await new Promise<number>((resolveStatus, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolveStatus(code ?? 1));
  });
  const result = { status, stdout, stderr };
  await appendCommandLog(name, args, result);
  assertCommandSucceeded(name, args, result);
  return stdout.trim();
}

async function appendCommandLog(
  name: string,
  args: string[],
  result: CommandResult,
): Promise<void> {
  await appendFile(debugLogPath, [
    '',
    `$ ${name} ${args.join(' ')}`,
    result.stdout,
    result.stderr,
    `[exit ${result.status}]`,
    '',
  ].join('\n'), { encoding: 'utf8', mode: 0o600 });
}

function assertCommandSucceeded(name: string, args: string[], result: CommandResult): void {
  if (result.status === 0) return;
  const diagnostic = (result.stderr.trim() || result.stdout.trim()).split('\n').slice(-12).join('\n');
  throw new Error(
    `${name} ${args.join(' ')} failed (${result.status}). Full output: .runtime/aws-quickstart/quickstart.log${diagnostic ? `\n${diagnostic}` : ''}`,
  );
}

function command(name: string, args: string[], options: CommandOptions = {}): CommandResult {
  const result = spawnSync(name, args, {
    cwd: projectRoot,
    env: options.env ?? process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
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

async function confirm(skip: boolean, question: string): Promise<void> {
  if (skip) return;
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await terminal.question(`${question} [y/N] `);
    if (!/^y(?:es)?$/i.test(answer.trim())) throw new Error('cancelled');
  } finally {
    terminal.close();
  }
}

function progress(message: string): void {
  process.stderr.write(`${message}\n`);
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== 'string' || !value) throw new Error(message);
  return value;
}

function printValue(value: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(value)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printHelp(): void {
  process.stdout.write(`Rat Things ten-minute AWS quickstart\n\n`);
  process.stdout.write(`  npm run quickstart:aws\n`);
  process.stdout.write(`  npm run quickstart:aws -- status\n`);
  process.stdout.write(`  npm run quickstart:aws -- destroy\n\n`);
  process.stdout.write(`The default runs a real Codex Thing with paid Amazon Bedrock tokens.\n`);
  process.stdout.write(`Use --driver mock for a token-free infrastructure proof that is explicitly not a model.\n\n`);
  process.stdout.write(`Options:\n`);
  process.stdout.write(`  --region REGION                     default: AWS_REGION or us-west-2\n`);
  process.stdout.write(`  --profile PROFILE                   AWS shared-credentials profile\n`);
  process.stdout.write(`  --environment NAME                  default: quickstart\n`);
  process.stdout.write(`  --driver codex|mock                 default: codex\n`);
  process.stdout.write(`  --model MODEL                       default: openai.gpt-5.6-terra\n`);
  process.stdout.write(`  --microvm-base-image-version VALUE  override automatic discovery\n`);
  process.stdout.write(`  --dry-run                            make no external changes\n`);
  process.stdout.write(`  --yes                                skip confirmation\n`);
  process.stdout.write(`  --json                               compact final output\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
