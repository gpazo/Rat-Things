import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { GetMicrovmCommand, LambdaMicrovmsClient } from '@aws-sdk/client-lambda-microvms';
import { expect, it } from 'vitest';
import { createAgentsClient } from '../../src/agents-client.js';
import { DynamoAgentsStore } from '../../src/adapters/dynamo-agents-store.js';
import { S3ArtifactStore } from '../../src/adapters/aws-runtime.js';
import type { StoredSessionRuntime } from '../../src/core/session-runtime-store.js';
import { nativeDigest, type NativeCommit, type NativeHead } from '../../src/core/session-native-store.js';
import type { AgentSessionItem, Turn } from '../../src/domain/agents-api.js';
import type { RunRecord, RunStatus } from '../../src/domain/contracts.js';

type StopProof =
  | { kind: 'terminated'; state: 'TERMINATED' }
  | { kind: 'absent'; errorName: 'ResourceNotFoundException' | 'GoneException' }
  | { kind: 'already-terminated'; errorName: 'ValidationException' };

type WorkerIdentity = Readonly<{
  sessionId: string;
  ownerId: string;
  runId: string;
  executionId: string;
  generation: string;
  runStatus: RunStatus;
  role: { kind: 'observed'; arn: string } | { kind: 'unavailable'; stop: StopProof };
}>;

type SettledEvidence = Readonly<{
  worker: WorkerIdentity;
  turnId: string;
  runStatus: 'succeeded';
  stop: StopProof;
  observedAt: string;
  rootThreadId: string;
  rootTurnIds: readonly string[];
  epoch: number;
  projectionSeq: number;
  head: NativeHead;
}>;

type EvidenceReader = Readonly<{
  capture(sessionId: string, turnId: string): Promise<WorkerIdentity>;
  waitForStopped(worker: WorkerIdentity, turnId: string): Promise<SettledEvidence>;
  close(): void;
}>;

type HarnessConfig = Readonly<{
  region: string;
  account: string;
  deploymentId: string;
  deployment: string;
  runsTable: string;
  agentsTable: string;
  definitionBucket: string;
  apiUrl: string;
  modelIds: readonly string[];
}>;

type PiCatalog = { object: 'list'; runtime: 'pi'; data: readonly { id: string }[] };
type RuntimeIdentity = { runtime: 'pi'; version: string; catalog_digest: string; model: string };

const live = process.env.AWS_E2E === 'true' && process.env.AWS_E2E_PI_PROOF === 'true' ? it : it.skip;
const timeoutMs = Number(process.env.AWS_E2E_TIMEOUT_MS ?? 420_000);
const modelCount = configuredModelCount();
const execute = promisify(execFile);

live('proves Pi function results survive a stopped worker and a new root worker', async () => {
  const config = await harnessConfig();
  const api = createAgentsClient({ baseURL: config.apiUrl, region: config.region }).withOptions({ maxRetries: 0, timeout: timeoutMs });
  const failures: Error[] = [];
  let evidence: EvidenceReader | undefined;

  try {
    evidence = await openEvidenceReader(config);
    const catalog = await api.get<PiCatalog>('/models?runtime=pi');
    expect(catalog.runtime).toBe('pi');
    expect(catalog.data.map(model => model.id)).toEqual(expect.arrayContaining([...config.modelIds]));

    for (const model of config.modelIds) {
      const modelFailures = await proveModel(api, evidence, model);
      failures.push(...modelFailures);
    }
  } catch (error) {
    failures.push(failure('Pi proof setup', error));
  } finally {
    try {
      evidence?.close();
    } catch (error) {
      failures.push(failure('AWS evidence client cleanup', error));
    }
  }

  if (failures.length) throw new AggregateError(failures, `Pi runtime proof had ${failures.length} failure(s)`);
}, timeoutMs * modelCount * 12);

async function harnessConfig(): Promise<HarnessConfig> {
  for (const name of ['AWS_E2E', 'AWS_E2E_PI_PROOF', 'AWS_E2E_REAL_CODEX', 'AWS_E2E_ENABLE_MICROVM']) {
    if (process.env[name] !== 'true') throw new Error(`${name}=true is required for the Pi runtime proof`);
  }

  const region = required('AWS_REGION');
  if (process.env.AWS_DEFAULT_REGION && process.env.AWS_DEFAULT_REGION !== region) throw new Error('AWS region does not match the deployment runtime environment');
  const deploymentId = required('AWS_E2E_DEPLOYMENT_ID');
  if (!/^[a-z0-9][a-z0-9-]{2,13}$/.test(deploymentId)) throw new Error('Invalid disposable deployment ID');
  const deployment = `rat-things-${deploymentId}`;
  const account = required('AWS_E2E_CALLER_ACCOUNT');
  if (!/^\d{12}$/.test(account)) throw new Error('Invalid recorded AWS account');

  const modelIds = parseStringList(required('AWS_E2E_PI_BEDROCK_MODEL_IDS_JSON'), 'AWS_E2E_PI_BEDROCK_MODEL_IDS_JSON');
  if (modelIds.length < 2 || new Set(modelIds).size !== modelIds.length) throw new Error('The Pi proof requires at least two distinct configured model IDs');
  const runsTable = `${deployment}-runs`;
  if (required('RUNS_TABLE_NAME') !== runsTable) throw new Error('The Runs table does not match this disposable deployment');

  const callerAccount = (await execute('aws', [
    'sts', 'get-caller-identity', '--region', region, '--query', 'Account', '--output', 'text',
  ], { timeout: 30_000 })).stdout.trim();
  expect(callerAccount).toBe(account);

  return {
    region,
    account,
    deploymentId,
    deployment,
    runsTable,
    agentsTable: `${deployment}-agents`,
    definitionBucket: required('DEFINITION_BUCKET'),
    apiUrl: required('RAT_THINGS_AGENTS_API_URL'),
    modelIds,
  };
}

async function openEvidenceReader(config: HarnessConfig): Promise<EvidenceReader> {
  const document = DynamoDBDocumentClient.from(new DynamoDBClient({ region: config.region }));
  const s3 = new S3Client({ region: config.region });
  const microvms = new LambdaMicrovmsClient({ region: config.region });
  const store = new DynamoAgentsStore(document, config.agentsTable, new S3ArtifactStore(s3, config.definitionBucket));
  const readRun = async (runId: string): Promise<RunRecord | undefined> => {
    const result = await document.send(new GetCommand({
      TableName: config.runsTable,
      Key: { runId },
      ConsistentRead: true,
    }));
    return result.Item as RunRecord | undefined;
  };

  return {
    capture: async (sessionId, turnId) => {
      const deadline = Date.now() + timeoutMs;
      let ownerId: string | undefined;
      while (Date.now() < deadline) {
        if (!ownerId) {
          const runs = await scanSessionRuns(document, config.runsTable, sessionId);
          const ownerIds = [...new Set(runs.map(run => run.ownerId).filter(owner => typeof owner === 'string' && owner.length > 0))];
          if (ownerIds.length > 1) throw new Error(`Expected one authenticated owner for Session ${sessionId}`);
          ownerId = ownerIds[0];
          if (!ownerId) {
            await delay(1000);
            continue;
          }
        }

        const runtimeResource = await store.get<StoredSessionRuntime>(ownerId, 'session_runtime', sessionId);
        const runtime = runtimeResource?.value;
        if (!runtime || runtimeResource.ownerId !== ownerId || runtime.snapshot?.sessionId !== sessionId) {
          await delay(1000);
          continue;
        }
        const binding = runtime.snapshot.turns.find(value => value.turn.id === turnId);
        if (!binding) {
          await delay(1000);
          continue;
        }
        if (binding.threadId !== runtime.snapshot.rootThreadId || binding.turn.subagent_id !== null) throw new Error('The requested Turn is not bound to the Pi root thread');
        if (!runtime.runId) {
          await delay(1000);
          continue;
        }

        const run = await readRun(runtime.runId);
        if (!run) {
          await delay(1000);
          continue;
        }
        if (run.runId !== runtime.runId || run.ownerId !== ownerId || run.agentsSession?.sessionId !== sessionId) {
          throw new Error('The exact Run does not match its Session owner');
        }
        if (run.agentsSession.turnId !== turnId) {
          await delay(1000);
          continue;
        }
        if (run.status === 'failed' || run.status === 'cancelled') throw new Error(`The Pi Run ended ${run.status}`);
        const execution = run.execution;
        if (execution && execution.backend !== 'microvm') throw new Error('The Pi Run is not using the required MicroVM backend');
        if (!execution?.id || execution.id === 'pending' || !execution.generation) {
          await delay(1000);
          continue;
        }
        if (run.status !== 'running' && run.status !== 'succeeded') {
          await delay(1000);
          continue;
        }
        const identity = {
          sessionId,
          ownerId,
          runId: run.runId,
          executionId: execution.id,
          generation: execution.generation,
          runStatus: run.status,
        } as const;

        let vm;
        try {
          vm = await microvms.send(new GetMicrovmCommand({ microvmIdentifier: execution.id }));
        } catch (error) {
          const stop = stopProof(error);
          if (run.status === 'succeeded' && stop) return { ...identity, role: { kind: 'unavailable', stop } };
          if (!stop) throw error;
          await delay(1000);
          continue;
        }

        const expectedRole = `arn:aws:iam::${config.account}:role/${config.deployment}-microvm-execution`;
        if (vm.executionRoleArn !== expectedRole) throw new Error('The MicroVM execution role does not match the deployment fence');
        if (run.status === 'running' && (vm.state === 'TERMINATING' || vm.state === 'TERMINATED')) throw new Error('The waiting Pi worker is already stopping');
        return { ...identity, role: { kind: 'observed', arn: vm.executionRoleArn } };
      }
      throw new Error('The fenced Pi MicroVM was not observed before its deadline');
    },
    waitForStopped: async (worker, turnId) => {
      const deadline = Date.now() + timeoutMs;
      let stop: StopProof | undefined;
      while (Date.now() < deadline) {
        const run = await readRun(worker.runId);
        if (!run) {
          await delay(2000);
          continue;
        }
        assertSameWorker(worker, turnId, run);
        if (run.status === 'failed' || run.status === 'cancelled') throw new Error(`Pi Run ended ${run.status}`);

        try {
          const vm = await microvms.send(new GetMicrovmCommand({ microvmIdentifier: worker.executionId }));
          if (run.status === 'succeeded' && vm.state === 'TERMINATED') stop = { kind: 'terminated', state: 'TERMINATED' };
        } catch (error) {
          const absent = stopProof(error);
          if (!absent) throw error;
          if (run.status === 'succeeded') stop = absent;
        }
        if (run.status === 'succeeded' && stop) break;
        await delay(2000);
      }
      if (!stop) throw new Error('The Pi worker did not reach a verified stopped state before its deadline');

      const settled = await waitForNativeHead(store, worker, turnId);
      return { worker, turnId, runStatus: 'succeeded', stop, observedAt: new Date().toISOString(), ...settled };
    },
    close: () => {
      document.destroy();
      s3.destroy();
      microvms.destroy();
    },
  };
}

async function scanSessionRuns(document: DynamoDBDocumentClient, tableName: string, sessionId: string): Promise<RunRecord[]> {
  const runs: RunRecord[] = [];
  let cursor: Record<string, unknown> | undefined;
  do {
    const page = await document.send(new ScanCommand({
      TableName: tableName,
      ConsistentRead: true,
      FilterExpression: '#agentsSession.#sessionId = :sessionId',
      ExpressionAttributeNames: { '#agentsSession': 'agentsSession', '#sessionId': 'sessionId' },
      ExpressionAttributeValues: { ':sessionId': sessionId },
      ...(cursor ? { ExclusiveStartKey: cursor } : {}),
    }));
    for (const item of page.Items ?? []) {
      const run = item as RunRecord;
      if (run.agentsSession?.sessionId === sessionId && typeof run.ownerId === 'string' && run.ownerId) runs.push(run);
    }
    cursor = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (cursor);
  return runs;
}

async function waitForNativeHead(store: DynamoAgentsStore, worker: WorkerIdentity, turnId: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const resource = await store.get<StoredSessionRuntime>(worker.ownerId, 'session_runtime', worker.sessionId);
    const runtime = resource?.value;
    if (runtime?.runId === worker.runId && runtime.snapshot?.sessionId === worker.sessionId) {
      const binding = runtime.snapshot.turns.find(value => value.turn.id === turnId);
      const head = runtime.native?.head;
      const projectionSeq = runtime.projectionSeq;
      if (binding?.turn.status === 'failed' || binding?.turn.status === 'cancelled') throw new Error(`Pi Turn ended ${binding.turn.status}`);
      if (binding?.turn.status === 'completed' && head && projectionSeq === head.seq) {
        if (!Number.isSafeInteger(runtime.epoch) || runtime.epoch === undefined || runtime.epoch < 0) throw new Error('The Pi runtime epoch is invalid');
        if (!Number.isSafeInteger(head.seq) || head.seq < 1 || !head.commitId || !/^[a-f0-9]{64}$/.test(head.digest)) throw new Error('The Pi native head is invalid');
        const rootThreadId = runtime.snapshot.rootThreadId;
        if (!rootThreadId) throw new Error('The Pi root thread ID is missing');
        const rootTurnIds = runtime.snapshot.turns
          .filter(value => value.threadId === rootThreadId && value.turn.subagent_id === null)
          .map(value => value.turn.id);
        if (!rootTurnIds.includes(turnId)) throw new Error('The completed Turn is not retained on the Pi root thread');
        const committed = await store.get<NativeCommit>(worker.ownerId, 'session_native', `${worker.sessionId}:commit:${head.commitId}`);
        if (!committed || committed.value.schema !== 1 || committed.value.commitId !== head.commitId || committed.value.seq !== head.seq || nativeDigest(committed.value) !== head.digest) {
          throw new Error('The Pi native head does not reference a valid committed object');
        }
        return { rootThreadId, rootTurnIds, epoch: runtime.epoch, projectionSeq, head };
      }
    }
    await delay(1000);
  }
  throw new Error('The Pi runtime projection did not commit a matching native head before its deadline');
}

async function proveModel(api: ReturnType<typeof createAgentsClient>, evidence: EvidenceReader, model: string): Promise<Error[]> {
  const failures: Error[] = [];
  let agentId: string | undefined;
  let sessionId: string | undefined;
  let stage = 'Agent creation';

  try {
    const agent = await api.beta.agents.create({
      model,
      tools: [{ type: 'function', name: 'lookup_proof_token', description: 'Return the proof token for the requested key.',
        parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false } }],
      instructions: 'Call lookup_proof_token only when asked. Return the supplied token verbatim with no other text.',
    });
    agentId = agent.id;

    stage = 'Session creation';
    const session = await api.beta.agents.sessions.create({
      agent_id: agent.id,
      metadata: { rat_things_runtime: 'pi' },
      environment: { type: 'none' },
      input: 'Call lookup_proof_token with key "proof". Remember its token and return only that token.',
    });
    sessionId = session.id;
    const pin = await runtimeIdentity(api, session.id, model);

    stage = 'first function request';
    const firstCall = await waitForProofCall(api, session.id);
    expect(firstCall.name).toBe('lookup_proof_token');
    expect(firstCall.arguments).toEqual({ key: 'proof' });
    const firstWorker = await evidence.capture(session.id, firstCall.turn_id);
    expect(firstWorker.runStatus).toBe('running');
    expect(firstWorker.role.kind).toBe('observed');

    const marker = `pi-proof-${randomUUID()}`;
    stage = 'first Turn completion';
    await api.beta.agents.sessions.events.create(session.id, { events: [{
      type: 'agent.session.input.tool_result',
      turn_id: firstCall.turn_id,
      call_id: firstCall.call_id,
      success: true,
      output: marker,
    }] });
    await waitForTurnCompleted(api, session.id, firstCall.turn_id, false);
    const first = await evidence.waitForStopped(firstWorker, firstCall.turn_id);
    await assertCompletedAnswerContainsExactMarker(api, session.id, firstCall.turn_id, marker, firstCall.call_id);
    expect(await runtimeIdentity(api, session.id, model)).toEqual(pin);

    stage = 'second Turn creation';
    const previousRootTurns = await rootTurnIds(api, session.id);
    await api.beta.agents.sessions.events.create(session.id, { events: [{
      type: 'agent.session.input.message',
      input: [{ role: 'user', content: [{
        type: 'input_text',
        text: 'Return only the token supplied by lookup_proof_token in the previous Turn. Do not call any tools.',
      }] }],
    }] });
    const secondTurn = await waitForNewRootTurn(api, session.id, previousRootTurns);
    const secondWorker = await evidence.capture(session.id, secondTurn.id);
    expect(['running', 'succeeded']).toContain(secondWorker.runStatus);
    if (secondWorker.role.kind === 'unavailable') expect(secondWorker.runStatus).toBe('succeeded');

    stage = 'second Turn completion';
    await waitForTurnCompleted(api, session.id, secondTurn.id, true);
    const second = await evidence.waitForStopped(secondWorker, secondTurn.id);
    await assertCompletedAnswerContainsExactMarker(api, session.id, secondTurn.id, marker);
    expect(await runtimeIdentity(api, session.id, model)).toEqual(pin);
    assertContinuation(first, second, pin);

    console.log(JSON.stringify({
      phase: 'pi-proof-passed',
      model,
      sessionId: session.id,
      callId: firstCall.call_id,
      turns: [first.turnId, second.turnId],
      runs: [first.worker.runId, second.worker.runId],
      executions: [first.worker.executionId, second.worker.executionId],
      generations: [first.worker.generation, second.worker.generation],
      nativeSequences: [first.head.seq, second.head.seq],
      stop: [first.stop.kind, second.stop.kind],
    }));
  } catch (error) {
    failures.push(failure(`Pi proof for ${model} during ${stage}`, error));
  } finally {
    try {
      try {
        if (sessionId) await api.withOptions({ maxRetries: 2 }).beta.agents.sessions.delete(sessionId);
      } catch (error) {
        failures.push(failure(`Session cleanup for ${model}`, error));
      }
    } finally {
      try {
        if (agentId) await api.withOptions({ maxRetries: 2 }).beta.agents.delete(agentId);
      } catch (error) {
        failures.push(failure(`Agent cleanup for ${model}`, error));
      }
    }
  }
  return failures;
}

async function runtimeIdentity(api: ReturnType<typeof createAgentsClient>, sessionId: string, model: string): Promise<RuntimeIdentity> {
  const value = await api.get<RuntimeIdentity>(`/agents/sessions/${encodeURIComponent(sessionId)}/runtime`);
  expect(value.runtime).toBe('pi');
  expect(value.version).toBe('1.3.0');
  expect(value.model).toBe(model);
  expect(value.catalog_digest).toMatch(/^[a-f0-9]{64}$/);
  return value;
}

async function waitForProofCall(api: ReturnType<typeof createAgentsClient>, sessionId: string) {
  let action: { turn_id: string; call_id: string; name: string; arguments: unknown } | undefined;
  await eventually(async () => {
    const saved = await api.beta.agents.sessions.retrieve(sessionId);
    const calls = saved.required_actions.filter(value => value.type === 'function_call');
    if (calls.length > 1) throw new Error('Pi requested more than one application function');
    const turns = (await api.beta.agents.sessions.turns.list(sessionId, { limit: 100, order: 'asc' })).data;
    const completed = turns.find(value => value.subagent_id === null && ['completed', 'failed', 'cancelled'].includes(value.status));
    if (completed && !calls.length) throw new Error(`Pi finished before requesting its function: ${completed.status}`);
    const call = calls[0];
    if (call?.type === 'function_call') action = call;
    return Boolean(action);
  });
  if (!action) throw new Error('Pi did not request lookup_proof_token');
  return action;
}

async function waitForTurnCompleted(api: ReturnType<typeof createAgentsClient>, sessionId: string, turnId: string, rejectActions: boolean): Promise<void> {
  await eventually(async () => {
    const session = await api.beta.agents.sessions.retrieve(sessionId);
    const turn = (await api.beta.agents.sessions.turns.list(sessionId, { limit: 100, order: 'asc' })).data.find(value => value.id === turnId);
    if (turn?.status === 'failed' || turn?.status === 'cancelled') throw new Error(`Pi Turn ended ${turn.status}: ${turn.error?.code ?? 'no error code'}`);
    if (rejectActions && session.required_actions.length) throw new Error('The recall Turn requested an application function');
    return turn?.status === 'completed';
  });
  const saved = await api.beta.agents.sessions.retrieve(sessionId);
  expect(saved.required_actions).toEqual([]);
}

async function assertCompletedAnswerContainsExactMarker(api: ReturnType<typeof createAgentsClient>, sessionId: string, turnId: string, marker: string, expectedCallId?: string): Promise<void> {
  const items: AgentSessionItem[] = [];
  for await (const item of api.beta.agents.sessions.items.list(sessionId, { limit: 100, order: 'asc' })) {
    if (item.turn_id === turnId) items.push(item);
  }
  const calls = items.filter(item => item.type === 'function_call');
  const outputs = items.filter(item => item.type === 'function_call_output');
  if (expectedCallId) {
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: 'lookup_proof_token', arguments: { key: 'proof' }, call_id: expectedCallId });
    const matching = outputs.filter(item => item.call_id === expectedCallId);
    expect(matching).toHaveLength(1);
    expect(matching[0]).toMatchObject({ output: marker });
    expect(outputs).toHaveLength(1);
  } else {
    expect(calls).toHaveLength(0);
    expect(outputs).toHaveLength(0);
  }
  const answer = items.flatMap(item => {
    if (item.type !== 'message' || item.role !== 'assistant' || item.status !== 'completed' || item.phase !== 'final_answer') return [];
    return item.content.flatMap(part => part.type === 'output_text' ? [part.text] : []);
  }).join('').trim();
  const markers = new Set(answer.match(/pi-proof-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? []);
  expect([...markers]).toEqual([marker]);
}

async function rootTurnIds(api: ReturnType<typeof createAgentsClient>, sessionId: string): Promise<Set<string>> {
  const ids = new Set<string>();
  for await (const turn of api.beta.agents.sessions.turns.list(sessionId, { limit: 100, order: 'asc' })) {
    if (turn.subagent_id === null) ids.add(turn.id);
  }
  return ids;
}

async function waitForNewRootTurn(api: ReturnType<typeof createAgentsClient>, sessionId: string, previous: ReadonlySet<string>) {
  let next: Turn | undefined;
  await eventually(async () => {
    const roots = [];
    for await (const turn of api.beta.agents.sessions.turns.list(sessionId, { limit: 100, order: 'asc' })) {
      if (turn.subagent_id === null && !previous.has(turn.id)) roots.push(turn);
    }
    if (roots.length > 1) throw new Error('More than one new root Turn appeared');
    next = roots[0];
    if (next?.status === 'failed' || next?.status === 'cancelled') throw new Error(`Pi recall Turn ended ${next.status}: ${next.error?.code ?? 'no error code'}`);
    return Boolean(next);
  });
  if (!next) throw new Error('Pi did not create the recall Turn');
  return next;
}

function assertContinuation(first: SettledEvidence, second: SettledEvidence, pin: RuntimeIdentity): void {
  expect(second.worker.sessionId).toBe(first.worker.sessionId);
  expect(second.turnId).not.toBe(first.turnId);
  expect(second.worker.runId).not.toBe(first.worker.runId);
  expect(second.worker.executionId).not.toBe(first.worker.executionId);
  expect(second.worker.generation).not.toBe(first.worker.generation);
  expect(second.rootThreadId).toBe(first.rootThreadId);
  expect(second.rootTurnIds).toContain(first.turnId);
  expect(second.rootTurnIds).toContain(second.turnId);
  expect(second.epoch).toBeGreaterThan(first.epoch);
  expect(second.head.seq).toBeGreaterThan(first.head.seq);
  expect(pin.runtime).toBe('pi');
  expect(pin.catalog_digest).toMatch(/^[a-f0-9]{64}$/);
}

function assertSameWorker(worker: WorkerIdentity, turnId: string, run: RunRecord): void {
  expect(run.ownerId).toBe(worker.ownerId);
  expect(run.agentsSession?.sessionId).toBe(worker.sessionId);
  expect(run.agentsSession?.turnId).toBe(turnId);
  expect(run.runId).toBe(worker.runId);
  expect(run.execution?.backend).toBe('microvm');
  expect(run.execution?.id).toBe(worker.executionId);
  expect(run.execution?.generation).toBe(worker.generation);
}

function stopProof(error: unknown): StopProof | undefined {
  if (!(error instanceof Error)) return undefined;
  if (error.name === 'ResourceNotFoundException' || error.name === 'GoneException') return { kind: 'absent', errorName: error.name };
  if (error.name === 'ValidationException' && /\bmicrovm\b.*\b(?:has been|is(?: already)?) terminated\b/i.test(error.message)) {
    return { kind: 'already-terminated', errorName: 'ValidationException' };
  }
  return undefined;
}

function parseStringList(raw: string, name: string): string[] {
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error(`${name} must be a JSON array of strings`);
  return value;
}

function configuredModelCount(): number {
  try {
    const parsed: unknown = JSON.parse(process.env.AWS_E2E_PI_BEDROCK_MODEL_IDS_JSON ?? '[]');
    return Array.isArray(parsed) ? Math.max(2, parsed.length) : 2;
  } catch {
    return 2;
  }
}

function failure(context: string, error: unknown): Error {
  return new Error(context, { cause: error });
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function eventually(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(2000);
  }
  throw new Error('Pi runtime proof did not settle before its deadline');
}
