import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { CreateMicrovmAuthTokenCommand, GetMicrovmCommand, LambdaMicrovmsClient, TerminateMicrovmCommand } from '@aws-sdk/client-lambda-microvms';
import { expect, it } from 'vitest';
import { createAgentsClient } from '../../src/agents-client.js';
import { DynamoAgentsStore } from '../../src/adapters/dynamo-agents-store.js';
import { S3ArtifactStore } from '../../src/adapters/aws-runtime.js';
import type { StoredSessionRuntime } from '../../src/core/session-runtime-store.js';
import type { StoredEnvironment } from '../../src/core/environment-service.js';
import type { RunRecord } from '../../src/domain/contracts.js';

const live = process.env.AWS_E2E === 'true' && process.env.AWS_E2E_CHECKPOINT_WORKER === 'true' ? it : it.skip;
const timeoutMs = Number(process.env.AWS_E2E_TIMEOUT_MS ?? 420_000);
const execute = promisify(execFile);

live('replaces two checkpointed workers while preserving native history, modified inputs and setup state', async () => {
  if (process.env.AWS_E2E_REAL_CODEX !== 'true' || process.env.AWS_E2E_ENABLE_MICROVM !== 'true') throw new Error('Explicit MicroVM/model opt-in required');
  const region = required('AWS_REGION');
  const deploymentId = required('AWS_E2E_DEPLOYMENT_ID');
  if (!/^[a-z0-9][a-z0-9-]{2,13}$/.test(deploymentId)) throw new Error('Invalid disposable deployment ID');
  const deployment = `rat-things-${deploymentId}`;
  const account = required('AWS_E2E_CALLER_ACCOUNT');
  expect((await execute('aws', ['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text'], { timeout: 30_000 })).stdout.trim()).toBe(account);
  expect(required('RUNS_TABLE_NAME')).toBe(`${deployment}-runs`);
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  const s3 = new S3Client({ region });
  const microvms = new LambdaMicrovmsClient({ region });
  const store = new DynamoAgentsStore(db, `${deployment}-agents`, new S3ArtifactStore(s3, required('DEFINITION_BUCKET')));
  const api = createAgentsClient({ baseURL: required('RAT_THINGS_AGENTS_API_URL'), region }).withOptions({ maxRetries: 4 });
  let sessionId: string | undefined;
  let agentId: string | undefined;
  let ownerId: string | undefined;
  let environmentId: string | undefined;
  const workers = new Map<string, RunRecord>();
  const readRun = async (runId: string) => (await db.send(new GetCommand({ TableName: `${deployment}-runs`, Key: { runId }, ConsistentRead: true }))).Item as RunRecord;
  const runtime = async () => (await store.get<StoredSessionRuntime>(ownerId!, 'session_runtime', sessionId!))!.value;
  const environment = async () => (await store.get<StoredEnvironment>(ownerId!, 'environments', environmentId!))!.value;
  const worker = async (run: RunRecord) => {
    if (run.execution?.backend !== 'microvm' || !run.execution.generation) throw new Error('Missing fenced MicroVM');
    expect((await readRun(run.runId)).execution).toEqual(run.execution);
    const vm = await microvms.send(new GetMicrovmCommand({ microvmIdentifier: run.execution.id }));
    expect(vm.executionRoleArn).toBe(`arn:aws:iam::${account}:role/${deployment}-microvm-execution`);
    return vm;
  };
  try {
    const memory = `memory-${randomUUID()}`;
    const fileMarker = `file-${randomUUID()}`;
    agentId = (await api.beta.agents.create({ name: 'Disposable checkpoint replacement proof', model: required('AWS_E2E_CODEX_MODEL_ID'), tools: [] })).id;
    const session = await api.beta.agents.sessions.create({ agent_id: agentId, environment: { type: 'openai_hosted', network: { access: 'disabled' },
      files: [{ type: 'inline', path: '/workspace/checkpoint-input.txt', data: Buffer.from('original-input').toString('base64') }],
      setup_commands: [{ command: 'echo setup >> /workspace/checkpoint-setup-count.txt' }] },
      input: `Remember this harmless test marker in our conversation: ${memory}. Do not write the marker into workspace files; a later Turn will ask you to repeat it. Using a command, overwrite /workspace/checkpoint-input.txt with ${fileMarker}, then answer READY.` });
    sessionId = session.id;
    if (session.environment.type !== 'openai_hosted') throw new Error('Expected hosted environment');
    environmentId = session.environment.id;
    await completedTurn(api, sessionId);
    // The public session carries the authenticated owner; find the exact runtime through its Run index.
    let cursor: Record<string, unknown> | undefined;
    do {
      const page = await db.send(new ScanCommand({ TableName: `${deployment}-runs`, ConsistentRead: true,
        FilterExpression: 'agentsSession.sessionId = :session', ExpressionAttributeValues: { ':session': sessionId },
        ...(cursor ? { ExclusiveStartKey: cursor } : {}) }));
      const run = page.Items?.find(value => value.status === 'running' && value.execution?.backend === 'microvm') as RunRecord | undefined;
      if (run) { ownerId = run.ownerId; workers.set(run.runId, run); break; }
      cursor = page.LastEvaluatedKey;
    } while (cursor);
    if (!ownerId) throw new Error('Fixture Run not found');
    const rootThreadId = (await runtime()).snapshot!.rootThreadId;
    const initialEnvironment = await environment();
    let current = [...workers.values()][0]!;
    for (let replacement = 1; replacement <= 2; replacement++) {
      const vm = await worker(current);
      const token = (await microvms.send(new CreateMicrovmAuthTokenCommand({ microvmIdentifier: current.execution!.id, expirationInMinutes: 3, allowedPorts: [{ port: 8080 }] }))).authToken?.['X-aws-proxy-auth'];
      if (!token || !vm.endpoint) throw new Error('No private checkpoint endpoint');
      const endpoint = vm.endpoint.startsWith('https://') ? vm.endpoint : `https://${vm.endpoint}`;
      const response = await fetch(`${endpoint}/agent-runtime/v1/runs/${current.runId}/checkpoint`, { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-aws-proxy-auth': token, 'x-aws-proxy-port': '8080' }, body: '{}', signal: AbortSignal.timeout(125_000) });
      if (!response.ok) throw new Error(`Private checkpoint failed (${response.status}): ${await response.text()}`);
      const checkpoint = await response.json() as { id: string; rootThreadId: string };
      expect(checkpoint.rootThreadId).toBe(rootThreadId);
      expect((await environment()).handoff).toMatchObject({ phase: 'committed', checkpoint: { id: checkpoint.id, source: { runId: current.runId, generation: current.execution!.generation } } });
      await eventually(async () => (await readRun(current.runId)).status === 'succeeded');
      await eventually(async () => (await worker(current)).state === 'TERMINATED');
      console.log(JSON.stringify({ phase: 'checkpoint-source-terminated', replacement, sessionId, runId: current.runId, microvmId: current.execution!.id, checkpointId: checkpoint.id, rootThreadId }));
      const seen = new Set((await api.beta.agents.sessions.turns.list(sessionId)).data.map(turn => turn.id));
      await api.beta.agents.sessions.events.create(sessionId, { events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: 'Read /workspace/checkpoint-input.txt and /workspace/checkpoint-setup-count.txt with a command. Do not modify files. Report the exact input contents, the number of setup lines, and the harmless conversation test marker from our first Turn.' }] }] }] });
      await completedTurn(api, sessionId, seen);
      const nextRuntime = await runtime();
      expect(nextRuntime.runId).not.toBe(current.runId);
      current = await readRun(nextRuntime.runId!); workers.set(current.runId, current);
      expect(nextRuntime.snapshot!.rootThreadId).toBe(rootThreadId);
      const nextEnvironment = await environment();
      expect(nextEnvironment.sandboxId).toBe(initialEnvironment.sandboxId);
      expect(nextEnvironment.resetCount).toBe(initialEnvironment.resetCount);
      expect(nextEnvironment.handoff).toMatchObject({ phase: 'consumed', checkpoint: { id: checkpoint.id }, successor: { runId: current.runId, generation: current.execution!.generation } });
      const items = [];
      for await (const item of api.beta.agents.sessions.items.list(sessionId)) if (!seen.has(item.turn_id)) items.push(item);
      const commands = items.filter(item => item.type === 'command_execution' && item.status === 'completed' && item.exit_code === 0);
      expect(commands.length).toBeGreaterThan(0);
      expect(JSON.stringify(commands)).toContain(fileMarker);
      const answers = JSON.stringify(items.filter(item => item.type === 'message' && item.role === 'assistant'));
      expect(answers).toContain(memory);
      expect(answers).toContain(fileMarker);
      // Each setup invocation appends six bytes, independently of model phrasing.
      const setup = (await api.beta.agents.environments.files.list(environmentId, { path: '/workspace' })).data.find(file => file.path === '/workspace/checkpoint-setup-count.txt');
      expect(setup?.size_bytes).toBe(6);
      console.log(JSON.stringify({ phase: 'checkpoint-replacement-passed', replacement, sessionId, runId: current.runId, microvmId: current.execution!.id, rootThreadId, sandboxId: nextEnvironment.sandboxId, resetCount: nextEnvironment.resetCount }));
    }
    // A consumed permit cannot preserve mutable files after an uncheckpointed crash.
    await worker(current);
    await microvms.send(new TerminateMicrovmCommand({ microvmIdentifier: current.execution!.id }));
    await eventually(async () => (await worker(current)).state === 'TERMINATED');
    await eventually(async () => {
      const result = await execute('aws', ['lambda', 'invoke', '--region', region, '--function-name', `${deployment}-reconciler`, '--payload', '{}', '--cli-binary-format', 'raw-in-base64-out', '/dev/null'], { timeout: 120_000 });
      expect(JSON.parse(result.stdout).FunctionError).toBeUndefined();
      return ['succeeded', 'failed', 'cancelled'].includes((await readRun(current.runId)).status);
    });
    const seen = new Set((await api.beta.agents.sessions.turns.list(sessionId)).data.map(turn => turn.id));
    await api.beta.agents.sessions.events.create(sessionId, { events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: 'Read /workspace/checkpoint-input.txt using a command and report its exact contents. Do not change it.' }] }] }] });
    await completedTurn(api, sessionId, seen);
    current = await readRun((await runtime()).runId!); workers.set(current.runId, current);
    const reset = await environment();
    expect(reset.handoff).toBeUndefined();
    expect(reset.sandboxId).not.toBe(initialEnvironment.sandboxId);
    expect(reset.resetCount).toBe((initialEnvironment.resetCount ?? 0) + 1);
    const resetItems = [];
    for await (const item of api.beta.agents.sessions.items.list(sessionId)) if (!seen.has(item.turn_id)) resetItems.push(item);
    expect(JSON.stringify(resetItems.filter(item => item.type === 'command_execution' && item.exit_code === 0))).toContain('original-input');
    console.log(JSON.stringify({ phase: 'consumed-checkpoint-crash-recovery-passed', sessionId, runId: current.runId, microvmId: current.execution!.id, resetCount: reset.resetCount }));
  } finally {
    try {
      if (sessionId) await api.beta.agents.sessions.delete(sessionId);
    } finally {
      // Bootstrap can fail before the first completed Turn exposes its Run.
      // Discover only this fixture's executions so even that path stops its VM.
      if (sessionId) {
        let cursor: Record<string, unknown> | undefined;
        do {
          const page = await db.send(new ScanCommand({ TableName: `${deployment}-runs`, ConsistentRead: true,
            FilterExpression: 'agentsSession.sessionId = :session', ExpressionAttributeValues: { ':session': sessionId },
            ...(cursor ? { ExclusiveStartKey: cursor } : {}) }));
          for (const value of page.Items ?? []) {
            const run = value as RunRecord;
            if (run.execution?.backend === 'microvm' && run.execution.id !== 'pending' && run.execution.generation) workers.set(run.runId, run);
          }
          cursor = page.LastEvaluatedKey;
        } while (cursor);
      }
      for (const run of workers.values()) {
        const vm = await worker(run);
        if (!['TERMINATING', 'TERMINATED'].includes(vm.state ?? '')) await microvms.send(new TerminateMicrovmCommand({ microvmIdentifier: run.execution!.id }));
      }
      if (agentId) await api.beta.agents.delete(agentId);
      db.destroy(); s3.destroy(); microvms.destroy();
    }
  }
}, timeoutMs * 4);

async function completedTurn(api: ReturnType<typeof createAgentsClient>, sessionId: string, seen = new Set<string>()) {
  await eventually(async () => {
    for await (const turn of api.beta.agents.sessions.turns.list(sessionId)) {
      if (seen.has(turn.id) || turn.subagent_id !== null) continue;
      if (turn.status === 'failed' || turn.status === 'cancelled') throw new Error(`Checkpoint proof Turn ended ${turn.status}: ${JSON.stringify(turn.error)}`);
      if (turn.status === 'completed') return true;
    }
    return false;
  });
}
async function eventually(check: () => Promise<boolean>) {
  const deadline = Date.now() + timeoutMs;
  do { if (await check()) return; await delay(2_000); } while (Date.now() < deadline);
  throw new Error('Checkpoint proof exceeded deadline');
}
function required(name: string): string { const value = process.env[name]; if (!value) throw new Error(`${name} required`); return value; }
