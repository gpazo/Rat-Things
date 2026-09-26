import { setTimeout as delay } from 'node:timers/promises';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { EC2Client, DescribeInstancesCommand, TerminateInstancesCommand } from '@aws-sdk/client-ec2';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { createAgentsClient } from '../../src/agents-client.js';
import type { RunRecord } from '../../src/domain/contracts.js';

const live = process.env.AWS_E2E === 'true' && process.env.AWS_E2E_HEARTBEAT_EXPIRY_PROOF === 'true' ? it : it.skip;
const timeoutMs = Number(process.env.AWS_E2E_TIMEOUT_MS ?? 420_000);

live('expires a verified dedicated worker after fault-injected one-hour heartbeat loss', async () => {
  if (process.env.AWS_E2E_REAL_CODEX !== 'true' || process.env.AWS_E2E_ENABLE_EC2_WORKER !== 'true') throw new Error('Explicit dedicated-worker/model opt-in required');
  const region = required('AWS_REGION');
  const deployment = `rat-things-${required('AWS_E2E_DEPLOYMENT_ID')}`;
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  const ec2 = new EC2Client({ region });
  const api = createAgentsClient({ baseURL: required('RAT_THINGS_AGENTS_API_URL'), region }).withOptions({ maxRetries: 4 });
  let sessionId: string | undefined; let run: RunRecord | undefined;
  const worker = async () => {
    if (!run?.execution?.generation) throw new Error('Missing fenced worker');
    const instance = (await ec2.send(new DescribeInstancesCommand({ InstanceIds: [run.execution.id] }))).Reservations?.flatMap(value => value.Instances ?? [])[0];
    const tags = Object.fromEntries((instance?.Tags ?? []).map(tag => [tag.Key, tag.Value]));
    expect(tags).toMatchObject({ RatDeployment: deployment, RatRunId: run.runId, RatGeneration: run.execution.generation, 'aws:ec2launchtemplate:id': required('AWS_E2E_RECOVERY_LAUNCH_TEMPLATE_ID') });
    return instance!;
  };
  try {
    const session = await api.beta.agents.sessions.create({ agent: { model: required('AWS_E2E_CODEX_MODEL_ID'), tools: [] }, environment: { type: 'openai_hosted', network: { access: 'disabled' } }, input: 'Answer READY.' });
    sessionId = session.id;
    await eventually(async () => {
      if (!(await api.beta.agents.sessions.turns.list(session.id)).data.some(turn => turn.status === 'completed')) return false;
      let cursor: Record<string, unknown> | undefined;
      do {
        const page = await db.send(new ScanCommand({ TableName: `${deployment}-runs`, ConsistentRead: true, FilterExpression: 'agentsSession.sessionId = :session', ExpressionAttributeValues: { ':session': session.id }, ...(cursor ? { ExclusiveStartKey: cursor } : {}) }));
        run = page.Items?.find(value => value.status === 'running' && value.execution?.backend === 'ec2') as RunRecord | undefined;
        if (run?.execution?.generation) return true;
        cursor = page.LastEvaluatedKey;
      } while (cursor);
      return false;
    });
    expect((await worker()).State?.Name).toBe('running');
    const captured = run!;
    const read = async () => (await db.send(new GetCommand({ TableName: `${deployment}-runs`, Key: { runId: captured.runId }, ConsistentRead: true }))).Item as RunRecord;
    // Inject only this disposable execution's durable heartbeat age. This proves
    // deployed reconciliation, not an hour of wall-clock inactivity. A fresh
    // heartbeat is allowed to win; the conditional fence must not be bypassed.
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await read();
      if (current.status === 'failed') break;
      await worker();
      try {
        await db.send(new UpdateCommand({ TableName: `${deployment}-runs`, Key: { runId: captured.runId },
          ConditionExpression: '#status = :running AND execution.id = :id AND execution.generation = :generation AND heartbeatAt = :previous AND agentsSession.sessionId = :session',
          UpdateExpression: 'SET heartbeatAt = :stale', ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':running': 'running', ':id': captured.execution!.id, ':generation': captured.execution!.generation, ':previous': current.heartbeatAt, ':session': session.id, ':stale': new Date(Date.now() - 3_601_000).toISOString() } }));
      } catch (error) { if ((error as Error).name === 'ConditionalCheckFailedException') continue; throw error; }
      await delay(1_000);
      const response = await promisify(execFile)('aws', ['lambda', 'invoke', '--region', region, '--function-name', `${deployment}-reconciler`, '--payload', '{}', '--cli-binary-format', 'raw-in-base64-out', '/dev/null'], { timeout: 120_000 });
      expect(JSON.parse(response.stdout).FunctionError).toBeUndefined();
      if ((await read()).status === 'failed') break;
    }
    expect(await read()).toMatchObject({ status: 'failed', error: { code: 'execution_lost', message: 'Worker keep-alives stopped for one hour' } });
    // No delete or test-side terminate may help this assertion pass.
    await eventually(async () => (await worker()).State?.Name === 'terminated');
    console.log(JSON.stringify({ phase: 'deployed-heartbeat-expiry-passed', sessionId, runId: captured.runId, instanceId: captured.execution!.id }));
  } finally {
    try {
      if (run?.execution && (await worker()).State?.Name !== 'terminated') {
        await ec2.send(new TerminateInstancesCommand({ InstanceIds: [run.execution.id] }));
        console.log(JSON.stringify({ phase: 'manual-cleanup', instanceId: run.execution.id }));
      }
    } finally {
      try { if (sessionId) await api.beta.agents.sessions.delete(sessionId); }
      finally { db.destroy(); ec2.destroy(); }
    }
  }
}, timeoutMs * 2);
async function eventually(check: () => Promise<boolean>) { const deadline = Date.now() + timeoutMs; do { if (await check()) return; await delay(2_000); } while (Date.now() < deadline); throw new Error('Expiry proof exceeded deadline'); }
function required(name: string): string { const value = process.env[name]; if (!value) throw new Error(`${name} required`); return value; }
