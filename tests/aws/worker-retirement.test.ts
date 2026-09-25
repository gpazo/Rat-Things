import { setTimeout as delay } from 'node:timers/promises';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { EC2Client, DescribeInstancesCommand, TerminateInstancesCommand } from '@aws-sdk/client-ec2';
import { expect, it } from 'vitest';
import { createAgentsClient } from '../../src/agents-client.js';
import type { RunRecord } from '../../src/domain/contracts.js';

const live = process.env.AWS_E2E === 'true' && process.env.AWS_E2E_WORKER_RETIREMENT_PROOF === 'true' ? it : it.skip;
const timeoutMs = Number(process.env.AWS_E2E_TIMEOUT_MS ?? 600_000);

live('retires the dedicated worker automatically after hosted initialization fails', async () => {
  if (process.env.AWS_E2E_ENABLE_EC2_WORKER !== 'true') throw new Error('Requires the dedicated EC2 backend.');
  const region = required('AWS_REGION');
  const deployment = `rat-things-${required('AWS_E2E_DEPLOYMENT_ID')}`;
  const templateId = required('AWS_E2E_RECOVERY_LAUNCH_TEMPLATE_ID');
  const client = createAgentsClient({ baseURL: required('RAT_THINGS_AGENTS_API_URL'), region }).withOptions({ maxRetries: 2 });
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  const ec2 = new EC2Client({ region });
  const agent = await client.beta.agents.create({ model: required('AWS_E2E_CODEX_MODEL_ID'), tools: [] });
  let sessionId: string | undefined;
  let worker: { id: string; runId: string; generation: string } | undefined;
  const instance = async () => {
    if (!worker) throw new Error('No verified worker');
    const found = (await ec2.send(new DescribeInstancesCommand({ InstanceIds: [worker.id] }))).Reservations?.flatMap(value => value.Instances ?? [])[0];
    const tags = Object.fromEntries((found?.Tags ?? []).map(tag => [tag.Key, tag.Value]));
    expect(tags).toMatchObject({ RatDeployment: deployment, RatRunId: worker.runId, RatGeneration: worker.generation, 'aws:ec2launchtemplate:id': templateId });
    return found!;
  };
  try {
    const session = await client.beta.agents.sessions.create({ agent_id: agent.id,
      environment: { type: 'openai_hosted', network: { access: 'disabled' }, setup_commands: [{ command: 'exit 73' }] },
      input: 'Return INITIALIZATION_SHOULD_HAVE_FAILED.' });
    sessionId = session.id;
    console.log(JSON.stringify({ phase: 'created', sessionId }));
    let terminal: RunRecord | undefined;
    await eventually(async () => {
      let cursor: Record<string, unknown> | undefined;
      do {
        const page = await db.send(new ScanCommand({ TableName: `${deployment}-runs`, ConsistentRead: true,
          FilterExpression: 'agentsSession.sessionId = :session', ExpressionAttributeValues: { ':session': session.id },
          ...(cursor ? { ExclusiveStartKey: cursor } : {}) }));
        const run = page.Items?.[0] as RunRecord | undefined;
        if (run?.execution?.backend === 'ec2' && run.execution.id !== 'pending' && run.execution.generation) {
          worker = { id: run.execution.id, runId: run.runId, generation: run.execution.generation };
          if (run.status === 'failed') { terminal = run; return true; }
        }
        cursor = page.LastEvaluatedKey;
      } while (cursor);
      return false;
    });
    expect(terminal).toMatchObject({ status: 'failed', error: { code: 'agent_failed', message: 'Environment setup command 1 failed' } });
    console.log(JSON.stringify({ phase: 'failed', sessionId, ...worker }));
    // No Session deletion or termination request may help this assertion pass.
    await eventually(async () => (await instance()).State?.Name === 'terminated');
    console.log(JSON.stringify({ phase: 'retired', sessionId, ...worker }));
  } finally {
    try {
      if (worker && (await instance()).State?.Name !== 'terminated') {
        await ec2.send(new TerminateInstancesCommand({ InstanceIds: [worker.id] }));
        console.log(JSON.stringify({ phase: 'manual-cleanup', ...worker }));
      }
    } finally {
      try { if (sessionId) await client.beta.agents.sessions.delete(sessionId); }
      finally { try { await client.beta.agents.delete(agent.id); } finally { db.destroy(); ec2.destroy(); } }
    }
  }
}, timeoutMs * 2);

async function eventually(check: () => Promise<boolean>) {
  const deadline = Date.now() + timeoutMs;
  do { if (await check()) return; await delay(2_000); } while (Date.now() < deadline);
  throw new Error('Worker retirement proof exceeded its deadline.');
}
function required(name: string): string {
  const value = process.env[name]; if (!value) throw new Error(`${name} is required for this proof.`); return value;
}
