import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { GetMicrovmCommand, LambdaMicrovmsClient, SuspendMicrovmCommand, TerminateMicrovmCommand } from '@aws-sdk/client-lambda-microvms';
import { expect, it } from 'vitest';
import { createAgentsClient } from '../../src/agents-client.js';
import { DynamoAgentsStore } from '../../src/adapters/dynamo-agents-store.js';
import { S3ArtifactStore } from '../../src/adapters/aws-runtime.js';
import { MicrovmAgentInteractionController, MicrovmExecutionInspector } from '../../src/adapters/executors.js';
import type { StoredSessionRuntime } from '../../src/core/session-runtime-store.js';
import type { RunRecord } from '../../src/domain/contracts.js';

const live = process.env.AWS_E2E === 'true' && process.env.AWS_E2E_SUSPENSION_PROOF === 'true' ? it : it.skip;
const timeoutMs = Number(process.env.AWS_E2E_TIMEOUT_MS ?? 420_000);
const execute = promisify(execFile);

live('retains a suspended MicroVM through reconciliation and resumes the same workspace and native thread', async () => {
  if (process.env.AWS_E2E_REAL_CODEX !== 'true' || process.env.AWS_E2E_ENABLE_MICROVM !== 'true') throw new Error('Explicit MicroVM/model opt-in required');
  const region = required('AWS_REGION');
  const deploymentId = required('AWS_E2E_DEPLOYMENT_ID');
  if (!/^[a-z0-9][a-z0-9-]{2,13}$/.test(deploymentId)) throw new Error('Invalid disposable deployment ID');
  const deployment = `rat-things-${deploymentId}`;
  const account = required('AWS_E2E_CALLER_ACCOUNT');
  expect((await execute('aws', ['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text'], { timeout: 30_000 })).stdout.trim()).toBe(account);
  expect(required('RUNS_TABLE_NAME')).toBe(`${deployment}-runs`);
  expect(required('RECONCILER_FUNCTION_NAME')).toBe(`${deployment}-reconciler`);
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  const s3 = new S3Client({ region });
  const microvms = new LambdaMicrovmsClient({ region });
  const store = new DynamoAgentsStore(db, `${deployment}-agents`, new S3ArtifactStore(s3, required('DEFINITION_BUCKET')));
  const api = createAgentsClient({ baseURL: required('RAT_THINGS_AGENTS_API_URL'), region }).withOptions({ maxRetries: 4 });
  let sessionId: string | undefined;
  let agentId: string | undefined;
  let run: RunRecord | undefined;
  const readRun = async () => (await db.send(new GetCommand({ TableName: `${deployment}-runs`, Key: { runId: run!.runId }, ConsistentRead: true }))).Item as RunRecord;
  const worker = async () => {
    if (!run?.execution?.generation || run.execution.backend !== 'microvm') throw new Error('Missing fenced MicroVM');
    const current = await readRun();
    expect(current.agentsSession?.sessionId).toBe(sessionId);
    expect(current.execution).toEqual(run.execution);
    const vm = await microvms.send(new GetMicrovmCommand({ microvmIdentifier: run.execution.id }));
    expect(vm.executionRoleArn).toBe(`arn:aws:iam::${account}:role/${deployment}-microvm-execution`);
    return vm;
  };
  const reconcile = async () => {
    const response = await execute('aws', ['lambda', 'invoke', '--region', region, '--function-name', `${deployment}-reconciler`, '--payload', '{}', '--cli-binary-format', 'raw-in-base64-out', '/dev/null'], { timeout: 120_000 });
    expect(JSON.parse(response.stdout).FunctionError).toBeUndefined();
  };
  try {
    const marker = `suspension-${randomUUID()}`;
    const agent = await api.beta.agents.create({ name: 'Disposable suspension proof', model: required('AWS_E2E_CODEX_MODEL_ID'), tools: [] });
    agentId = agent.id;
    const session = await api.beta.agents.sessions.create({ agent_id: agent.id, environment: { type: 'openai_hosted', network: { access: 'disabled' } },
      input: `Remember this exact marker: ${marker}. Use a command to write it to /workspace/suspension-marker.txt, then answer READY.` });
    sessionId = session.id;
    await completedTurn(api, session.id);
    await eventually(async () => {
      let cursor: Record<string, unknown> | undefined;
      do {
        const page = await db.send(new ScanCommand({ TableName: `${deployment}-runs`, ConsistentRead: true,
          FilterExpression: 'agentsSession.sessionId = :session', ExpressionAttributeValues: { ':session': session.id },
          ...(cursor ? { ExclusiveStartKey: cursor } : {}) }));
        run = page.Items?.find(value => value.status === 'running' && value.execution?.backend === 'microvm') as RunRecord | undefined;
        if (run?.execution?.generation) return true;
        cursor = page.LastEvaluatedKey;
      } while (cursor);
      return false;
    });
    const captured = run!;
    const rootThreadId = (await store.get<StoredSessionRuntime>(captured.ownerId, 'session_runtime', session.id))?.value.snapshot?.rootThreadId;
    expect(rootThreadId).toBeTruthy();
    expect((await worker()).state).toBe('RUNNING');
    // Force suspension of only this fixture. This proves native freeze/resume
    // and reconciliation, not the idle-policy timer or a one-hour wall-clock soak.
    await microvms.send(new SuspendMicrovmCommand({ microvmIdentifier: captured.execution!.id }));
    await eventually(async () => (await worker()).state === 'SUSPENDED');
    const ageHeartbeat = async () => {
      const current = await readRun();
      const stale = new Date(Date.now() - 3_601_000).toISOString();
      await db.send(new UpdateCommand({ TableName: `${deployment}-runs`, Key: { runId: captured.runId },
        ConditionExpression: '#status = :running AND execution.id = :id AND execution.generation = :generation AND heartbeatAt = :previous AND agentsSession.sessionId = :session',
        UpdateExpression: 'SET heartbeatAt = :stale REMOVE liveness', ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':running': 'running', ':id': captured.execution!.id, ':generation': captured.execution!.generation,
          ':previous': current.heartbeatAt, ':session': session.id, ':stale': stale } }));
      return stale;
    };
    await ageHeartbeat();
    await delay(1_000); // Give the heartbeat GSI time to expose this bounded injection.
    for (let index = 0; index < 4; index++) {
      const previousCheck = (await readRun()).liveness?.checkedAt;
      await eventually(async () => {
        await reconcile();
        const current = await readRun();
        expect(current.status).toBe('running');
        return current.liveness?.outcome === 'suspended' && current.liveness.checkedAt !== previousCheck;
      });
      expect((await readRun()).liveness).toMatchObject({ outcome: 'suspended', consecutiveUncertain: 0 });
      expect((await readRun()).liveness).not.toHaveProperty('quarantinedAt');
      expect((await worker()).state).toBe('SUSPENDED');
      await delay(1_000);
    }
    console.log(JSON.stringify({ phase: 'suspended-reconciliation-passed', sessionId, runId: captured.runId, microvmId: captured.execution!.id }));

    const target = { runId: captured.runId, execution: captured.execution! };
    const resumeStarted = Date.now();
    await new MicrovmAgentInteractionController(microvms).events(target);
    const inspection = await new MicrovmExecutionInspector(microvms).inspect(captured.runId, captured.execution!);
    expect(inspection.kind).toBe('active');
    if (inspection.kind !== 'active' || !inspection.lastResumedAt) throw new Error('Candidate image did not publish resume evidence');
    expect(Date.parse(inspection.lastResumedAt)).toBeGreaterThanOrEqual(resumeStarted - 1_000);
    // Force the stale-heartbeat/fresh-resume race through the deployed Lambda.
    // A real heartbeat may win the CAS; retry without bypassing that fence.
    let protectedResume = false;
    for (let attempt = 0; attempt < 4 && !protectedResume; attempt++) {
      try {
        await worker();
        const stale = await ageHeartbeat();
        await delay(1_000);
        await reconcile();
        const current = await readRun();
        expect(current.status).toBe('running');
        protectedResume = current.heartbeatAt === stale && current.liveness?.outcome === 'active';
      } catch (error) { if ((error as Error).name !== 'ConditionalCheckFailedException') throw error; }
    }
    expect(protectedResume).toBe(true);
    const previousTurns = new Set((await api.beta.agents.sessions.turns.list(session.id)).data.map(turn => turn.id));
    await api.beta.agents.sessions.events.create(session.id, { events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: 'Read /workspace/suspension-marker.txt using a command. Return its exact content and the marker you remember from the previous Turn. Do not create or rewrite the file.' }] }] }] });
    await completedTurn(api, session.id, previousTurns);
    const items = [];
    for await (const item of api.beta.agents.sessions.items.list(session.id)) if (!previousTurns.has(item.turn_id)) items.push(item);
    expect(items).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'command_execution', status: 'completed', exit_code: 0 })]));
    expect(JSON.stringify(items.filter(item => item.type === 'message' && item.role === 'assistant'))).toContain(marker);
    expect((await store.get<StoredSessionRuntime>(captured.ownerId, 'session_runtime', session.id))?.value.snapshot?.rootThreadId).toBe(rootThreadId);
    expect((await readRun()).status).toBe('running');
    console.log(JSON.stringify({ phase: 'resume-continuity-passed', sessionId, runId: captured.runId, rootThreadId }));
    await worker();
    await microvms.send(new SuspendMicrovmCommand({ microvmIdentifier: captured.execution!.id }));
    await eventually(async () => (await worker()).state === 'SUSPENDED');
    await api.beta.agents.sessions.delete(session.id);
    await eventually(async () => ['TERMINATING', 'TERMINATED'].includes((await worker()).state ?? ''));
    sessionId = undefined;
    console.log(JSON.stringify({ phase: 'suspended-session-delete-released-worker', runId: captured.runId }));
  } finally {
    try {
      if (sessionId) {
        try { await api.beta.agents.sessions.delete(sessionId); }
        finally {
          if (run?.execution && !['TERMINATING', 'TERMINATED'].includes((await worker()).state ?? '')) {
            await microvms.send(new TerminateMicrovmCommand({ microvmIdentifier: run.execution.id }));
            console.log(JSON.stringify({ phase: 'manual-cleanup', microvmId: run.execution.id }));
          }
        }
      }
    } finally {
      try { if (agentId) await api.beta.agents.delete(agentId); }
      finally { db.destroy(); s3.destroy(); microvms.destroy(); }
    }
  }
}, timeoutMs * 3);

async function completedTurn(api: ReturnType<typeof createAgentsClient>, sessionId: string, seen = new Set<string>()) {
  await eventually(async () => {
    for await (const turn of api.beta.agents.sessions.turns.list(sessionId)) {
      if (seen.has(turn.id) || turn.subagent_id !== null) continue;
      if (turn.status === 'failed' || turn.status === 'cancelled') throw new Error(`Suspension proof Turn ended ${turn.status}`);
      if (turn.status === 'completed') return true;
    }
    return false;
  });
}
async function eventually(check: () => Promise<boolean>) {
  const deadline = Date.now() + timeoutMs;
  do { if (await check()) return; await delay(2_000); } while (Date.now() < deadline);
  throw new Error('Suspension proof exceeded deadline');
}
function required(name: string): string { const value = process.env[name]; if (!value) throw new Error(`${name} required`); return value; }
