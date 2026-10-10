import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DynamoDBClient, DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { EC2Client, DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import { expect, it } from 'vitest';
import { createAgentsClient } from '../../src/agents-client.js';
import type { RunRecord } from '../../src/domain/contracts.js';

const live = process.env.AWS_E2E === 'true' && process.env.AWS_E2E_BACKEND_PLACEMENT === 'true' ? it : it.skip;
const timeoutMs = Number(process.env.AWS_E2E_TIMEOUT_MS ?? 420_000);

live.each(['microvm', 'ec2'] as const)('executes %s placement while both backends are available', async backend => {
  if (process.env.AWS_E2E_ENABLE_EC2_WORKER !== 'true' || process.env.AWS_E2E_ENABLE_MICROVM !== 'true') throw new Error('Placement proof requires both backends.');
  const region = required('AWS_REGION');
  const deployment = `rat-things-${required('AWS_E2E_DEPLOYMENT_ID')}`;
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  const table = required('RUNS_TABLE_NAME');
  expect((await db.send(new DescribeTableCommand({ TableName: table }))).Table?.TableArn?.split(':')[4]).toBe(required('AWS_E2E_CALLER_ACCOUNT'));
  const client = createAgentsClient({ baseURL: required('RAT_THINGS_AGENTS_API_URL'), region });
  const agent = backend === 'ec2' ? await client.beta.agents.retrieve(required('AWS_E2E_LONG_RUNNING_AGENT_ID'))
    : await client.beta.agents.create({ model: required('AWS_E2E_CODEX_MODEL_ID'), tools: [] });
  let sessionId: string | undefined;
  const runFor = async (id: string) => {
    let cursor: Record<string, unknown> | undefined;
    do {
      const page = await db.send(new ScanCommand({ TableName: table, ConsistentRead: true, ExclusiveStartKey: cursor,
        FilterExpression: 'agentsSession.sessionId = :session', ExpressionAttributeValues: { ':session': id } }));
      const run = page.Items?.find(value => value.status === 'running' && value.execution) as RunRecord | undefined;
      if (run) return run;
      cursor = page.LastEvaluatedKey;
    } while (cursor);
    throw new Error('No active execution for completed placement proof');
  };
  try {
    const marker = randomUUID();
    const session = await client.beta.agents.sessions.create({ agent_id: agent.id, environment: { type: 'none' }, input: `Reply exactly ${marker}.` });
    sessionId = session.id;
    const complete = async (count: number) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const turns = (await client.beta.agents.sessions.turns.list(session.id)).data.filter(turn => turn.subagent_id === null);
        expect(turns.some(turn => turn.status === 'failed' || turn.status === 'cancelled')).toBe(false);
        if (turns.filter(turn => turn.status === 'completed').length >= count) return;
        await delay(2000);
      }
      throw new Error(`Placement ${backend} did not complete ${count} Turns`);
    };
    await complete(1);
    const run = await runFor(session.id);
    expect(run.execution?.backend).toBe(backend);
    expect(JSON.stringify((await client.beta.agents.sessions.items.list(session.id)).data)).toContain(marker);
    if (backend === 'ec2') {
      const instance = (await new EC2Client({ region }).send(new DescribeInstancesCommand({ InstanceIds: [run.execution!.id] }))).Reservations?.[0]?.Instances?.[0];
      expect(instance?.ImageId).toBe(required('AWS_E2E_EC2_WORKER_AMI_ID'));
      expect(Object.fromEntries((instance?.Tags ?? []).map(tag => [tag.Key, tag.Value]))).toMatchObject({ RatDeployment: deployment, RatRunId: run.runId, RatGeneration: run.execution!.generation });
    }
    await client.beta.agents.sessions.update(session.id, { metadata: { backend: backend === 'ec2' ? 'microvm' : 'ec2' } });
    await client.beta.agents.sessions.events.create(session.id, { events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: 'Reply CONTINUED.' }] }] }] });
    await complete(2);
    expect((await runFor(session.id)).execution).toEqual(run.execution);
    console.log(JSON.stringify({ phase: 'placement_verified', backend, sessionId, runId: run.runId, execution: run.execution }));
  } finally {
    try { if (sessionId) await client.beta.agents.sessions.delete(sessionId); }
    finally { if (backend === 'microvm') await client.beta.agents.delete(agent.id); }
  }
}, timeoutMs * 2 + 60_000);

function required(name: string): string { const value = process.env[name]; if (!value) throw new Error(`${name} is required for the placement proof.`); return value; }
