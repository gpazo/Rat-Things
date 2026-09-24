import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DynamoDBClient, DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { EC2Client, DescribeInstancesCommand, TerminateInstancesCommand } from '@aws-sdk/client-ec2';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { expect, it } from 'vitest';
import { createAgentsClient } from '../../src/agents-client.js';
import { deploymentWorkers } from '../../scripts/terminate-ec2-workers.mjs';
import type { Turn } from '../../src/domain/agents-api.js';

const live = process.env.AWS_E2E === 'true' ? it : it.skip;
const recovery = process.env.AWS_E2E === 'true' && process.env.AWS_E2E_WORKER_RECOVERY === 'true' ? it : it.skip;
const timeoutMs = Number(process.env.AWS_E2E_TIMEOUT_MS ?? 420_000);
type Client = ReturnType<typeof createAgentsClient>;

live('cancels a waiting native Turn, reconnects SSE and admits a follow-up', async () => {
  const client = liveClient();
  const marker = `lifecycle-${randomUUID()}`;
  const agent = await client.beta.agents.create({ model: required('AWS_E2E_CODEX_MODEL_ID'),
    instructions: 'Follow each request exactly. Call hold_for_test only when asked to call it.',
    tools: [{ type: 'function', name: 'hold_for_test', description: 'Wait for a result supplied by the test client.',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } }] });
  let sessionId: string | undefined;
  let stream: Awaited<ReturnType<typeof subscribe>> | undefined;
  try {
    const session = await client.beta.agents.sessions.create({ agent_id: agent.id, environment: { type: 'none' }, input: 'Call hold_for_test now.' });
    sessionId = session.id;
    console.log(`Lifecycle Session ${session.id}`);
    await eventually(async () => (await client.beta.agents.sessions.retrieve(session.id)).required_actions.some(action => action.type === 'function_call'));
    const first = (await client.beta.agents.sessions.turns.list(session.id)).data.find(turn => turn.subagent_id === null)!;
    expect(first.status).toBe('waiting');
    stream = await subscribe(client, session.id);
    await client.beta.agents.sessions.events.create(session.id, { events: [{ type: 'agent.session.input.cancel' }] });
    await eventually(async () => (await client.beta.agents.sessions.turns.retrieve(first.id, { session_id: session.id })).status === 'cancelled');
    await eventually(async () => stream!.terminals.has(first.id));
    await stream.close();
    // Subscribe before reading saved state: live events do not replay history.
    stream = await subscribe(client, session.id);
    expect((await client.beta.agents.sessions.turns.retrieve(first.id, { session_id: session.id })).status).toBe('cancelled');
    await input(client, session.id, `Return exactly ${marker}. Do not call any tools.`);
    const next = await completed(client, session.id, new Set([first.id]));
    await eventually(async () => stream!.terminals.has(next.id));
    expect(stream.terminals.get(next.id)).toBe('completed');
    expect(stream.terminals.has(first.id)).toBe(false);
    expect(JSON.stringify((await client.beta.agents.sessions.items.list(session.id, { order: 'asc', limit: 100 })).data)).toContain(marker);
    expect((await client.beta.agents.sessions.retrieve(session.id)).required_actions).toEqual([]);
    await stream.close(); stream = undefined;
    await client.beta.agents.sessions.delete(session.id);
    await expect(client.beta.agents.sessions.retrieve(session.id)).rejects.toMatchObject({ status: 404 });
    sessionId = undefined;
  } finally {
    try { await stream?.close(); }
    finally {
      try { if (sessionId) await client.beta.agents.sessions.delete(sessionId); }
      finally { await client.beta.agents.delete(agent.id); }
    }
  }
}, timeoutMs * 3);

recovery.each(['none', 'openai_hosted'] as const)('handles %s worker loss while retaining conversation and resetting hosted workspace state', async (environmentType) => {
  if (process.env.AWS_E2E_ENABLE_EC2_WORKER !== 'true') throw new Error('Worker recovery requires the dedicated EC2 backend.');
  const client = liveClient();
  const region = required('AWS_REGION');
  const deployment = `rat-things-${required('AWS_E2E_DEPLOYMENT_ID')}`;
  const ec2 = new EC2Client({ region });
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  const s3 = new S3Client({ region });
  expect((await db.send(new DescribeTableCommand({ TableName: `${deployment}-agents` }))).Table?.TableArn?.split(':')[4]).toBe(required('AWS_E2E_CALLER_ACCOUNT'));
  const marker = `recovery-${randomUUID()}`;
  const agent = await client.beta.agents.create({ model: required('AWS_E2E_CODEX_MODEL_ID'), tools: [], instructions: 'Follow each request exactly. Never recreate missing proof files or invent their contents.' });
  let sessionId: string | undefined;
  let stream: Awaited<ReturnType<typeof subscribe>> | undefined;
  const currentRun = async (id: string) => {
    let cursor: Record<string, unknown> | undefined;
    let row: Record<string, any> | undefined;
    do {
      const rows = await db.send(new ScanCommand({ TableName: `${deployment}-agents`, ConsistentRead: true, ExclusiveStartKey: cursor,
        FilterExpression: 'id = :id AND #c = :collection AND #k = :root',
        ExpressionAttributeNames: { '#c': 'collection', '#k': 'key' },
        ExpressionAttributeValues: { ':id': id, ':collection': 'session_runtime', ':root': 'root' } }));
      row = rows.Items?.[0]; cursor = rows.LastEvaluatedKey;
    } while (!row && cursor);
    if (!row) return undefined;
    const object = await s3.send(new GetObjectCommand({ Bucket: row.reference.bucket, Key: row.reference.key }));
    const runtime = JSON.parse(await object.Body!.transformToString()) as { runId: string | null };
    return runtime.runId ? (await db.send(new GetCommand({ TableName: `${deployment}-runs`, Key: { runId: runtime.runId }, ConsistentRead: true }))).Item : undefined;
  };
  try {
    const hosted = environmentType === 'openai_hosted';
    const session = await client.beta.agents.sessions.create({ agent_id: agent.id,
      environment: hosted ? { type: 'openai_hosted', network: { access: 'enabled' } } : { type: 'none' },
      input: hosted ? `Remember this context marker: ${marker}. Use Python to write exactly that marker to /workspace/outputs/recovery-proof.txt, then read it back and return it.`
        : `Remember this context marker: ${marker}. Return it exactly.` });
    sessionId = session.id;
    console.log(`Recovery Session ${session.id}`);
    const first = await completed(client, session.id, new Set());
    const original = await currentRun(session.id);
    expect(original?.execution?.backend).toBe('ec2');
    const instanceId = original!.execution.id as string;
    const instance = (await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }))).Reservations?.[0]?.Instances?.[0];
    const tags = Object.fromEntries((instance?.Tags ?? []).map(tag => [tag.Key, tag.Value]));
    expect(tags.RatDeployment).toBe(deployment);
    expect(tags.RatRunId).toBe(original!.runId);
    expect(tags.RatGeneration).toBe(original!.execution.generation);
    expect(tags['aws:ec2launchtemplate:id']).toBe(required('AWS_E2E_RECOVERY_LAUNCH_TEMPLATE_ID'));
    expect(instance?.State?.Name).toBe('running');
    expect(deploymentWorkers([instance!], deployment, required('AWS_E2E_RECOVERY_LAUNCH_TEMPLATE_ID')).map((value: { InstanceId: string }) => value.InstanceId)).toEqual([instanceId]);
    // The opt-in failure injection is limited to the exact worker created above.
    await ec2.send(new TerminateInstancesCommand({ InstanceIds: [instanceId] }));
    console.log(`Terminated this fixture's worker ${instanceId}; waiting for reconciliation`);
    await eventually(async () => ['failed', 'cancelled', 'succeeded'].includes((await currentRun(session.id))?.status ?? ''));
    stream = await subscribe(client, session.id);
    expect((await client.beta.agents.sessions.turns.retrieve(first.id, { session_id: session.id })).status).toBe('completed');
    expect(JSON.stringify((await client.beta.agents.sessions.items.list(session.id, { order: 'asc', limit: 100 })).data)).toContain(marker);
    if (hosted) {
      expect((await client.beta.agents.sessions.retrieve(session.id)).status).toBe('idle');
      const artifact = (await client.beta.agents.sessions.artifacts.list(session.id)).data.find(value => value.path === '/workspace/outputs/recovery-proof.txt');
      expect(artifact).toBeDefined();
      expect(await (await client.beta.agents.sessions.artifacts.content(artifact!.id, { session_id: session.id })).text()).toBe(marker);
    }
    await input(client, session.id, hosted
      ? 'Use Python to print WORKSPACE_RESET if /workspace/outputs/recovery-proof.txt is absent, otherwise print STALE_WORKSPACE. Do not create the file. Then return the context marker from our previous Turn. Do not invent a new marker.'
      : 'Return exactly the context marker from our previous Turn. Do not invent a new marker.');
    const second = await completed(client, session.id, new Set([first.id]));
    await eventually(async () => stream!.terminals.has(second.id));
    const replacement = await currentRun(session.id);
    expect(replacement?.execution?.backend).toBe('ec2');
    expect(replacement?.execution?.id).not.toBe(instanceId);
    expect(replacement?.runId).not.toBe(original!.runId);
    const items = (await client.beta.agents.sessions.items.list(session.id, { order: 'asc', limit: 100 })).data.filter(item => item.turn_id === second.id);
    expect(items).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'message', role: 'assistant', status: 'completed' })]));
    expect(JSON.stringify(items)).toContain(marker);
    if (hosted && session.environment.type === 'openai_hosted') {
      await eventually(async () => stream!.resets.get(session.environment.type === 'openai_hosted' ? session.environment.id : '') === 1);
      expect((await client.beta.agents.sessions.retrieve(session.id)).environment).toMatchObject({ id: session.environment.id });
      const output = items.flatMap(item => item.type === 'command_execution' ? [item.output ?? ''] : []).join('\n');
      expect(output).toContain('WORKSPACE_RESET');
      expect(output).not.toContain('STALE_WORKSPACE');
      expect((await client.beta.agents.environments.files.list(session.environment.id, { path: '/workspace/outputs' })).data.some(file => file.path === '/workspace/outputs/recovery-proof.txt')).toBe(false);
    }
    console.log(`Replacement worker ${replacement!.execution.id} completed ${second.id}`);
  } finally {
    try { await stream?.close(); }
    finally {
      try {
        try { if (sessionId) await client.beta.agents.sessions.delete(sessionId); }
        finally { await client.beta.agents.delete(agent.id); }
      } finally { ec2.destroy(); db.destroy(); s3.destroy(); }
    }
  }
}, timeoutMs * 4);

function liveClient(): Client {
  if (process.env.AWS_E2E_REAL_CODEX !== 'true') throw new Error('Set AWS_E2E_REAL_CODEX=true for live model calls.');
  return createAgentsClient({ baseURL: required('RAT_THINGS_AGENTS_API_URL'), region: required('AWS_REGION') }).withOptions({ maxRetries: 0, timeout: 360_000 });
}
async function input(client: Client, id: string, text: string) {
  await client.beta.agents.sessions.events.create(id, { events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text }] }] }] });
}
async function completed(client: Client, id: string, seen: Set<string>): Promise<Turn> {
  let result: Turn | undefined;
  await eventually(async () => {
    const turns = (await client.beta.agents.sessions.turns.list(id, { order: 'asc', limit: 100 })).data;
    result = turns.find(turn => turn.subagent_id === null && !seen.has(turn.id));
    if (result && ['failed', 'cancelled'].includes(result.status)) throw new Error(`Turn ${result.id} ended ${result.status}: ${result.error?.code}`);
    return result?.status === 'completed';
  });
  return result!;
}
async function subscribe(client: Client, id: string) {
  const abort = new AbortController();
  const events = await client.beta.agents.sessions.events.stream(id, { signal: abort.signal });
  const terminals = new Map<string, string>();
  const resets = new Map<string, number>();
  let failure: unknown;
  const consume = (async () => {
    try { for await (const event of events) {
      if (event.type === 'agent.session.turn.completed' || event.type === 'agent.session.turn.failed' || event.type === 'agent.session.turn.cancelled') terminals.set(event.turn.id, event.turn.status);
      if (event.type === 'agent.session.environment.reset') resets.set(event.environment_id, event.reset_count);
    } }
    catch (error) { if (!abort.signal.aborted) failure = error; }
  })();
  return { terminals, resets, close: async () => { abort.abort(); await consume; if (failure) throw failure; } };
}
async function eventually(condition: () => Promise<boolean>) {
  const deadline = Date.now() + timeoutMs;
  do { if (await condition()) return; await delay(2000); } while (Date.now() < deadline);
  throw new Error('Live condition did not become true before its deadline.');
}
function required(name: string): string {
  const value = process.env[name]; if (!value) throw new Error(`${name} is required for live validation.`); return value;
}
