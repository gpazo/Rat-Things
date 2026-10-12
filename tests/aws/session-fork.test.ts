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
import type { AgentSession } from '../../src/domain/agents-api.js';

const live = process.env.AWS_E2E === 'true' && process.env.AWS_E2E_SESSION_FORK === 'true' ? it : it.skip;
const timeoutMs = Number(process.env.AWS_E2E_TIMEOUT_MS ?? 420_000);
const execute = promisify(execFile);

live('forks three independent sessions from one golden workspace, then resumes and deletes the source', async () => {
  if (required('AWS_E2E_REAL_CODEX') !== 'true' || required('AWS_E2E_ENABLE_MICROVM') !== 'true') throw new Error('Explicit worker and model opt-in required');
  const region = required('AWS_REGION'), account = required('AWS_E2E_CALLER_ACCOUNT'), id = required('AWS_E2E_DEPLOYMENT_ID');
  if (!/^[a-z0-9][a-z0-9-]{2,13}$/.test(id)) throw new Error('Invalid disposable deployment ID');
  expect((await execute('aws', ['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text'])).stdout.trim()).toBe(account);
  const deployment = `rat-things-${id}`;
  expect(required('RUNS_TABLE_NAME')).toBe(`${deployment}-runs`);
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  const s3 = new S3Client({ region }), vms = new LambdaMicrovmsClient({ region });
  const store = new DynamoAgentsStore(db, `${deployment}-agents`, new S3ArtifactStore(s3, required('DEFINITION_BUCKET')));
  const api = createAgentsClient({ baseURL: required('RAT_THINGS_AGENTS_API_URL'), region });
  const sessions: AgentSession[] = [];
  let owner: string | undefined, agentId: string | undefined;
  const runs = async (sessionId: string) => {
    const all: RunRecord[] = []; let cursor: Record<string, unknown> | undefined;
    do {
      const page = await db.send(new ScanCommand({ TableName: `${deployment}-runs`, ConsistentRead: true, FilterExpression: 'agentsSession.sessionId = :s', ExpressionAttributeValues: { ':s': sessionId }, ...(cursor ? { ExclusiveStartKey: cursor } : {}) }));
      all.push(...page.Items as RunRecord[] ?? []); cursor = page.LastEvaluatedKey;
    } while (cursor); return all;
  };
  const runtime = async (session: AgentSession) => (await store.get<StoredSessionRuntime>(owner!, 'session_runtime', session.id))!.value;
  const environment = async (session: AgentSession) => {
    if (session.environment.type !== 'openai_hosted') throw new Error('Hosted environment required');
    return (await store.get<StoredEnvironment>(owner!, 'environments', session.environment.id))!.value;
  };
  const send = async (session: AgentSession, text: string) => {
    const seen = new Set((await api.beta.agents.sessions.turns.list(session.id)).data.map(turn => turn.id));
    await api.beta.agents.sessions.events.create(session.id, { events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text }] }] }] });
    await completed(api, session.id, seen);
    return JSON.stringify((await api.beta.agents.sessions.items.list(session.id, { limit: 100 })).data.filter(item => !seen.has(item.turn_id)));
  };
  try {
    const marker = `memory-${randomUUID()}`, file = `file-${randomUUID()}`;
    agentId = (await api.beta.agents.create({ name: 'Disposable Session fork proof', model: required('AWS_E2E_CODEX_MODEL_ID'), tools: [] })).id;
    const source = await api.beta.agents.sessions.create({ agent_id: agentId, environment: { type: 'openai_hosted', network: { access: 'disabled' },
      files: [{ type: 'inline', path: '/workspace/input.txt', data: Buffer.from('original-input').toString('base64') }],
      setup_commands: [{ command: 'echo setup >> /workspace/setup-count.txt' }] },
      input: `Remember this harmless conversation test marker: ${marker}. Do not put it in files. Using a command, replace /workspace/input.txt with ${file}. Answer READY.` });
    sessions.push(source); await completed(api, source.id);
    const sourceRuns = await runs(source.id); owner = sourceRuns[0]!.ownerId;
    const root = (await runtime(source)).snapshot!.rootThreadId;
    const sourceSandbox = (await environment(source)).sandboxId;
    for (let attempt = 0; attempt < 3; attempt++) {
      const prompt = `Read /workspace/input.txt and /workspace/setup-count.txt using a command. Write child-${attempt} to /workspace/child-${attempt}.txt. Report the input contents, the setup line count, and the harmless conversation test marker from before this fork.`;
      const child = await api.post<AgentSession>(`/agents/sessions/${source.id}/fork`, { body: { metadata: { attempt: String(attempt) },
        ...(attempt === 0 ? {} : { input: prompt }) }, maxRetries: 0 });
      sessions.push(child);
      if (attempt === 0) {
        await eventually(async () => Boolean((await store.get<StoredSessionRuntime>(owner!, 'session_runtime', child.id))?.value.snapshot));
        expect((await api.beta.agents.sessions.turns.list(child.id)).data).toEqual([]);
        expect((await api.beta.agents.sessions.items.list(child.id)).data).toEqual([]);
        const before = await runtime(child);
        const run = (await db.send(new GetCommand({ TableName: `${deployment}-runs`, Key: { runId: before.runId }, ConsistentRead: true }))).Item as RunRecord;
        if (run.execution?.backend !== 'microvm') throw new Error('Expected MicroVM fork');
        const vm = await vms.send(new GetMicrovmCommand({ microvmIdentifier: run.execution.id }));
        expect(vm.executionRoleArn).toBe(`arn:aws:iam::${account}:role/${deployment}-microvm-execution`);
        const token = (await vms.send(new CreateMicrovmAuthTokenCommand({ microvmIdentifier: run.execution.id, expirationInMinutes: 3, allowedPorts: [{ port: 8080 }] }))).authToken?.['X-aws-proxy-auth'];
        if (!token || !vm.endpoint) throw new Error('No private checkpoint endpoint');
        const endpoint = vm.endpoint.startsWith('https://') ? vm.endpoint : `https://${vm.endpoint}`;
        const response = await fetch(`${endpoint}/agent-runtime/v1/runs/${run.runId}/checkpoint`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-aws-proxy-auth': token, 'x-aws-proxy-port': '8080' }, body: '{}', signal: AbortSignal.timeout(125000) });
        expect(response.status, await response.text()).toBe(200);
        await eventually(async () => (await vms.send(new GetMicrovmCommand({ microvmIdentifier: run.execution!.id }))).state === 'TERMINATED');
        await send(child, prompt);
        expect((await runtime(child)).snapshot!.rootThreadId).toBe(before.snapshot!.rootThreadId);
        expect((await api.beta.agents.sessions.turns.list(child.id)).data).toHaveLength(1);
        console.log(JSON.stringify({ phase: 'empty-fork-checkpoint-resume-passed', sessionId: child.id, rootThreadId: before.snapshot!.rootThreadId }));
      } else await completed(api, child.id);
      const state = await runtime(child), env = await environment(child);
      expect(state.snapshot!.rootThreadId).not.toBe(root);
      expect(env.sandboxId).not.toBe(sourceSandbox); expect(env.resetCount ?? 0).toBe(0);
      const items = JSON.stringify((await api.beta.agents.sessions.items.list(child.id, { limit: 100 })).data);
      expect(items).toContain(marker); expect(items).toContain(file);
      if (child.environment.type !== 'openai_hosted') throw new Error('Expected managed child');
      const files = (await api.beta.agents.environments.files.list(child.environment.id, { path: '/workspace' })).data;
      expect(files.find(entry => entry.path === '/workspace/setup-count.txt')?.size_bytes).toBe(6);
      expect(files.some(entry => entry.path === `/workspace/child-${attempt}.txt`)).toBe(true);
      for (let earlier = 0; earlier < attempt; earlier++) expect(files.some(entry => entry.path === `/workspace/child-${earlier}.txt`)).toBe(false);
      expect(await api.get(`/agents/sessions/${child.id}/lineage`)).toMatchObject({ forked_from: { session_id: source.id } });
      expect((await runs(source.id)).map(run => run.runId).sort()).toEqual(sourceRuns.map(run => run.runId).sort());
      console.log(JSON.stringify({ phase: 'fork-passed', attempt, sourceSessionId: source.id, sessionId: child.id, rootThreadId: state.snapshot!.rootThreadId, sandboxId: env.sandboxId, resetCount: env.resetCount ?? 0 }));
    }
    const resumed = await send(source, 'Read /workspace/input.txt and report its complete contents in your answer. Write source-only to /workspace/source-only.txt. Also report the harmless conversation test marker.');
    expect(resumed).toContain(marker); expect(resumed).toContain(file);
    expect((await runtime(source)).snapshot!.rootThreadId).toBe(root);
    expect((await environment(source)).sandboxId).toBe(sourceSandbox);
    if (source.environment.type !== 'openai_hosted') throw new Error('Expected managed source');
    const sourceFiles = (await api.beta.agents.environments.files.list(source.environment.id, { path: '/workspace' })).data;
    expect(sourceFiles.some(entry => /child-\d/.test(entry.path))).toBe(false);
    expect(sourceFiles.find(entry => entry.path === '/workspace/setup-count.txt')?.size_bytes).toBe(6);
    for (const branch of sessions.slice(1)) {
      if (branch.environment.type !== 'openai_hosted') throw new Error('Expected managed branch');
      const files = (await api.beta.agents.environments.files.list(branch.environment.id, { path: '/workspace' })).data;
      expect(files.some(entry => entry.path === '/workspace/source-only.txt')).toBe(false);
    }
    await api.beta.agents.sessions.delete(source.id);
    // Force ordinary replacement on one child after source deletion. Its private recovery
    // history must still supply the pre-fork context if native history is unavailable.
    const child = sessions[1]!;
    const childRunId = (await runtime(child)).runId;
    const childRun = (await db.send(new GetCommand({ TableName: `${deployment}-runs`, Key: { runId: childRunId }, ConsistentRead: true }))).Item as RunRecord;
    if (childRun.execution?.backend !== 'microvm') throw new Error('Expected MicroVM child');
    const vm = await vms.send(new GetMicrovmCommand({ microvmIdentifier: childRun.execution.id }));
    expect(vm.executionRoleArn).toBe(`arn:aws:iam::${account}:role/${deployment}-microvm-execution`);
    await vms.send(new TerminateMicrovmCommand({ microvmIdentifier: childRun.execution.id }));
    await eventually(async () => (await vms.send(new GetMicrovmCommand({ microvmIdentifier: childRun.execution!.id }))).state === 'TERMINATED');
    await eventually(async () => {
      await execute('aws', ['lambda', 'invoke', '--region', region, '--function-name', `${deployment}-reconciler`, '--payload', '{}', '--cli-binary-format', 'raw-in-base64-out', '/dev/null']);
      return ['failed', 'succeeded', 'cancelled'].includes(((await db.send(new GetCommand({ TableName: `${deployment}-runs`, Key: { runId: childRunId }, ConsistentRead: true }))).Item as RunRecord).status);
    });
    const recovered = await send(child, 'Report the harmless conversation test marker from before this fork.');
    expect(recovered).toContain(marker);
    console.log(JSON.stringify({ phase: 'source-resume-and-independent-child-replacement-passed', sourceSessionId: source.id, childSessionId: child.id }));
  } finally {
    for (const session of [...sessions].reverse()) {
      await api.beta.agents.sessions.delete(session.id).catch(() => {});
      for (const run of await runs(session.id)) {
        if (run.execution?.backend !== 'microvm' || !run.execution.generation) continue;
        const vm = await vms.send(new GetMicrovmCommand({ microvmIdentifier: run.execution.id }));
        expect(vm.executionRoleArn).toBe(`arn:aws:iam::${account}:role/${deployment}-microvm-execution`);
        if (!['TERMINATED', 'TERMINATING'].includes(vm.state ?? '')) await vms.send(new TerminateMicrovmCommand({ microvmIdentifier: run.execution.id }));
      }
    }
    if (agentId) await api.beta.agents.delete(agentId);
    db.destroy(); s3.destroy(); vms.destroy();
  }
}, timeoutMs * 6);
async function completed(api: ReturnType<typeof createAgentsClient>, id: string, seen = new Set<string>()) {
  await eventually(async () => {
    for await (const turn of api.beta.agents.sessions.turns.list(id)) {
      if (seen.has(turn.id) || turn.subagent_id !== null) continue;
      if (turn.status === 'failed' || turn.status === 'cancelled') throw new Error(`Fork Turn failed: ${JSON.stringify(turn.error)}`);
      if (turn.status === 'completed') return true;
    } return false;
  });
}
async function eventually(check: () => Promise<boolean>) { const until = Date.now() + timeoutMs; do { if (await check()) return; await delay(2000); } while (Date.now() < until); throw new Error('Fork proof exceeded deadline'); }
function required(name: string) { const value = process.env[name]; if (!value) throw new Error(`${name} required`); return value; }
