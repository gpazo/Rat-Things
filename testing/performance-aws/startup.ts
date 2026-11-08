import { writeFile, rename, mkdtemp, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';
import { hasUnconditionalInferenceDeny, planStartup, sourceArtifactLocation, startupComparisonSide, startupLimits,
  startupSelectionFromLogEvents, validateStartupManifest, validateStartupOverlapManifest } from './startup-planning.js';
import { SSMClient, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { LambdaMicrovmsClient, GetMicrovmCommand, GetMicrovmImageVersionCommand } from '@aws-sdk/client-lambda-microvms';
import { createAgentsClient } from '../../src/agents-client.js';
import type { SessionActivity } from '../../src/core/session-activity.js';
import type { RunRecord } from '../../src/domain/contracts.js';

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
if (required('AWS_E2E') !== 'true' || required('AWS_E2E_REAL_CODEX') !== 'true') throw new Error('Live startup validation requires explicit opt-in');
const region = required('AWS_REGION');
if (region !== 'us-west-2') throw new Error('The bounded test endpoint is fixed to us-west-2');
const plan = planStartup({
  mode: required('STARTUP_MODE'),
  ...Object.fromEntries([['beforeVersion', 'STARTUP_BEFORE_VERSION'], ['beforeZip', 'STARTUP_BEFORE_SOURCE_ZIP'],
    ['afterVersion', 'STARTUP_AFTER_VERSION'], ['afterZip', 'STARTUP_AFTER_SOURCE_ZIP'],
    ['diagnosticVersion', 'STARTUP_DIAGNOSTIC_VERSION'], ['diagnosticZip', 'STARTUP_DIAGNOSTIC_SOURCE_ZIP'],
    ['randomizedVersion', 'STARTUP_RANDOMIZED_VERSION'], ['randomizedZip', 'STARTUP_RANDOMIZED_SOURCE_ZIP'],
    ['randomizedSamples', 'STARTUP_RANDOMIZED_SAMPLES'],
    ['pairs', 'STARTUP_PAIRS']].flatMap(([key, name]) => process.env[name!] === undefined ? [] : [[key, process.env[name!]]])),
});
if (plan.mode === 'fixture' && required('STARTUP_INFERENCE_DENIED') !== 'true') throw new Error('Install an inference deny policy on the disposable worker role first');
const deployment = required('AWS_E2E_DEPLOYMENT_ID');
const baseURL = required('RAT_THINGS_AGENTS_API_URL');
const endpoint = new URL(baseURL);
if (!/^[a-z0-9-]{3,14}$/.test(deployment) || /(^|-)(prod(uction)?|primary|main)(-|$)/.test(deployment) || endpoint.protocol !== 'https:' || !endpoint.hostname.endsWith(`.lambda-web.${region}.on.aws`)
  || endpoint.pathname !== '/v1' || endpoint.search || endpoint.hash || endpoint.username || endpoint.password) throw new Error('Use a disposable regional Web Function deployment');
const versions = Object.fromEntries(plan.images.map(image => [image.side, image.version]));
const model = required('AWS_E2E_CODEX_MODEL_ID');
if (model !== 'openai.gpt-5.6-luna') throw new Error('This bounded comparison permits only the verified Luna model');
const output = required('STARTUP_OUTPUT');
const account = required('AWS_E2E_CALLER_ACCOUNT');
if (JSON.parse(execFileSync('aws', ['sts', 'get-caller-identity', '--region', region, '--output', 'json'], { encoding: 'utf8', timeout: 30_000 })).Account !== account) throw new Error('Wrong AWS account');
const executionRoleArn = `arn:aws:iam::${account}:role/rat-things-${deployment}-microvm-execution`;
const configuredRole = JSON.parse(execFileSync('aws', ['lambda', 'get-function-configuration', '--function-name', `rat-things-${deployment}-dispatcher`,
  '--region', region, '--query', 'Environment.Variables.MICROVM_EXECUTION_ROLE_ARN', '--output', 'json'], { encoding: 'utf8', timeout: 30_000 }));
if (configuredRole !== executionRoleArn) throw new Error('Dispatcher does not use the expected disposable worker role');
let fixtureInferenceDeny: { roleArn: string; policyName: string; policySha256: string } | undefined;
if (plan.mode === 'fixture') {
  const policyName = 'StartupFixtureNoInference';
  const policy = JSON.parse(execFileSync('aws', ['iam', 'get-role-policy', '--role-name', `rat-things-${deployment}-microvm-execution`,
    '--policy-name', policyName, '--query', 'PolicyDocument', '--output', 'json'], { encoding: 'utf8', timeout: 30_000 }));
  if (!hasUnconditionalInferenceDeny(policy)) throw new Error('Fixture worker role lacks the unconditional inference deny policy');
  fixtureInferenceDeny = { roleArn: executionRoleArn, policyName, policySha256: createHash('sha256').update(JSON.stringify(policy)).digest('hex') };
}
const ssm = new SSMClient({ region, maxAttempts: 1 });
const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region, maxAttempts: 1 }));
const microvms = new LambdaMicrovmsClient({ region, maxAttempts: 1 });
const sha256 = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const parameter = `/rat-things-${deployment}/microvm/image-version`;
const original = (await ssm.send(new GetParameterCommand({ Name: parameter }))).Parameter?.Value;
if (!original) throw new Error('Active image version is missing');
const imageArn = (await ssm.send(new GetParameterCommand({ Name: `/rat-things-${deployment}/microvm/image-arn` }))).Parameter?.Value;
if (imageArn !== `arn:aws:lambda:${region}:${account}:microvm-image:rat-things-${deployment}-agent`) throw new Error('Image does not belong to the configured disposable deployment');
const imageProvenance = await Promise.all(plan.images.map(async selected => {
  const image = await microvms.send(new GetMicrovmImageVersionCommand({ imageIdentifier: imageArn, imageVersion: selected.version }));
  if (image.status !== 'ACTIVE' || image.state !== 'SUCCESSFUL') throw new Error('Image versions must have successful active builds');
  const localHash = createHash('sha256');
  for await (const bytes of createReadStream(selected.sourceZip)) localHash.update(bytes);
  const location = sourceArtifactLocation(image.codeArtifact?.uri, deployment);
  const sourceSha256 = localHash.digest('hex');
  const temporary = await mkdtemp(join(tmpdir(), 'rat-startup-source-'));
  try {
    const downloaded = join(temporary, 'source.zip');
    execFileSync('aws', ['s3', 'cp', `s3://${location.Bucket}/${location.Key}`, downloaded, '--region', region, '--only-show-errors'],
      { timeout: 300_000, maxBuffer: 1_048_576, env: { ...process.env, AWS_MAX_ATTEMPTS: '1' } });
    const remoteHash = createHash('sha256');
    for await (const bytes of createReadStream(downloaded)) remoteHash.update(bytes);
    if (remoteHash.digest('hex') !== sourceSha256) throw new Error('Deployed image source differs from the local verified ZIP');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  const zipEntry = (name: string) => execFileSync('unzip', ['-p', selected.sourceZip, name], { timeout: 10_000, maxBuffer: 1_048_576 });
  const manifest: unknown = JSON.parse(zipEntry('startup-responses-proxy-manifest.json').toString('utf8'));
  validateStartupManifest(manifest, plan.mode);
  if (sha256(zipEntry('startup-responses-proxy.mjs')) !== manifest.proxySha256) throw new Error('Proxy content hash differs from its manifest');
  let overlapManifest: unknown;
  if (plan.mode === 'fixture' && selected.side === 'randomized') {
    overlapManifest = JSON.parse(zipEntry('startup-overlap-manifest.json').toString('utf8'));
    validateStartupOverlapManifest(overlapManifest, zipEntry('runtime-server.mjs'));
  }
  return { side: selected.side, imageArn: image.imageArn, imageVersion: image.imageVersion, codeArtifact: image.codeArtifact, resources: image.resources,
    baseImageArn: image.baseImageArn, baseImageVersion: image.baseImageVersion, sourceSha256, manifest,
    ...(overlapManifest ? { overlapManifest } : {}) };
}));
if (imageProvenance.some(image => JSON.stringify(image.resources) !== JSON.stringify(imageProvenance[0]!.resources)
  || image.baseImageArn !== imageProvenance[0]!.baseImageArn
  || image.baseImageVersion !== imageProvenance[0]!.baseImageVersion)) throw new Error('Compare the same worker size and managed base image');
async function attachExecution(sample: Record<string, unknown>, sessionId: string, selectedVersion: string): Promise<void> {
  const runs: RunRecord[] = [];
  let cursor: Record<string, unknown> | undefined;
  let pages = 0;
  do {
    const page = await db.send(new ScanCommand({ TableName: `rat-things-${deployment}-runs`, ConsistentRead: true, ExclusiveStartKey: cursor,
      FilterExpression: 'agentsSession.sessionId = :session', ExpressionAttributeValues: { ':session': sessionId } }));
    runs.push(...(page.Items as RunRecord[] | undefined) ?? []);
    cursor = page.LastEvaluatedKey;
  } while (cursor && ++pages < 10);
  if (cursor) throw new Error('Run evidence exceeded ten scan pages');
  if (runs.length !== 1 || runs[0]!.execution?.backend !== 'microvm') throw new Error('Expected one fresh MicroVM Run');
  const execution = runs[0]!.execution!;
  const vm = await microvms.send(new GetMicrovmCommand({ microvmIdentifier: execution.id }));
  sample.runId = runs[0]!.runId;
  sample.execution = execution;
  sample.microvmImageVersion = vm.imageVersion;
  sample.microvmImageArn = vm.imageArn;
  sample.executionRoleArn = vm.executionRoleArn;
  sample.runCreatedAt = runs[0]!.createdAt;
  if (vm.imageArn !== imageArn || vm.imageVersion !== selectedVersion || vm.executionRoleArn !== executionRoleArn) throw new Error('Observed worker image or role differs from the selected deployment');
  if (plan.images[0]?.side === 'randomized') {
    const side = startupComparisonSide(runs[0]!.runId);
    sample.side = side;
    sample.selector = { version: 'run-id-final-hex-parity.v1', source: 'observed-run-id', side };
    sample.hostLogSelection = await waitForHostSelection(runs[0]!.runId, side, sample.startedAt as string);
  }
}

async function waitForHostSelection(runId: string, expectedSide: 'before' | 'after', startedAt: string) {
  const deadline = performance.now() + 45_000;
  const startTime = String(Math.max(0, Date.parse(startedAt) - 5_000));
  const logGroup = `/rat-things-${deployment}/microvms`;
  while (performance.now() < deadline) {
    const filter = `"startup comparison selected" "${runId}"`;
    const result = JSON.parse(execFileSync('aws', ['logs', 'filter-log-events', '--region', region, '--log-group-name', logGroup,
      '--filter-pattern', filter, '--start-time', startTime, '--limit', '10', '--output', 'json'],
    { encoding: 'utf8', timeout: 15_000, maxBuffer: 256 * 1024, env: { ...process.env, AWS_MAX_ATTEMPTS: '1' } }));
    const events = (Array.isArray(result.events) ? result.events : []).flatMap((event: unknown) =>
      typeof event === 'object' && event !== null ? [event as { message?: string; logStreamName?: string; timestamp?: number }] : []);
    const match = startupSelectionFromLogEvents(events, runId, expectedSide);
    if (match) return { logGroup, ...match.logGroupEvent, ...match.marker };
    await delay(1_000);
  }
  throw new Error('Startup comparison selection host log was not observed');
}
const client = createAgentsClient({ baseURL, region }).withOptions({ maxRetries: 0, timeout: 30_000 });
const started = performance.now();
const cpu = process.cpuUsage();
const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();
const artifact: Record<string, unknown> & { samples: Array<Record<string, unknown>> } = {
  status: 'running', startedAt: new Date().toISOString(), region, deployment, versions, model, mode: plan.mode, baseURL, imageProvenance,
  boundary: 'create request start to first manager-observed nonempty assistant text; Items and Turns endpoints polled concurrently with 500ms between iterations',
  classification: 'fresh Session and fresh MicroVM; underlying AWS snapshot cache residency is uncontrolled',
  limits: { sessions: plan.samples.length, sessionDeadlineMs: 180_000, totalDeadlineMs: 30 * 60_000, observedOutputBytes: 256,
    ...startupLimits, maximumInferenceUsd: plan.maximumInferenceUsd, inferenceBudgetUsd: 1.20,
    inputTokenBound: 1_050_000, inputBoundBasis: 'model context limit; request body is additionally limited to 65536 bytes',
    fixtureInferenceDeny: fixtureInferenceDeny ?? null, nativeRetryOverridesSupported: false, upstreamRetries: 0 }, samples: [],
};
const save = async () => { await writeFile(`${output}.tmp`, JSON.stringify(artifact, null, 2), { mode: 0o600 }); await rename(`${output}.tmp`, output); };
let agentId: string | undefined;
const usage = () => {
  const turns = artifact.samples.flatMap(sample => sample.turn ? [sample.turn as SessionActivity['turns'][number]] : []);
  const inputTokens = turns.reduce((sum, turn) => sum + (turn.usage?.input_tokens ?? 0), 0);
  const outputTokens = turns.reduce((sum, turn) => sum + (turn.usage?.output_tokens ?? 0), 0);
  return { inputTokens, outputTokens, unknownSamples: artifact.samples.filter(sample => !(sample.turn as SessionActivity['turns'][number] | undefined)?.usage).length,
    conservativeEstimateUsd: plan.mode === 'fixture' ? 0 : turns.reduce((sum, turn) => {
      const input = turn.usage?.input_tokens ?? 0;
      return sum + (input * (input > 272_000 ? 0.55 : 0.275) + (turn.usage?.output_tokens ?? 0) * (input > 272_000 ? 1.98 : 1.32)) / 1e6;
    }, 0),
    usageKind: plan.mode === 'fixture' ? 'synthetic fixture usage' : 'provider-reported usage' };
};
const stop = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => stop.abort());
try {
  await save();
  const agent = await client.beta.agents.create({ name: `Startup comparison ${deployment}`, model, tools: [], multi_agent: { enabled: false }, reasoning: { effort: 'low', summary: null },
    instructions: 'Reply with exactly OK. Do not repeat or quote any input. Keep the entire response to one word.' });
  agentId = agent.id;
  artifact.agentId = agentId;
  for (const { pair, image: selected } of plan.samples) {
    const side = selected.side;
    if (stop.signal.aborted || performance.now() - started > 30 * 60_000 || usage().conservativeEstimateUsd > plan.maximumInferenceUsd) throw new Error('Comparison budget reached');
    await ssm.send(new PutParameterCommand({ Name: parameter, Value: versions[side], Type: 'String', Overwrite: true }));
    if ((await ssm.send(new GetParameterCommand({ Name: parameter }))).Parameter?.Value !== versions[side]) throw new Error('Image selection did not persist');
    const sample: Record<string, unknown> = { pair, side, imageVersion: versions[side], status: 'running', startedAt: new Date().toISOString() };
    artifact.samples.push(sample);
    await save();
    let sessionId: string | undefined;
    sample.requestStartedAt = new Date().toISOString();
    const start = performance.now();
    try {
      const session = await client.beta.agents.sessions.create({ agent_id: agentId, environment: { type: 'none' }, input: 'Initialize. Reply OK.' });
      sessionId = session.id;
      sample.sessionId = sessionId;
      sample.acknowledgementMs = performance.now() - start;
      await save();
      let finished = false;
      while (!stop.signal.aborted && performance.now() - start < 180_000) {
        const options = { timeout: Math.min(30_000, 180_000 - (performance.now() - start)) };
        const [items, turns] = await Promise.all([
          client.beta.agents.sessions.items.list(sessionId, { limit: 100, order: 'asc' }, options),
          client.beta.agents.sessions.turns.list(sessionId, { limit: 100, order: 'asc' }, options),
        ]);
        if (items.has_more || turns.has_more) throw new Error('Unexpected paginated history');
        const activity = { items: items.data, turns: turns.data };
        sample.turn = activity.turns[0];
        if (performance.now() - start >= 180_000) throw new Error('Startup deadline exceeded');
        const text = activity.items.flatMap(item => item.type === 'message' && item.role === 'assistant'
          ? item.content.flatMap(part => part.type === 'output_text' ? [part.text] : []) : []).join('');
        if (text.trim()) sample.firstProgressMs ??= performance.now() - start;
        if (Buffer.byteLength(text) > 256) throw new Error('Output guard exceeded');
        if (activity.turns.some(turn => ['failed', 'cancelled', 'incomplete'].includes(turn.status))) throw new Error('Turn failed');
        if (activity.turns.length === 1 && activity.turns[0]!.status === 'completed') {
          sample.completedMs = performance.now() - start;
          sample.turn = activity.turns[0];
          if (text.trim() !== 'OK') throw new Error('Unexpected model answer');
          const usage = activity.turns[0]!.usage;
          if (!usage) throw new Error('Usage missing');
          finished = true;
          break;
        }
        await delay(500, undefined, { signal: stop.signal });
      }
      if (!finished) throw new Error('Startup deadline exceeded');
      await attachExecution(sample, sessionId, selected.version);
      sample.status = 'passed';
    } catch (error) {
      sample.status = 'failed'; sample.error = error instanceof Error ? error.message : String(error); throw error;
    } finally {
      if (sessionId && !sample.runId) {
        try { await attachExecution(sample, sessionId, selected.version); }
        catch (error) { sample.evidenceError = error instanceof Error ? error.message : String(error); }
      }
      try {
        if (sessionId) { await client.beta.agents.sessions.delete(sessionId, { maxRetries: 2, timeout: 10_000 }); sample.sessionDeleted = true; }
      } catch (error) {
        sample.status = 'failed'; sample.cleanupError = error instanceof Error ? error.message : String(error); throw error;
      } finally { sample.finishedAt = new Date().toISOString(); await save(); }
    }
    console.log(JSON.stringify(sample));
  }
  if (plan.images[0]?.side === 'randomized') {
    const before = artifact.samples.filter(sample => sample.side === 'before').length;
    const after = artifact.samples.filter(sample => sample.side === 'after').length;
    artifact.randomizedAssignmentCounts = { before, after, requiredMinimumPerSide: 5 };
    if (before < 5 || after < 5) throw new Error('Randomized comparison requires at least five observed samples per side');
  }
  artifact.status = 'passed';
} catch (error) {
  artifact.status = 'failed'; artifact.error = error instanceof Error ? error.message : String(error); process.exitCode = 1;
} finally {
  const cleanupErrors: string[] = [];
  try {
    try {
      await ssm.send(new PutParameterCommand({ Name: parameter, Value: original, Type: 'String', Overwrite: true }));
      artifact.imageSelectionRestored = true;
    } catch { cleanupErrors.push('image_selection_restore_failed'); }
    try {
      if (agentId) { await client.beta.agents.delete(agentId, { maxRetries: 2, timeout: 10_000 }); artifact.agentDeleted = true; }
    } catch { cleanupErrors.push('agent_delete_failed'); }
  } finally {
    if (cleanupErrors.length) { artifact.status = 'failed'; artifact.cleanupErrors = cleanupErrors; process.exitCode = 1; }
    loop.disable();
    artifact.finishedAt = new Date().toISOString();
    artifact.usage = usage();
    artifact.controller = { elapsedMs: performance.now() - started, cpu: process.cpuUsage(cpu), eventLoopDelayP95Ms: loop.percentile(95) / 1e6 };
    await save();
    ssm.destroy(); db.destroy(); microvms.destroy();
  }
}
