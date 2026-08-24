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
  ListMicrovmsCommand,
} from '@aws-sdk/client-lambda-microvms';
import { getTokenProvider } from '@aws/bedrock-token-generator';
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
const defaultCodexModel = 'openai.gpt-5.6-terra';
const microvmRegions = new Set([
  'ap-northeast-1',
  'eu-west-1',
  'us-east-1',
  'us-east-2',
  'us-west-2',
]);
const defaultCodexRegions = new Set(['us-east-1', 'us-east-2', 'us-west-2']);

export interface AwsQuickstartOptions {
  command: 'setup' | 'preflight' | 'status' | 'destroy' | 'help';
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

interface QuickstartRunEvidence {
  runId: string;
  status: 'succeeded';
  invocation: 'test' | 'manual';
  revision: number;
  specHash: string;
  outputPreview: string;
}

interface QuickstartResult {
  version: 2;
  status: 'ready' | 'destroyed';
  apiUrl: string;
  region: string;
  environment: string;
  driver: 'codex' | 'mock';
  model?: string;
  baseImageVersion: string;
  source: {
    repository: 'https://github.com/gpazo/Rat-Things';
    commit: string;
    clean: boolean;
  };
  terraformManagedResourceCount: number;
  proofMarker: string;
  thing: {
    thingId: string;
    status: 'active';
    activeRevision: number;
    specHash: string;
  };
  runs: {
    draftTest: QuickstartRunEvidence;
    active: QuickstartRunEvidence;
  };
  measurementScope: 'quickstart command through successful active-revision Run';
  startedAt: string;
  completedAt: string;
  destroyedAt?: string;
  teardown?: {
    terraformStateEntries: 0;
    listedMicrovms: number;
    activeMicrovms: 0;
    kmsKey: {
      enabled: false;
      state: 'PendingDeletion';
      deletionDate: string;
    };
  };
  elapsedSeconds: number;
  underTenMinutes: boolean;
}

interface QuickstartPreflight {
  version: 2;
  status: 'ready';
  createsOrModifiesAwsResources: false;
  region: string;
  tools: Record<'node' | 'npm' | 'git' | 'terraform' | 'aws', string>;
  aws: {
    accountId: string;
    principalArn: string;
  };
  microvm: {
    serviceReachable: true;
    baseImage: 'al2023-1';
    baseImageVersion: string;
    capacityProvenOnlyByLiveRun: true;
  };
  agent: {
    driver: 'codex' | 'mock';
    model?: string;
    modelVisible?: true;
    modelInvocationProvenOnlyByLiveRun: true;
  };
}

export function parseAwsQuickstartOptions(argv: string[]): AwsQuickstartOptions {
  const args = [...argv];
  let command: AwsQuickstartOptions['command'] = 'setup';
  if (['setup', 'preflight', 'status', 'destroy'].includes(args[0] ?? '')) {
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

  const driver = values.get('driver') ?? 'codex';
  if (driver !== 'codex' && driver !== 'mock') throw new Error('--driver must be codex or mock');
  const model = values.get('model') ?? defaultCodexModel;
  if (!model || /[\r\n]/.test(model)) throw new Error('--model must be a non-empty single-line value');
  const region = values.get('region') ?? process.env.AWS_REGION ??
    process.env.AWS_DEFAULT_REGION ?? 'us-west-2';
  if (!microvmRegions.has(region)) {
    throw new Error(
      `Lambda MicroVM quickstart is not supported in ${region}; use ap-northeast-1, eu-west-1, ` +
      'us-east-1, us-east-2, or us-west-2',
    );
  }
  if (driver === 'codex' && model === defaultCodexModel && !defaultCodexRegions.has(region)) {
    throw new Error(
      `the default Lambda MicroVM + ${defaultCodexModel} quickstart is not supported in ${region}; ` +
      'use us-east-1, us-east-2, or us-west-2',
    );
  }
  const environment = values.get('environment') ?? 'quickstart';
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(environment)) {
    throw new Error('--environment must contain 1-32 letters, numbers, underscores, or hyphens');
  }
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
  if (options.command === 'preflight') return printPreflight(options);
  if (options.command === 'status') return status(options);
  if (options.command === 'destroy') return destroy(options);
  return setup(options);
}

async function printPreflight(options: AwsQuickstartOptions): Promise<void> {
  printValue(await preflight(options), options.json);
}

async function preflight(options: AwsQuickstartOptions): Promise<QuickstartPreflight> {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 20) {
    throw new Error(`Node.js 20 or newer is required; found ${process.version}`);
  }
  const tools = {
    node: process.version,
    npm: toolVersion('npm'),
    git: toolVersion('git'),
    terraform: toolVersion('terraform'),
    aws: toolVersion('aws'),
  };
  const env = commandEnvironment(options);
  const identity = JSON.parse(capture('aws', ['sts', 'get-caller-identity', '--output', 'json'], { env })) as {
    Account?: unknown;
    Arn?: unknown;
  };
  const accountId = requiredString(identity.Account, 'AWS returned no account ID');
  const principalArn = requiredString(identity.Arn, 'AWS returned no principal ARN');
  const baseImageVersion = options.baseImageVersion ?? await discoverBaseImageVersion(options);
  if (options.driver === 'codex') await assertBedrockModelVisible(options);
  return {
    version: 2,
    status: 'ready',
    createsOrModifiesAwsResources: false,
    region: options.region,
    tools,
    aws: { accountId, principalArn },
    microvm: {
      serviceReachable: true,
      baseImage: 'al2023-1',
      baseImageVersion,
      capacityProvenOnlyByLiveRun: true,
    },
    agent: {
      driver: options.driver,
      ...(options.driver === 'codex' ? { model: options.model, modelVisible: true as const } : {}),
      modelInvocationProvenOnlyByLiveRun: true,
    },
  };
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
      finish: 'create, explain, test, publish, and invoke one safe manual Thing',
    }, options.json);
    return;
  }

  await mkdir(quickstartRoot, { recursive: true, mode: 0o700 });
  await mkdir(terraformPluginCache, { recursive: true, mode: 0o700 });
  await writeFile(debugLogPath, `Rat Things AWS quickstart\nStarted ${new Date().toISOString()}\n`, {
    mode: 0o600,
  });
  progress('[1/6] Verify local tools, AWS identity, MicroVM access, and model visibility');
  const readiness = await preflight(options);
  progress('      ready');
  const env = commandEnvironment(options);
  const baseImageVersion = readiness.microvm.baseImageVersion;
  const started = journeyStartedAt();
  const startedAt = new Date(started).toISOString();

  progress([
    'Rat Things ten-minute AWS quickstart',
    `AWS account: ${readiness.aws.accountId} (${readiness.aws.principalArn})`,
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
  progress('[2/6] Package Rat Things');
  await loggedCommand('npm', ['run', 'package'], { env });
  progress('      ready');

  progress('[3/6] Deploy the disposable AWS backend');
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
  progress('[4/6] Verify discovery and the authenticated API');
  await loggedCommand(process.execPath, cliArguments(['doctor', '--json']), { env: cliEnv });
  progress('      healthy');

  const marker = `RAT-THINGS-READY-${randomUUID().slice(0, 8).toUpperCase()}`;
  await writeFile(thingPath, `${JSON.stringify(awsQuickstartThing(options.driver, marker), null, 2)}\n`, {
    mode: 0o600,
  });
  progress('[5/6] Create → explain → test → publish the exact Thing revision');
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
    testRun?: {
      runId?: unknown;
      status?: unknown;
      thing?: { thingId?: unknown; revision?: unknown; specHash?: unknown; invocation?: unknown };
      result?: { preview?: unknown };
    };
    thing?: {
      thingId?: unknown;
      status?: unknown;
      active?: { revision?: unknown; specHash?: unknown };
    };
  };
  const thingId = requiredString(release.created?.thingId, 'release returned no Thing ID');
  if (
    release.released !== true ||
    release.testRun?.status !== 'succeeded' ||
    release.thing?.status !== 'active'
  ) throw new Error('the first Thing did not reach active after a successful exact-draft test');
  const activeRevision = requiredPositiveInteger(
    release.thing.active?.revision,
    'release returned no active Thing revision',
  );
  const specHash = requiredSha256(
    release.thing.active?.specHash,
    'release returned no active Thing specHash',
  );
  const draftTest = quickstartRunEvidence(
    release.testRun,
    'test',
    thingId,
    activeRevision,
    specHash,
    marker,
  );
  progress('      active');

  progress('[6/6] Invoke the published active revision and verify its exact evidence');
  const activeRunRaw = JSON.parse(await captureWithProgress(process.execPath, cliArguments([
    'thing-run',
    thingId,
    '--wait',
    '--idempotency-key',
    `quickstart:active:${thingId}:${activeRevision}:${specHash.slice(0, 16)}`,
    '--poll-seconds',
    '2',
    '--wait-timeout',
    '420',
  ]), { env: cliEnv })) as unknown;
  const activeRun = quickstartRunEvidence(
    activeRunRaw,
    'manual',
    thingId,
    activeRevision,
    specHash,
    marker,
  );
  progress('      active revision executed successfully');

  const completed = Date.now();
  const result: QuickstartResult = {
    version: 2,
    status: 'ready',
    apiUrl,
    region: options.region,
    environment: options.environment,
    driver: options.driver,
    ...(options.driver === 'codex' ? { model: options.model } : {}),
    baseImageVersion,
    source: {
      repository: 'https://github.com/gpazo/Rat-Things',
      commit: capture('git', ['rev-parse', 'HEAD']),
      clean: capture('git', ['status', '--porcelain']) === '',
    },
    terraformManagedResourceCount: terraformManagedResourceCount(env),
    proofMarker: marker,
    thing: { thingId, status: 'active', activeRevision, specHash },
    runs: { draftTest, active: activeRun },
    measurementScope: 'quickstart command through successful active-revision Run',
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
  const thing = JSON.parse(capture(process.execPath, cliArguments(['thing', result.thing.thingId]), {
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
  const kmsKeyId = terraformKmsKeyId(env);
  const microvm = command('terraform', [
    '-chdir=infra',
    'output',
    `-state=${statePath}`,
    '-json',
    'microvm',
  ], { env: terraformEnv, allowFailure: true });
  if (microvm.status !== 0) throw new Error('could not resolve the quickstart MicroVM image before teardown');
  const imageArn = requiredString(
    (JSON.parse(microvm.stdout) as { image_arn?: unknown }).image_arn,
    'the quickstart Terraform state returned no MicroVM image ARN',
  );
  progress('[1/3] Terminate quickstart MicroVMs');
  const termination = await loggedCommand(
    process.execPath,
    [join(projectRoot, 'scripts', 'terminate-microvms.mjs'), result.region, imageArn],
    { env },
  );
  if (termination.stdout.trim()) {
    progress(`      ${termination.stdout.trim()}`);
  }
  progress('[2/3] Destroy the quickstart AWS backend');
  await loggedCommand('terraform', [
    '-chdir=infra',
    'destroy',
    `-state=${statePath}`,
    `-var-file=${configPath}`,
    '-input=false',
    '-auto-approve',
    '-compact-warnings',
  ], { env: terraformEnv });
  progress('[3/3] Verify empty state, no active MicroVMs, and the KMS deletion window');
  const terraformStateEntries = terraformStateEntryCount(env);
  if (terraformStateEntries !== 0) {
    throw new Error(`quickstart teardown left ${terraformStateEntries} Terraform state entries`);
  }
  const microvms = await microvmTeardownStatus(options, result.region, imageArn);
  if (microvms.activeMicrovms !== 0) {
    throw new Error(`quickstart teardown left ${microvms.activeMicrovms} active MicroVMs`);
  }
  const kmsKey = kmsTeardownStatus(env, kmsKeyId);
  if (kmsKey.enabled || kmsKey.state !== 'PendingDeletion') {
    throw new Error(`quickstart KMS key is ${kmsKey.state} after teardown instead of PendingDeletion`);
  }
  progress('      destroyed and verified');
  const destroyed: QuickstartResult = {
    ...result,
    status: 'destroyed',
    destroyedAt: new Date().toISOString(),
    teardown: {
      terraformStateEntries: 0,
      listedMicrovms: microvms.listedMicrovms,
      activeMicrovms: 0,
      kmsKey: {
        enabled: false,
        state: 'PendingDeletion',
        deletionDate: kmsKey.deletionDate,
      },
    },
  };
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

async function assertBedrockModelVisible(options: AwsQuickstartOptions): Promise<void> {
  let response: Response;
  try {
    const token = await getTokenProvider({
      region: options.region,
      expiresInSeconds: 900,
      ...(options.profile ? { profile: options.profile } : {}),
    })();
    response = await fetch(`https://bedrock-mantle.${options.region}.api.aws/v1/models`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new Error(
      `could not check the Amazon Bedrock model catalog: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new Error(`Amazon Bedrock model-catalog check failed with HTTP ${response.status}`);
  }
  const payload = await response.json() as { data?: Array<{ id?: unknown }> };
  const modelIds = Array.isArray(payload.data)
    ? payload.data.flatMap((item) => typeof item.id === 'string' ? [item.id] : [])
    : [];
  if (!modelIds.includes(options.model)) {
    throw new Error(
      `Amazon Bedrock model ${options.model} is not visible in ${options.region}; choose an available --model or fix model access`,
    );
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

function toolVersion(name: string): string {
  const result = command(name, ['--version'], { allowFailure: true });
  if (result.status !== 0) throw new Error(`${name} is required for the AWS quickstart`);
  return requiredString(
    (result.stdout.trim() || result.stderr.trim()).split('\n')[0],
    `${name} returned no version`,
  );
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

function requiredPositiveInteger(value: unknown, message: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) throw new Error(message);
  return Number(value);
}

function requiredSha256(value: unknown, message: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error(message);
  return value;
}

function journeyStartedAt(): number {
  const raw = process.env.RAT_THINGS_QUICKSTART_STARTED_AT_MS;
  if (!raw) return Date.now();
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > Date.now()) {
    throw new Error('RAT_THINGS_QUICKSTART_STARTED_AT_MS is invalid');
  }
  return value;
}

function terraformStateAddresses(env: NodeJS.ProcessEnv): string[] {
  const listed = capture('terraform', [
    '-chdir=infra',
    'state',
    'list',
    `-state=${statePath}`,
  ], { env: terraformEnvironment(env) });
  return listed ? listed.split('\n').filter(Boolean) : [];
}

function terraformManagedResourceCount(env: NodeJS.ProcessEnv): number {
  return managedTerraformAddresses(terraformStateAddresses(env)).length;
}

export function managedTerraformAddresses(addresses: string[]): string[] {
  return addresses.filter((address) => !/(^|\.)data\./.test(address));
}

function terraformStateEntryCount(env: NodeJS.ProcessEnv): number {
  return terraformStateAddresses(env).length;
}

function terraformKmsKeyId(env: NodeJS.ProcessEnv): string {
  const state = JSON.parse(capture('terraform', [
    '-chdir=infra',
    'show',
    '-json',
    statePath,
  ], { env: terraformEnvironment(env) })) as {
    values?: { root_module?: TerraformStateModule };
  };
  const resources = state.values?.root_module ? terraformModuleResources(state.values.root_module) : [];
  const kms = resources.find((resource) => resource.type === 'aws_kms_key');
  return requiredString(kms?.values?.key_id ?? kms?.values?.id, 'Terraform state returned no KMS key ID');
}

interface TerraformStateModule {
  resources?: Array<{ type?: unknown; values?: Record<string, unknown> }>;
  child_modules?: TerraformStateModule[];
}

function terraformModuleResources(
  module: TerraformStateModule,
): Array<{ type?: unknown; values?: Record<string, unknown> }> {
  return [
    ...(module.resources ?? []),
    ...(module.child_modules ?? []).flatMap(terraformModuleResources),
  ];
}

async function microvmTeardownStatus(
  options: AwsQuickstartOptions,
  region: string,
  imageArn: string,
): Promise<{ listedMicrovms: number; activeMicrovms: number }> {
  const client = new LambdaMicrovmsClient({
    region,
    ...(options.profile ? { credentials: defaultProvider({ profile: options.profile }) } : {}),
  });
  try {
    const items = [];
    let nextToken: string | undefined;
    do {
      const page = await client.send(new ListMicrovmsCommand({
        imageIdentifier: imageArn,
        maxResults: 50,
        ...(nextToken ? { nextToken } : {}),
      }));
      items.push(...(page.items ?? []));
      nextToken = page.nextToken;
    } while (nextToken);
    return {
      listedMicrovms: items.length,
      activeMicrovms: items.filter((item) => item.state !== 'TERMINATED').length,
    };
  } finally {
    client.destroy();
  }
}

function kmsTeardownStatus(
  env: NodeJS.ProcessEnv,
  keyId: string,
): { enabled: boolean; state: string; deletionDate: string } {
  const response = JSON.parse(capture('aws', [
    'kms',
    'describe-key',
    '--key-id',
    keyId,
    '--output',
    'json',
  ], { env })) as {
    KeyMetadata?: { Enabled?: unknown; KeyState?: unknown; DeletionDate?: unknown };
  };
  return {
    enabled: response.KeyMetadata?.Enabled === true,
    state: requiredString(response.KeyMetadata?.KeyState, 'AWS returned no KMS key state'),
    deletionDate: requiredString(response.KeyMetadata?.DeletionDate, 'AWS returned no KMS deletion date'),
  };
}

export function quickstartRunEvidence(
  value: unknown,
  invocation: 'test' | 'manual',
  thingId: string,
  revision: number,
  specHash: string,
  marker: string,
): QuickstartRunEvidence {
  if (!value || typeof value !== 'object') throw new Error(`the ${invocation} Run result is invalid`);
  const record = value as {
    runId?: unknown;
    status?: unknown;
    thing?: { thingId?: unknown; revision?: unknown; specHash?: unknown; invocation?: unknown };
    result?: { preview?: unknown };
  };
  const runId = requiredString(record.runId, `the ${invocation} Run returned no Run ID`);
  if (record.status !== 'succeeded') throw new Error(`the ${invocation} Run ${runId} did not succeed`);
  if (
    record.thing?.thingId !== thingId ||
    record.thing.revision !== revision ||
    record.thing.specHash !== specHash ||
    record.thing.invocation !== invocation
  ) {
    throw new Error(`the ${invocation} Run ${runId} did not bind the expected active Thing revision`);
  }
  const outputPreview = requiredString(
    record.result?.preview,
    `the successful ${invocation} Run returned no output preview`,
  );
  if (!outputPreview.includes(marker)) {
    throw new Error(`the ${invocation} Run ${runId} output did not contain its proof marker ${marker}`);
  }
  return { runId, status: 'succeeded', invocation, revision, specHash, outputPreview };
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
  process.stdout.write(`  npm run quickstart:aws -- preflight\n`);
  process.stdout.write(`  npm run quickstart:aws -- status\n`);
  process.stdout.write(`  npm run quickstart:aws -- destroy\n\n`);
  process.stdout.write(`A fresh clone installs pinned dependencies automatically. Preflight creates or modifies no AWS resources.\n`);
  process.stdout.write(`The default model path runs in us-east-1, us-east-2, or us-west-2.\n`);
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
