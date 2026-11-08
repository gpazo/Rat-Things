import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isIP } from 'node:net';
import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import {
  GetMicrovmCommand,
  GetMicrovmImageVersionCommand,
  LambdaMicrovmsClient,
  ListMicrovmsCommand,
  RunMicrovmCommand,
  TerminateMicrovmCommand,
  type GetMicrovmImageVersionCommandOutput,
  type RunMicrovmCommandOutput,
} from '@aws-sdk/client-lambda-microvms';

const maxProbes = 12;
const maxPairs = 6;
const defaultPairs = 5;
const probeDeadlineMs = 120_000;
const cleanupGraceMs = 60_000;
const evidenceDeadlineMs = 55_000;
const totalDeadlineMs = 30 * 60_000;
const maxLogEvents = 1_000;
const maxLogBytes = 512_000;
const profilePrefix = 'storage-mount-profile ';
const profileSchema = 'rat-things.storage-mount-profile.v1';
const allIngress = 'network-connector:aws-network-connector:ALL_INGRESS';
const executeFile = promisify(execFile);

export type ImageSide = 'baseline' | 'candidate';
export type ProbeMode = 'storage' | 'control';

export interface StorageProbeConfig {
  deploymentId: string;
  region: string;
  account: string;
  imageIdentifier: string;
  baselineVersion: string;
  candidateVersion: string;
  executionRoleArn: string;
  connectorArn: string;
  logGroupName: string;
  runsTableName: string;
  integrationsTableName: string;
  artifactBucket: string;
  filesystem: string;
  accesspoint: string;
  targetIP: string;
}

export interface ProbePlan {
  index: number;
  pair: number | null;
  side: ImageSide;
  mode: ProbeMode;
}

export interface ProbeWindow {
  workDeadline: number;
  cleanupDeadline: number;
}

export interface Options {
  configPath: string;
  outputPath: string;
  pairs: number;
  diagnostic: { side: ImageSide; mode: ProbeMode } | null;
  expectProfile: boolean;
}

interface ImageProvenance {
  imageArn: string;
  imageVersion: string;
  state: string | null;
  status: string | null;
  baseImageArn: string | null;
  baseImageVersion: string | null;
  buildRoleArn: string | null;
  codeArtifact: unknown;
  resources: unknown[];
  cpuConfigurations: unknown[];
  egressNetworkConnectors: string[];
  createdAt: string | null;
  sourceTags: Record<string, string>;
}

interface ProbePhase {
  phase: string;
  atUtc: string;
  elapsedMs: number;
}

interface ProbeEvidence {
  storageMount: { durationMs: number; atUtc: string } | null;
  runnerStarted: {
    startupDurationMs: number;
    storageMountDurationMs: number;
    storagePreparationDurationMs: number;
    storageAlreadyMounted: boolean;
    atUtc: string;
  };
  missingRunFailure: { message: string; atUtc: string };
  runnerExited: { code: number | null; signal: string | null; atUtc: string };
  profile: Record<string, unknown> | null;
}

interface ProbeSample extends ProbePlan {
  runId: string;
  logStreamName: string;
  imageVersion: string;
  status: 'running' | 'passed' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  phases: ProbePhase[];
  microvmId?: string;
  actualImage?: { imageArn: string; imageVersion: string; executionRoleArn: string | null; state: string | null };
  evidence?: ProbeEvidence;
  runRecordAbsentBefore?: boolean;
  runRecordAbsentAfter?: boolean;
  cleanup?: { terminateRequests: number; state: string | null; verifiedTerminated: boolean };
  failure?: string;
  cleanupFailure?: string;
  ambiguousLaunch?: boolean;
  launchReconciled?: boolean;
  possibleMicrovmIds?: string[];
}

interface ProbeArtifact {
  schema: 'rat-things.storage-startup-probe.v1';
  status: 'running' | 'passed' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  configFingerprint: string;
  deployment: { deploymentId: string; region: string; account: string; imageIdentifier: string };
  confirmation: { disposableDeployment: true; inferenceDenyInstalled: true };
  limits: { plannedProbes: number; maxProbes: number; probeDeadlineMs: number; cleanupGraceMs: number; totalDeadlineMs: number; awsMaxAttempts: 1 };
  imageProvenance?: { baseline: ImageProvenance; candidate: ImageProvenance; sameWorkerResources: true };
  probes: ProbeSample[];
  failure?: string;
}

const expectedConfigKeys = [
  'deploymentId', 'region', 'account', 'imageIdentifier', 'baselineVersion', 'candidateVersion',
  'executionRoleArn', 'connectorArn', 'logGroupName', 'runsTableName', 'integrationsTableName',
  'artifactBucket', 'filesystem', 'accesspoint', 'targetIP',
] as const;

export function parseArguments(args: readonly string[]): Options {
  const values = new Map<string, string>();
  let expectProfile = false;
  const valueFlags = new Set(['--config', '--output', '--pairs', '--diagnostic', '--version']);
  for (let index = 0; index < args.length;) {
    const name = args[index]!;
    if (name === '--expect-profile') {
      if (expectProfile) throw new Error('Duplicate --expect-profile.');
      expectProfile = true;
      index++;
      continue;
    }
    const value = args[index + 1];
    if (!valueFlags.has(name) || value === undefined || value.startsWith('--') || values.has(name)) {
      throw new Error('Invalid or duplicate storage probe argument.');
    }
    values.set(name, value);
    index += 2;
  }
  const config = values.get('--config');
  const output = values.get('--output');
  if (!config || !output) throw new Error('--config and --output are required.');
  const pairsText = values.get('--pairs');
  const pairs = pairsText === undefined ? defaultPairs : Number(pairsText);
  if (pairsText !== undefined && !/^\d+$/.test(pairsText) || !Number.isSafeInteger(pairs) || pairs < 1 || pairs > maxPairs) {
    throw new Error('--pairs must be an integer from 1 through 6.');
  }
  const diagnosticText = values.get('--diagnostic');
  const versionText = values.get('--version');
  let diagnostic: Options['diagnostic'] = null;
  if (diagnosticText !== undefined || versionText !== undefined) {
    if (!['storage', 'control'].includes(diagnosticText ?? '') || !['baseline', 'candidate'].includes(versionText ?? '')) {
      throw new Error('A diagnostic requires --diagnostic storage|control and --version baseline|candidate.');
    }
    if (pairsText !== undefined) throw new Error('--pairs cannot be combined with a diagnostic.');
    diagnostic = { mode: diagnosticText as ProbeMode, side: versionText as ImageSide };
  }
  if (expectProfile && (!diagnostic || diagnostic.mode !== 'storage')) {
    throw new Error('--expect-profile requires one storage diagnostic sample.');
  }
  const options = {
    configPath: resolve(config), outputPath: resolve(output), pairs, diagnostic, expectProfile,
  };
  if (planProbes(options).length > maxProbes) throw new Error('Probe plan exceeds the 12-launch limit.');
  return options;
}

export function parseConfiguration(input: unknown): StorageProbeConfig {
  if (!isRecord(input)) throw new Error('Configuration must be a JSON object.');
  const extra = Object.keys(input).filter(key => !(expectedConfigKeys as readonly string[]).includes(key));
  const missing = expectedConfigKeys.filter(key => typeof input[key] !== 'string' || input[key] === '');
  if (extra.length || missing.length) throw new Error('Configuration must contain the 15 documented string fields only.');
  return input as unknown as StorageProbeConfig;
}

export function validateConfiguration(config: StorageProbeConfig, allowSameVersions = false): StorageProbeConfig {
  const deploymentName = `rat-things-${config.deploymentId}`;
  const partition = config.region.startsWith('us-gov-') ? 'aws-us-gov' : config.region.startsWith('cn-') ? 'aws-cn' : 'aws';
  if (!/^[a-z0-9][a-z0-9-]{2,13}$/.test(config.deploymentId) || /(^|-)prod(uction)?(-|$)|(^|-)primary(-|$)|(^|-)main(-|$)/i.test(config.deploymentId)) {
    throw new Error('Use a disposable deployment ID with 3 through 14 lowercase letters, digits, or hyphens.');
  }
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(config.region) || !/^\d{12}$/.test(config.account)) {
    throw new Error('Invalid AWS region or account in configuration.');
  }
  if (!new RegExp(`^arn:${partition}:lambda:${escapeRegex(config.region)}:${config.account}:microvm-image:${escapeRegex(deploymentName)}-agent$`).test(config.imageIdentifier)) {
    throw new Error('MicroVM image must belong to the configured disposable account, region, and deployment.');
  }
  if (!new RegExp(`^arn:${partition}:iam::${config.account}:role/${escapeRegex(deploymentName)}-microvm-execution$`).test(config.executionRoleArn)) {
    throw new Error('Execution role must be the configured deployment’s MicroVM execution role.');
  }
  if (!new RegExp(`^arn:${partition}:lambda:${escapeRegex(config.region)}:${config.account}:network-connector:nc-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`).test(config.connectorArn)) {
    throw new Error('Connector must be an S3 Files network connector in the configured account and region.');
  }
  for (const version of [config.baselineVersion, config.candidateVersion]) {
    if (!/^\d+(?:\.\d+)?$/.test(version)) throw new Error('Image versions must be numeric AWS image version strings.');
  }
  if (!allowSameVersions && config.baselineVersion === config.candidateVersion) throw new Error('Baseline and candidate image versions must differ.');
  if (config.logGroupName !== `/${deploymentName}/microvms`
    || config.runsTableName !== `${deploymentName}-runs`
    || config.integrationsTableName !== `${deploymentName}-integrations`) {
    throw new Error('Log group and DynamoDB tables must match the configured disposable deployment.');
  }
  if (!new RegExp(`^${escapeRegex(deploymentName)}-artifacts-[a-f0-9]{12}$`).test(config.artifactBucket)) {
    throw new Error('Artifact bucket must match the configured disposable deployment.');
  }
  if (!/^fs-[A-Za-z0-9]+$/.test(config.filesystem) || !/^fsap-[A-Za-z0-9]+$/.test(config.accesspoint) || isIP(config.targetIP) === 0) {
    throw new Error('Invalid S3 Files filesystem, access point, or mount target IP.');
  }
  return config;
}

export function planProbes(options: Pick<Options, 'pairs' | 'diagnostic'>): ProbePlan[] {
  if (options.diagnostic) return [{ index: 1, pair: null, ...options.diagnostic }];
  return Array.from({ length: options.pairs }, (_, offset) => {
    const pair = offset + 1;
    const sides: readonly ImageSide[] = pair % 2 === 1 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
    return sides.map(side => ({ index: 0, pair, side, mode: 'storage' as const }));
  }).flat().map((probe, index) => ({ ...probe, index: index + 1 }));
}

export function planProbeWindow(sampleStarted: number, totalDeadline: number): ProbeWindow {
  const workDeadline = sampleStarted + probeDeadlineMs;
  const cleanupDeadline = Math.min(totalDeadline, workDeadline + cleanupGraceMs);
  if (cleanupDeadline < workDeadline + cleanupGraceMs) throw new Error('At least 180 seconds must remain before a MicroVM launch.');
  return { workDeadline, cleanupDeadline };
}

export function planReconciliationDeadline(window: ProbeWindow, now: number): number {
  return Math.min(window.cleanupDeadline, now + 10_000);
}

export function runHookPayload(config: StorageProbeConfig, input: {
  runId: string; generation: string; storageKey: string; mode: ProbeMode;
}): string {
  const payload = {
    version: 1,
    runId: input.runId,
    executionGeneration: input.generation,
    inputBucket: config.artifactBucket,
    inputKey: `storage-probe/no-run-record/${input.runId}.json`,
    runsTableName: config.runsTableName,
    integrationsTableName: config.integrationsTableName,
    artifactBucket: config.artifactBucket,
    eventBusName: `rat-things-${config.deploymentId}-runs`,
    region: config.region,
    timeoutSeconds: 60,
    heartbeatIntervalMs: 15_000,
    traceId: input.runId,
    allowedRepositoryHosts: 'github.com,gitlab.com',
    allowedSandboxModes: 'read-only',
    defaultSandboxMode: 'read-only',
    defaultAgentNetworkAccess: false,
    persistentSession: true,
    ...(input.mode === 'storage' ? {
      sessionStorageKey: input.storageKey,
      s3FilesFileSystemId: config.filesystem,
      s3FilesAccessPointId: config.accesspoint,
      s3FilesMountTargetIp: config.targetIP,
    } : {}),
    allowAgentAwsCredentialChain: false,
  };
  if (!/^[A-Za-z0-9-]{1,128}$/.test(input.runId) || !/^[a-f0-9]{64}$/.test(input.generation)
    || !/^[a-f0-9]{64}$/.test(input.storageKey)) throw new Error('Invalid generated lifecycle hook identity.');
  const encoded = JSON.stringify(payload);
  if (Buffer.byteLength(encoded) > 4_096) throw new Error('Storage probe run hook exceeds the lifecycle payload limit.');
  return encoded;
}

export function imageProvenance(image: GetMicrovmImageVersionCommandOutput): ImageProvenance {
  const sourceTags = Object.fromEntries(Object.entries(image.tags ?? {}).filter(([key, value]) =>
    /source|sha|commit|revision|git/i.test(key) && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(value)));
  return {
    imageArn: image.imageArn ?? '', imageVersion: image.imageVersion ?? '', state: image.state ?? null,
    status: image.status ?? null, baseImageArn: image.baseImageArn ?? null, baseImageVersion: image.baseImageVersion ?? null,
    buildRoleArn: image.buildRoleArn ?? null, codeArtifact: image.codeArtifact ?? null,
    resources: image.resources ?? [], cpuConfigurations: image.cpuConfigurations ?? [],
    egressNetworkConnectors: image.egressNetworkConnectors ?? [],
    createdAt: image.createdAt?.toISOString() ?? null, sourceTags,
  };
}

export function sameWorkerConfiguration(baseline: ImageProvenance, candidate: ImageProvenance): boolean {
  return baseline.baseImageArn === candidate.baseImageArn
    && baseline.baseImageVersion === candidate.baseImageVersion
    && JSON.stringify(sortJson(baseline.resources)) === JSON.stringify(sortJson(candidate.resources))
    && JSON.stringify(sortJson(baseline.cpuConfigurations)) === JSON.stringify(sortJson(candidate.cpuConfigurations));
}

export function analyzeProbeLogs(events: readonly { timestamp: number; message: string }[], expected: {
  runId: string; microvmId: string; mode: ProbeMode; region: string; expectProfile: boolean;
}): ProbeEvidence {
  const lines = events.flatMap(event => event.message.split(/\r?\n/).map(message => ({ timestamp: event.timestamp, message: message.trim() })))
    .filter(event => event.message.length > 0).sort((left, right) => left.timestamp - right.timestamp);
  const objects = lines.flatMap(line => {
    if (line.message.startsWith(profilePrefix)) {
      try { return [{ timestamp: line.timestamp, value: parseProfile(line.message.slice(profilePrefix.length)) }]; } catch { return []; }
    }
    try {
      const value: unknown = JSON.parse(line.message);
      return isRecord(value) ? [{ timestamp: line.timestamp, value }] : [];
    } catch { return []; }
  });
  const mounts = objects.filter(({ value }) => value.message === 'S3 Files Session state mounted');
  if (expected.mode === 'storage' && mounts.length !== 1) throw new Error('Missing or duplicate S3 Files mount log.');
  if (expected.mode === 'control' && mounts.length !== 0) throw new Error('No-storage control unexpectedly logged an S3 Files mount.');
  const mount = mounts[0];
  const mountDurationMs = mount ? finiteNumber(mount.value.durationMs, 'S3 Files mount duration') : null;
  const runnerLogs = objects.filter(({ value }) => value.message === 'agent runner started'
    && value.runId === expected.runId && value.microvmId === expected.microvmId);
  if (runnerLogs.length !== 1) throw new Error('Missing or duplicate matching runner-start log.');
  const runner = runnerLogs[0]!;
  const startupDurationMs = finiteNumber(runner.value.startupDurationMs, 'runner startup duration');
  const storageMountDurationMs = finiteNumber(runner.value.storageMountDurationMs, 'runner storage mount duration');
  const storagePreparationDurationMs = finiteNumber(runner.value.storagePreparationDurationMs, 'storage preparation duration');
  if (typeof runner.value.storageAlreadyMounted !== 'boolean' || runner.value.storageAlreadyMounted) {
    throw new Error('Runner log must confirm that storage was newly mounted.');
  }
  if (expected.mode === 'storage' && storageMountDurationMs < 0) throw new Error('Storage mount duration is invalid.');
  if (expected.mode === 'control' && (storageMountDurationMs !== 0 || storagePreparationDurationMs !== 0)) {
    throw new Error('No-storage control reported storage work.');
  }
  if (mountDurationMs !== null && mountDurationMs > storageMountDurationMs) throw new Error('Mount duration exceeds the enclosing runner storage duration.');

  const failures = objects.filter(({ value }) => value.message === 'agent worker failed');
  const missingRun = failures.find(({ value }) => isRecord(value.error) && value.error.message === `run ${expected.runId} does not exist`);
  if (failures.length !== 1 || !missingRun) throw new Error('Missing expected runner failure for the absent Run record.');
  const exitedLogs = objects.filter(({ value }) => value.message === 'agent runner exited' && value.runId === expected.runId);
  if (exitedLogs.length !== 1) throw new Error('Missing or duplicate runner-exit log.');
  const exited = exitedLogs[0]!;
  if (typeof exited.value.code !== 'number' || exited.value.code === 0 || (exited.value.signal !== null && typeof exited.value.signal !== 'string')) {
    throw new Error('Runner must exit unsuccessfully after the missing Run record.');
  }
  const profiles = objects.flatMap(({ timestamp, value }) => value.schema === profileSchema ? [{ timestamp, value }] : []);
  if (expected.expectProfile && profiles.length !== 1) throw new Error('Missing or duplicate expected storage mount profile.');
  if (!expected.expectProfile && profiles.length > 0) throw new Error('Unexpected storage mount profile in a production or unprofiled probe.');
  let profile: Record<string, unknown> | null = profiles[0]?.value ?? null;
  if (profile) {
    validateProfile(profile, expected.region);
    if (profile.outcome !== 'success') throw new Error('Storage mount profile reports a failed mount.');
    if (expected.mode === 'control') throw new Error('A no-storage control emitted a mount profile.');
    profile = safeProfile(profile);
  }
  return {
    storageMount: mount ? { durationMs: mountDurationMs!, atUtc: new Date(mount.timestamp).toISOString() } : null,
    runnerStarted: {
      startupDurationMs, storageMountDurationMs, storagePreparationDurationMs,
      storageAlreadyMounted: runner.value.storageAlreadyMounted,
      atUtc: new Date(runner.timestamp).toISOString(),
    },
    missingRunFailure: {
      message: `run ${expected.runId} does not exist`, atUtc: new Date(missingRun.timestamp).toISOString(),
    },
    runnerExited: {
      code: exited.value.code, signal: typeof exited.value.signal === 'string' ? exited.value.signal : null,
      atUtc: new Date(exited.timestamp).toISOString(),
    },
    profile,
  };
}

export async function run(options: Options, environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = validateConfiguration(parseConfiguration(JSON.parse(await readFile(options.configPath, 'utf8')) as unknown), options.diagnostic !== null);
  requireOptIns(environment);
  const started = performance.now();
  const deadline = started + totalDeadlineMs;
  const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: config.region, maxAttempts: 1 }));
  const microvms = new LambdaMicrovmsClient({ region: config.region, maxAttempts: 1 });
  const stop = new AbortController();
  const stopRun = () => stop.abort();
  process.once('SIGINT', stopRun);
  process.once('SIGTERM', stopRun);
  let artifact: ProbeArtifact | undefined;
  let outputCreated = false;
  try {
    if (await fileExists(options.outputPath)) throw new Error('Output path already exists. Choose a new artifact path.');
    const identity = await awsJson(['sts', 'get-caller-identity', '--region', config.region, '--output', 'json'], deadline);
    if (!isRecord(identity) || identity.Account !== config.account) throw new Error('STS caller account does not match the disposable configuration.');
    const [baselineRaw, candidateRaw] = await Promise.all([
      microvms.send(new GetMicrovmImageVersionCommand({ imageIdentifier: config.imageIdentifier, imageVersion: config.baselineVersion }), { abortSignal: signalBefore(deadline, 'total') }),
      microvms.send(new GetMicrovmImageVersionCommand({ imageIdentifier: config.imageIdentifier, imageVersion: config.candidateVersion }), { abortSignal: signalBefore(deadline, 'total') }),
    ]);
    const baseline = imageProvenance(baselineRaw);
    const candidate = imageProvenance(candidateRaw);
    if (baseline.imageArn !== config.imageIdentifier || candidate.imageArn !== config.imageIdentifier
      || baseline.imageVersion !== config.baselineVersion || candidate.imageVersion !== config.candidateVersion
      || [baseline, candidate].some(image => image.status !== 'ACTIVE' || image.state !== 'SUCCESSFUL' || image.resources.length === 0)
      || !sameWorkerConfiguration(baseline, candidate)) {
      throw new Error('Image versions must be active successful builds with matching base image, CPU, and resource configuration.');
    }
    artifact = {
      schema: 'rat-things.storage-startup-probe.v1', status: 'running', startedAt: new Date().toISOString(), finishedAt: null,
      configFingerprint: sha256(JSON.stringify(config)),
      deployment: { deploymentId: config.deploymentId, region: config.region, account: config.account, imageIdentifier: config.imageIdentifier },
      confirmation: { disposableDeployment: true, inferenceDenyInstalled: true },
      limits: { plannedProbes: planProbes(options).length, maxProbes, probeDeadlineMs, cleanupGraceMs, totalDeadlineMs, awsMaxAttempts: 1 },
      imageProvenance: { baseline, candidate, sameWorkerResources: true }, probes: [],
    };
    await saveArtifact(options.outputPath, artifact);
    outputCreated = true;

    const existing = await listMicrovms(microvms, config.imageIdentifier, deadline);
    const active = existing.filter(vm => vm.state !== 'TERMINATED');
    if (active.length) throw new Error('Disposable deployment already has a non-terminated MicroVM for this image.');

    const plan = planProbes(options);
    if (plan.length > maxProbes) throw new Error('Probe plan exceeds the 12-launch limit.');
    for (const planned of plan) {
      if (stop.signal.aborted) throw new Error('Probe interrupted before the next MicroVM launch.');
      if (deadline - performance.now() < probeDeadlineMs + cleanupGraceMs) throw new Error('Probe stopped before the 30-minute budget could fit another bounded MicroVM and cleanup.');
      const imageVersion = planned.side === 'baseline' ? config.baselineVersion : config.candidateVersion;
      const runId = randomUUID();
      const sample: ProbeSample = {
        ...planned, runId, logStreamName: `storage-probe-${runId}`, imageVersion, status: 'running',
        startedAt: new Date().toISOString(), finishedAt: null, phases: [],
      };
      artifact.probes.push(sample);
      await saveArtifact(options.outputPath, artifact);
      const sampleStarted = performance.now();
      await runOneProbe({ config, planned, sample, options, artifact, dynamo, microvms, deadline, sampleStarted, stopSignal: stop.signal });
      console.log(JSON.stringify({ index: sample.index, side: sample.side, mode: sample.mode, imageVersion, microvmId: sample.microvmId,
        storageMountDurationMs: sample.evidence?.runnerStarted.storageMountDurationMs ?? 0, status: sample.status }));
      if (sample.status !== 'passed') throw new Error(sample.failure ?? sample.cleanupFailure ?? 'Storage probe did not pass.');
    }
    artifact.status = artifact.probes.length === plan.length && artifact.probes.every(sample => sample.status === 'passed') ? 'passed' : 'failed';
  } catch (error) {
    if (artifact) {
      artifact.status = 'failed';
      artifact.failure = safeFailure(error);
    }
    process.exitCode = 1;
  } finally {
    try {
      if (artifact) {
        artifact.finishedAt = new Date().toISOString();
        if (outputCreated || artifact.probes.length) await saveArtifact(options.outputPath, artifact);
      }
    } finally {
      process.removeListener('SIGINT', stopRun);
      process.removeListener('SIGTERM', stopRun);
      dynamo.destroy(); microvms.destroy();
    }
  }
  if (artifact?.status !== 'passed') throw new Error(artifact?.failure ?? 'Storage probe failed.');
}

async function runOneProbe(input: {
  config: StorageProbeConfig; planned: ProbePlan; sample: ProbeSample; options: Options; artifact: ProbeArtifact;
  dynamo: DynamoDBDocumentClient; microvms: LambdaMicrovmsClient; deadline: number; sampleStarted: number; stopSignal: AbortSignal;
}): Promise<void> {
  const { config, planned, sample, options, artifact, dynamo, microvms, deadline, sampleStarted, stopSignal } = input;
  let window: ProbeWindow | undefined;
  let workDeadline = sampleStarted;
  let cleanupDeadline = sampleStarted;
  let createdId: string | undefined;
  let primaryFailure: string | undefined;
  let runWasChecked = false;
  const phase = (name: string) => {
    sample.phases.push({ phase: name, atUtc: new Date().toISOString(), elapsedMs: performance.now() - sampleStarted });
  };
  try {
    window = planProbeWindow(sampleStarted, deadline);
    workDeadline = window.workDeadline;
    cleanupDeadline = window.cleanupDeadline;
    phase('run-record-absent-before');
    if (await readRun(dynamo, config.runsTableName, sample.runId, workDeadline, stopSignal)) {
      throw new Error('Generated Run ID already exists.');
    }
    sample.runRecordAbsentBefore = true;
    runWasChecked = true;
    await saveArtifact(options.outputPath, artifact);
    const beforeIds = new Set((await listMicrovms(microvms, config.imageIdentifier, workDeadline, sample.imageVersion)).map(vm => vm.microvmId));
    const generation = randomBytes(32).toString('hex');
    const storageKey = randomBytes(32).toString('hex');
    const hook = runHookPayload(config, { runId: sample.runId, generation, storageKey, mode: planned.mode });
    const launchStarted = new Date();
    phase('run-microvm-request-started');
    await saveArtifact(options.outputPath, artifact);
    const launchDeadline = Math.min(workDeadline, performance.now() + 30_000);
    const request = new RunMicrovmCommand({
      imageIdentifier: config.imageIdentifier,
      imageVersion: sample.imageVersion,
      executionRoleArn: config.executionRoleArn,
      egressNetworkConnectors: [config.connectorArn],
      ingressNetworkConnectors: [`arn:aws:lambda:${config.region}:aws:${allIngress}`],
      logging: { cloudWatch: { logGroup: config.logGroupName, logStream: sample.logStreamName } },
      runHookPayload: hook,
      idlePolicy: { autoResumeEnabled: true, maxIdleDurationSeconds: 1_200, suspendedDurationSeconds: 21_600 },
      maximumDurationInSeconds: Math.ceil(probeDeadlineMs / 1_000),
      clientToken: sample.runId,
    });
    let response: RunMicrovmCommandOutput | undefined;
    try {
      response = await microvms.send(request, { abortSignal: signalBefore(launchDeadline, 'probe', stopSignal) });
    } catch (error) {
      sample.ambiguousLaunch = true;
      const recovered = await reconcileLaunch(microvms, config, sample, beforeIds, launchStarted.getTime(), window);
      if (recovered.length === 1) {
        createdId = recovered[0]!.microvmId;
        sample.microvmId = createdId;
        sample.launchReconciled = true;
        sample.failure = `RunMicrovm response was uncertain (${safeFailure(error)}); recovered the unique new MicroVM and will verify its cleanup.`;
        phase('run-microvm-reconciled-from-list');
      } else {
        sample.possibleMicrovmIds ??= recovered.map(vm => vm.microvmId);
        throw new Error(`RunMicrovm response was uncertain (${safeFailure(error)}); no unique created MicroVM could be identified. Check possibleMicrovmIds and the 120-second platform lifetime cap.`);
      }
    }
    if (!createdId && response?.microvmId) createdId = response.microvmId;
    if (!createdId) {
      sample.ambiguousLaunch = true;
      const recovered = await reconcileLaunch(microvms, config, sample, beforeIds, launchStarted.getTime(), window);
      if (recovered.length !== 1) {
        sample.possibleMicrovmIds ??= recovered.map(vm => vm.microvmId);
        throw new Error('RunMicrovm response omitted its MicroVM ID and no unique launch could be reconciled. Check possibleMicrovmIds and the 120-second platform lifetime cap.');
      }
      createdId = recovered[0]!.microvmId;
      sample.launchReconciled = true;
      sample.failure = 'RunMicrovm response omitted its MicroVM ID; the unique new MicroVM was recovered and will be verified for cleanup.';
      phase('run-microvm-reconciled-from-list');
    } else if (response) {
      sample.microvmId = createdId;
      phase('run-microvm-response-received');
      assertActualImage(config, sample.imageVersion, response.imageArn, response.imageVersion, response.executionRoleArn, response.egressNetworkConnectors);
    }
    sample.microvmId = createdId;
    await saveArtifact(options.outputPath, artifact);
    const vmDeadline = Math.min(workDeadline, performance.now() + 10_000);
    const vm = await getMicrovmUntilAvailable(microvms, createdId, vmDeadline);
    assertActualImage(config, sample.imageVersion, vm.imageArn, vm.imageVersion, vm.executionRoleArn, vm.egressNetworkConnectors);
    sample.actualImage = { imageArn: vm.imageArn!, imageVersion: vm.imageVersion!, executionRoleArn: vm.executionRoleArn ?? null, state: vm.state ?? null };
    phase('actual-image-version-observed');
    await saveArtifact(options.outputPath, artifact);
    const evidence = await waitForEvidence({ config, sample, planned, options, deadline: workDeadline, after: launchStarted.getTime(), stopSignal });
    sample.evidence = evidence;
    phase('required-lifecycle-logs-observed');
    if (await readRun(dynamo, config.runsTableName, sample.runId, workDeadline, stopSignal)) {
      throw new Error('Run record appeared during the storage probe.');
    }
    sample.runRecordAbsentAfter = true;
    phase('run-record-absent-after');
  } catch (error) {
    primaryFailure = safeFailure(error);
    sample.failure = primaryFailure;
  } finally {
    if (runWasChecked && sample.runRecordAbsentAfter !== true) {
      try {
        if (await readRun(dynamo, config.runsTableName, sample.runId, workDeadline)) {
          throw new Error('Run record appeared after the MicroVM launch.');
        }
        sample.runRecordAbsentAfter = true;
        phase('run-record-absent-after');
      } catch (error) {
        sample.failure ??= safeFailure(error);
      }
    }
    if (createdId) {
      try {
        sample.cleanup = await terminateAndVerify(microvms, createdId, cleanupDeadline);
        phase('microvm-terminated');
      } catch (error) {
        sample.cleanupFailure = safeFailure(error);
      }
    }
    sample.finishedAt = new Date().toISOString();
    sample.status = !primaryFailure && !sample.failure && !sample.cleanupFailure && sample.runRecordAbsentBefore === true && sample.runRecordAbsentAfter === true
      && sample.evidence !== undefined && sample.cleanup?.verifiedTerminated === true ? 'passed' : 'failed';
    await saveArtifact(options.outputPath, artifact);
  }
}

async function waitForEvidence(input: {
  config: StorageProbeConfig; sample: ProbeSample; planned: ProbePlan;
  options: Options; deadline: number; after: number; stopSignal: AbortSignal;
}): Promise<ProbeEvidence> {
  let nextToken: string | undefined;
  let events: Array<{ timestamp: number; message: string }> = [];
  let logBytes = 0;
  const evidenceDeadline = Math.min(input.deadline, performance.now() + evidenceDeadlineMs);
  while (performance.now() < evidenceDeadline) {
    let response: Record<string, unknown>;
    try {
      const raw = await awsJson([
        'logs', 'get-log-events', '--region', input.config.region,
        '--log-group-name', input.config.logGroupName,
        '--log-stream-name', input.sample.logStreamName,
        '--start-time', String(input.after), '--start-from-head', '--limit', String(maxLogEvents), '--output', 'json',
        ...(nextToken ? ['--next-token', nextToken] : []),
      ], evidenceDeadline);
      if (!isRecord(raw)) throw new Error('CloudWatch Logs returned an invalid response.');
      response = raw;
    } catch (error) {
      if (isMissingLogStream(error)) {
        await delay(Math.min(1_000, Math.max(0, evidenceDeadline - performance.now())), undefined, { signal: input.stopSignal });
        continue;
      }
      throw error;
    }
    if (typeof response.nextForwardToken === 'string') nextToken = response.nextForwardToken;
    else throw new Error('CloudWatch Logs response omitted its forward token.');
    const pageEvents = response.events;
    if (!Array.isArray(pageEvents)) throw new Error('CloudWatch Logs response omitted events.');
    const validEvents = pageEvents.flatMap(event => isRecord(event) && typeof event.timestamp === 'number' && typeof event.message === 'string'
      ? [{ timestamp: event.timestamp, message: event.message }] : []);
    logBytes += validEvents.reduce((sum, event) => sum + Buffer.byteLength(event.message), 0);
    if (events.length + validEvents.length > maxLogEvents || logBytes > maxLogBytes) throw new Error('CloudWatch evidence exceeded its event or byte limit.');
    events = [...events, ...validEvents];
    try {
      return analyzeProbeLogs(events, {
        runId: input.sample.runId, microvmId: input.sample.microvmId!, mode: input.planned.mode,
        region: input.config.region, expectProfile: input.options.expectProfile,
      });
    } catch (error) {
      const message = safeFailure(error);
      if (!/Missing|duplicate|do not exist|unexpectedly|reported|invalid|agree|exit unsuccessfully/.test(message)) throw error;
    }
    await delay(Math.min(1_000, Math.max(0, evidenceDeadline - performance.now())), undefined, { signal: input.stopSignal });
  }
  if (performance.now() >= evidenceDeadline) throw new Error('Required MicroVM lifecycle logs were not observed within the 55-second evidence window.');
  throw new Error('Per-MicroVM evidence deadline exceeded.');
}

async function terminateAndVerify(client: LambdaMicrovmsClient, microvmId: string, deadline: number) {
  let terminateRequests = 0;
  let lastState: string | null = null;
  let lastError: string | undefined;
  for (let attempt = 0; attempt < 3 && performance.now() < deadline; attempt++) {
    try {
      const current = await client.send(new GetMicrovmCommand({ microvmIdentifier: microvmId }), { abortSignal: signalBefore(deadline, 'cleanup', undefined, 5_000) });
      lastState = current.state ?? null;
    } catch (error) {
      lastError = safeFailure(error);
    }
    if (lastState === 'TERMINATED') return { terminateRequests, state: lastState, verifiedTerminated: true };
    if (lastState !== 'TERMINATING') {
      terminateRequests++;
      try {
        await client.send(new TerminateMicrovmCommand({ microvmIdentifier: microvmId }), { abortSignal: signalBefore(deadline, 'cleanup', undefined, 10_000) });
      } catch (error) {
        lastError = safeFailure(error);
      }
    }
    await delay(Math.min(1_000, Math.max(0, deadline - performance.now())));
  }
  while (performance.now() < deadline) {
    try {
      const current = await client.send(new GetMicrovmCommand({ microvmIdentifier: microvmId }), { abortSignal: signalBefore(deadline, 'cleanup', undefined, 5_000) });
      lastState = current.state ?? null;
      if (lastState === 'TERMINATED') return { terminateRequests, state: lastState, verifiedTerminated: true };
    } catch (error) {
      lastError = safeFailure(error);
    }
    await delay(Math.min(1_000, Math.max(0, deadline - performance.now())));
  }
  throw new Error(`MicroVM termination was not verified${lastState ? ` (${lastState})` : ''}${lastError ? ` after ${lastError}` : ''}.`);
}

async function getMicrovmUntilAvailable(client: LambdaMicrovmsClient, id: string, deadline: number) {
  let lastError = 'GetMicrovm did not return a result.';
  while (performance.now() < deadline) {
    try { return await client.send(new GetMicrovmCommand({ microvmIdentifier: id }), { abortSignal: signalBefore(deadline, 'probe') }); }
    catch (error) {
      if (!/ResourceNotFoundException|NotFound/i.test(safeFailure(error))) throw error;
      lastError = safeFailure(error);
    }
    await delay(Math.min(500, Math.max(0, deadline - performance.now())));
  }
  throw new Error(`MicroVM was not available before the probe deadline (${lastError}).`);
}

async function listMicrovms(client: LambdaMicrovmsClient, imageIdentifier: string, deadline: number, imageVersion?: string) {
  const all: Array<{ microvmId: string; state: string | null; imageVersion: string | null; startedAt: number | null }> = [];
  let nextToken: string | undefined;
  do {
    const response = await client.send(new ListMicrovmsCommand({ imageIdentifier, maxResults: 50,
      ...(imageVersion ? { imageVersion } : {}), ...(nextToken ? { nextToken } : {}) }),
      { abortSignal: signalBefore(deadline, 'total') });
    all.push(...(response.items ?? []).flatMap(item => item.microvmId ? [{ microvmId: item.microvmId, state: item.state ?? null,
      imageVersion: item.imageVersion ?? null, startedAt: item.startedAt?.getTime() ?? null }] : []));
    nextToken = response.nextToken;
  } while (nextToken);
  return all;
}

async function reconcileLaunch(client: LambdaMicrovmsClient, config: StorageProbeConfig, sample: ProbeSample,
  beforeIds: ReadonlySet<string>, requestStartedAt: number, window: ProbeWindow) {
  const reconciliationDeadline = planReconciliationDeadline(window, performance.now());
  let candidates: Array<{ microvmId: string; state: string | null; imageVersion: string | null; startedAt: number | null }> = [];
  while (performance.now() < reconciliationDeadline) {
    const current = await listMicrovms(client, config.imageIdentifier, reconciliationDeadline, sample.imageVersion);
    const possible = current.filter(vm => !beforeIds.has(vm.microvmId) && (vm.startedAt === null || vm.startedAt >= requestStartedAt - 5_000));
    sample.possibleMicrovmIds = [...new Set([...(sample.possibleMicrovmIds ?? []), ...possible.map(vm => vm.microvmId)])];
    candidates = possible.length === 1 ? possible.filter(vm => vm.startedAt !== null) : [];
    if (candidates.length > 0) return candidates;
    await delay(Math.min(1_000, Math.max(0, reconciliationDeadline - performance.now())));
  }
  return candidates;
}

async function readRun(client: DynamoDBDocumentClient, tableName: string, runId: string, deadline: number, stopSignal?: AbortSignal): Promise<unknown> {
  return (await client.send(new GetCommand({ TableName: tableName, Key: { runId }, ConsistentRead: true }),
    { abortSignal: signalBefore(deadline, 'probe', stopSignal) })).Item;
}

function assertActualImage(config: StorageProbeConfig, imageVersion: string, imageArn?: string, actualVersion?: string,
  roleArn?: string, connectors?: string[]) {
  if (imageArn !== config.imageIdentifier || actualVersion !== imageVersion || roleArn !== config.executionRoleArn
    || !connectors?.includes(config.connectorArn)) {
    throw new Error('MicroVM image, version, role, or network connector differs from the probe configuration.');
  }
}

function parseProfile(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || value.schema !== profileSchema) throw new Error('Invalid storage mount profile.');
  return value;
}

function validateProfile(profile: Record<string, unknown>, region: string): void {
  finiteNumber(profile.durationMs, 'profile duration');
  if (!Number.isSafeInteger(profile.exitCode) || !['success', 'failure'].includes(String(profile.outcome)) || !isRecord(profile.rootEnv)
    || typeof profile.rootEnv.awsRegionPresent !== 'boolean' || typeof profile.rootEnv.awsDefaultRegionPresent !== 'boolean'
    || (profile.validatedRegion !== null && profile.validatedRegion !== region) || (profile.validatedRegion !== null && typeof profile.validatedRegion !== 'string')
    || !isRecord(profile.usage) || !isRecord(profile.trace) || !Array.isArray(profile.phases)
    || profile.phases.length > 32 || !Array.isArray(profile.importTimings) || profile.importTimings.length > 128
    || !Array.isArray(profile.trace.syscalls) || profile.trace.syscalls.length > 32) {
    throw new Error('Storage mount profile has an incomplete schema.');
  }
  for (const key of ['userMs', 'systemMs', 'majorFaults', 'minorFaults']) finiteNumber(profile.usage[key], `profile usage ${key}`);
  if (profile.trace.scope !== 'mount-launcher-only' || typeof profile.trace.available !== 'boolean'
    || (profile.trace.totalSeconds !== null && (typeof profile.trace.totalSeconds !== 'number' || !Number.isFinite(profile.trace.totalSeconds) || profile.trace.totalSeconds < 0))
    || (profile.trace.calls !== null && (typeof profile.trace.calls !== 'number' || !Number.isSafeInteger(profile.trace.calls) || profile.trace.calls < 0))) {
    throw new Error('Storage mount profile trace fields are invalid.');
  }
  const phaseIds = new Set(['helper_configured', 'mount_target_ip_selected', 'proxy_starting', 'proxy_started', 'nfs_mount_attempt', 'mounted']);
  const modulePattern = /^(?:efs_utils_common|mount_s3files)(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
  const syscallNames = new Set(['access', 'arch_prctl', 'brk', 'clone', 'clone3', 'close', 'connect', 'execve', 'faccessat2', 'fstat', 'fstatfs',
    'getdents64', 'getrandom', 'ioctl', 'mmap', 'mprotect', 'munmap', 'newfstatat', 'openat', 'poll', 'ppoll', 'read', 'recvfrom', 'recvmsg',
    'select', 'sendto', 'sendmsg', 'statx', 'write', 'wait4']);
  for (const phase of profile.phases) {
    if (!isRecord(phase) || typeof phase.id !== 'string' || !phaseIds.has(phase.id) || typeof phase.timestamp !== 'string') {
      throw new Error('Storage profile phase is not allowlisted.');
    }
  }
  for (const item of profile.importTimings) {
    if (!isRecord(item) || typeof item.module !== 'string' || !modulePattern.test(item.module)) throw new Error('Storage profile module is not allowlisted.');
    finiteNumber(item.selfUs, 'profile module self time');
    finiteNumber(item.cumulativeUs, 'profile module cumulative time');
  }
  for (const syscall of profile.trace.syscalls) {
    if (!isRecord(syscall) || typeof syscall.name !== 'string' || !syscallNames.has(syscall.name)) throw new Error('Storage profile syscall is not allowlisted.');
    finiteNumber(syscall.calls, 'profile syscall count');
    finiteNumber(syscall.seconds, 'profile syscall duration');
  }
}

function safeProfile(profile: Record<string, unknown>): Record<string, unknown> {
  const rootEnv = profile.rootEnv as Record<string, unknown>;
  const usage = profile.usage as Record<string, unknown>;
  const trace = profile.trace as Record<string, unknown>;
  return {
    schema: profile.schema,
    outcome: profile.outcome,
    durationMs: profile.durationMs,
    exitCode: profile.exitCode,
    rootEnv: { awsRegionPresent: rootEnv.awsRegionPresent, awsDefaultRegionPresent: rootEnv.awsDefaultRegionPresent },
    validatedRegion: profile.validatedRegion,
    usage: { userMs: usage.userMs, systemMs: usage.systemMs, majorFaults: usage.majorFaults, minorFaults: usage.minorFaults },
    trace: { scope: trace.scope, available: trace.available, totalSeconds: trace.totalSeconds, calls: trace.calls,
      syscalls: (trace.syscalls as Array<Record<string, unknown>>).map(({ name, calls, seconds }) => ({ name, calls, seconds })) },
    phases: (profile.phases as Array<Record<string, unknown>>).map(({ id, timestamp }) => ({ id, timestamp })),
    importTimings: (profile.importTimings as Array<Record<string, unknown>>).map(({ module, selfUs, cumulativeUs }) => ({ module, selfUs, cumulativeUs })),
  };
}

function requireOptIns(environment: NodeJS.ProcessEnv): void {
  const required: ReadonlyArray<[string, string]> = [
    ['AWS_E2E_STORAGE_PROBE', 'true'],
    ['AWS_E2E_STORAGE_PROBE_DISPOSABLE_CONFIRMED', 'true'],
    ['AWS_E2E_STORAGE_PROBE_MODEL_DENY_CONFIRMED', 'true'],
  ];
  for (const [name, expected] of required) if (environment[name] !== expected) throw new Error(`Explicit ${name}=${expected} is required.`);
}

function signalBefore(deadline: number, kind: 'probe' | 'cleanup' | 'total', stopSignal?: AbortSignal, maxMs = Number.MAX_SAFE_INTEGER): AbortSignal {
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw new Error(`${kind === 'probe' ? 'Per-MicroVM' : kind === 'cleanup' ? 'Cleanup' : 'Overall'} deadline exceeded.`);
  const timeout = AbortSignal.timeout(Math.max(1, Math.min(Math.floor(remaining), maxMs)));
  return stopSignal ? AbortSignal.any([timeout, stopSignal]) : timeout;
}

async function saveArtifact(path: string, artifact: ProbeArtifact): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(`${path}.tmp`, JSON.stringify(artifact, null, 2), { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}

async function fileExists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch (error) { if (isNodeError(error) && error.code === 'ENOENT') return false; throw error; }
}

async function awsJson(args: readonly string[], deadline: number): Promise<unknown> {
  const timeout = Math.min(25_000, Math.floor(deadline - performance.now()));
  if (timeout <= 0) throw new Error('AWS CLI request exceeded its deadline.');
  try {
    const { stdout } = await executeFile('aws', [...args], {
      encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, AWS_MAX_ATTEMPTS: '1', AWS_RETRY_MODE: 'standard', AWS_PAGER: '' },
    });
    return JSON.parse(stdout) as unknown;
  } catch (error) {
    if (isRecord(error) && typeof error.stderr === 'string' && /ResourceNotFoundException|The specified log stream does not exist/i.test(error.stderr)) {
      throw Object.assign(new Error('CloudWatch log stream is not available yet.'), { name: 'ResourceNotFoundException' });
    }
    throw error;
  }
}

function isMissingLogStream(error: unknown): boolean {
  return error instanceof Error && error.name === 'ResourceNotFoundException';
}

function finiteNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`Invalid ${name}.`);
  return value;
}

function safeFailure(error: unknown): string {
  if (error instanceof SyntaxError) return 'Invalid JSON response.';
  if (error instanceof Error && isRecord(error) && ('$metadata' in error || 'code' in error || 'stderr' in error)) {
    return error.name || 'External request failed.';
  }
  if (error instanceof Error && error.message && !/(?:AKIA[0-9A-Z]{16}|Bearer\s|X-Amz-Security-Token|secret.?access.?key|password|authorization)/i.test(error.message)) {
    return error.message.slice(0, 300);
  }
  if (error instanceof Error) return error.name || 'Unknown error';
  return 'Unknown error';
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function sortJson(value: unknown[]): unknown[] {
  return [...value].map(item => item).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function isNodeError(value: unknown): value is NodeJS.ErrnoException { return value instanceof Error && 'code' in value; }

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  await run(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(safeFailure(error));
    process.exitCode = 1;
  });
}
