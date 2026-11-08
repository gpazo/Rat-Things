import { writeFile, rename } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';
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
const deployment = required('AWS_E2E_DEPLOYMENT_ID');
const baseURL = required('RAT_THINGS_AGENTS_API_URL');
const endpoint = new URL(baseURL);
if (!/^[a-z0-9-]{3,14}$/.test(deployment) || endpoint.protocol !== 'https:' || !endpoint.hostname.endsWith(`.lambda-web.${region}.on.aws`)
  || endpoint.pathname !== '/v1' || endpoint.search || endpoint.hash || endpoint.username || endpoint.password) throw new Error('Use a disposable regional Web Function deployment');
const versions = { before: required('STARTUP_BEFORE_VERSION'), after: required('STARTUP_AFTER_VERSION') };
if (versions.before === versions.after || Object.values(versions).some(value => !/^\d+(?:\.\d+)?$/.test(value))) throw new Error('Two distinct image versions are required');
const model = required('AWS_E2E_CODEX_MODEL_ID');
if (model !== 'openai.gpt-5.6-luna') throw new Error('This bounded comparison permits only the verified Luna model');
const output = required('STARTUP_OUTPUT');
const pairs = Number(process.env.STARTUP_PAIRS ?? 5);
if (!Number.isInteger(pairs) || pairs < 1 || pairs > 5) throw new Error('STARTUP_PAIRS must be between 1 and 5');
const account = required('AWS_E2E_CALLER_ACCOUNT');
if (JSON.parse(execFileSync('aws', ['sts', 'get-caller-identity', '--region', region, '--output', 'json'], { encoding: 'utf8', timeout: 30_000 })).Account !== account) throw new Error('Wrong AWS account');
const ssm = new SSMClient({ region, maxAttempts: 1 });
const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region, maxAttempts: 1 }));
const microvms = new LambdaMicrovmsClient({ region, maxAttempts: 1 });
const parameter = `/rat-things-${deployment}/microvm/image-version`;
const original = (await ssm.send(new GetParameterCommand({ Name: parameter }))).Parameter?.Value;
if (!original) throw new Error('Active image version is missing');
const imageArn = (await ssm.send(new GetParameterCommand({ Name: `/rat-things-${deployment}/microvm/image-arn` }))).Parameter?.Value;
if (!imageArn?.startsWith(`arn:aws:lambda:${region}:${account}:microvm-image:`)) throw new Error('Wrong image account or region');
const imageProvenance = await Promise.all(Object.entries(versions).map(async ([side, imageVersion]) => {
  const image = await microvms.send(new GetMicrovmImageVersionCommand({ imageIdentifier: imageArn, imageVersion }));
  if (image.status !== 'ACTIVE' || image.state !== 'SUCCESSFUL') throw new Error('Both image versions must have successful active builds');
  return { side, imageArn: image.imageArn, imageVersion: image.imageVersion, codeArtifact: image.codeArtifact, resources: image.resources,
    baseImageArn: image.baseImageArn, baseImageVersion: image.baseImageVersion };
}));
if (JSON.stringify(imageProvenance[0]!.resources) !== JSON.stringify(imageProvenance[1]!.resources)
  || imageProvenance[0]!.baseImageArn !== imageProvenance[1]!.baseImageArn
  || imageProvenance[0]!.baseImageVersion !== imageProvenance[1]!.baseImageVersion) throw new Error('Compare the same worker size and managed base image');
const client = createAgentsClient({ baseURL, region }).withOptions({ maxRetries: 0, timeout: 30_000 });
const started = performance.now();
const cpu = process.cpuUsage();
const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();
const artifact: Record<string, unknown> & { samples: Array<Record<string, unknown>> } = {
  status: 'running', startedAt: new Date().toISOString(), region, deployment, versions, model, baseURL, imageProvenance,
  boundary: 'create request start to first manager-observed nonempty assistant text; Items and Turns endpoints polled concurrently with 500ms between iterations',
  classification: 'fresh Session and fresh MicroVM; underlying AWS snapshot cache residency is uncontrolled',
  limits: { requests: pairs * 2, sessionDeadlineMs: 180_000, totalDeadlineMs: 30 * 60_000, observedOutputBytes: 256, estimatedInferenceStopThresholdUsd: 0.05,
    providerMaxOutputTokens: 128_000, requestedOutput: 'one word', note: 'The estimate stops subsequent calls; output observation cannot prevent a single call from exceeding it' }, samples: [],
};
const save = async () => { await writeFile(`${output}.tmp`, JSON.stringify(artifact, null, 2), { mode: 0o600 }); await rename(`${output}.tmp`, output); };
let agentId: string | undefined;
const usage = () => {
  const turns = artifact.samples.flatMap(sample => sample.turn ? [sample.turn as SessionActivity['turns'][number]] : []);
  const inputTokens = turns.reduce((sum, turn) => sum + (turn.usage?.input_tokens ?? 0), 0);
  const outputTokens = turns.reduce((sum, turn) => sum + (turn.usage?.output_tokens ?? 0), 0);
  return { inputTokens, outputTokens, unknownSamples: artifact.samples.filter(sample => !(sample.turn as SessionActivity['turns'][number] | undefined)?.usage).length,
    conservativeEstimateUsd: inputTokens * 0.275 / 1e6 + outputTokens * 1.32 / 1e6 };
};
const stop = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => stop.abort());
try {
  await save();
  const agent = await client.beta.agents.create({ name: `Startup comparison ${deployment}`, model, tools: [], reasoning: { effort: 'low', summary: null },
    instructions: 'Reply with exactly OK. Do not repeat or quote any input. Keep the entire response to one word.' });
  agentId = agent.id;
  artifact.agentId = agentId;
  for (let pair = 1; pair <= pairs; pair++) {
    const order = pair % 2 ? ['before', 'after'] as const : ['after', 'before'] as const;
    for (const side of order) {
      if (stop.signal.aborted || performance.now() - started > 30 * 60_000 || usage().conservativeEstimateUsd >= 0.05) throw new Error('Comparison budget reached');
      await ssm.send(new PutParameterCommand({ Name: parameter, Value: versions[side], Type: 'String', Overwrite: true }));
      if ((await ssm.send(new GetParameterCommand({ Name: parameter }))).Parameter?.Value !== versions[side]) throw new Error('Image selection did not persist');
      const sample: Record<string, unknown> = { pair, side, imageVersion: versions[side], status: 'running', startedAt: new Date().toISOString() };
      artifact.samples.push(sample);
      await save();
      let sessionId: string | undefined;
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
        const runs: RunRecord[] = [];
        let cursor: Record<string, unknown> | undefined;
        do {
          const page = await db.send(new ScanCommand({ TableName: `rat-things-${deployment}-runs`, ConsistentRead: true, ExclusiveStartKey: cursor,
            FilterExpression: 'agentsSession.sessionId = :session', ExpressionAttributeValues: { ':session': sessionId } }));
          runs.push(...(page.Items as RunRecord[] | undefined) ?? []);
          cursor = page.LastEvaluatedKey;
        } while (cursor);
        if (runs.length !== 1 || runs[0]!.execution?.backend !== 'microvm') throw new Error('Expected one fresh MicroVM Run');
        const execution = runs[0]!.execution!;
        const vm = await microvms.send(new GetMicrovmCommand({ microvmIdentifier: execution.id }));
        sample.runId = runs[0]!.runId;
        sample.execution = execution;
        sample.microvmImageVersion = vm.imageVersion;
        sample.microvmImageArn = vm.imageArn;
        if (vm.imageArn !== imageArn || vm.imageVersion !== versions[side]) throw new Error('Observed worker image differs from selected image');
        sample.status = 'passed';
      } catch (error) {
        sample.status = 'failed'; sample.error = error instanceof Error ? error.message : String(error); throw error;
      } finally {
        try {
          if (sessionId) { await client.beta.agents.sessions.delete(sessionId); sample.sessionDeleted = true; }
        } catch (error) {
          sample.status = 'failed'; sample.cleanupError = error instanceof Error ? error.message : String(error); throw error;
        } finally { sample.finishedAt = new Date().toISOString(); await save(); }
      }
      console.log(JSON.stringify(sample));
    }
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
      if (agentId) { await client.beta.agents.delete(agentId); artifact.agentDeleted = true; }
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
