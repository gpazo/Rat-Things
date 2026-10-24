import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import OpenAI from 'openai';
import { createAgentsClient, createAgentsFetch } from '../../src/agents-client.js';
import { createLocalServices, LOCAL_OWNER } from '../../src/app/local-composition.js';
import { LocalTransferService, type TransferPlan } from '../../src/app/local-transfer.js';
import { SqliteAgentsStore } from '../../src/adapters/sqlite-agents-store.js';
import type { AgentSession, AgentSessionItem, Turn } from '../../src/domain/agents-api.js';
import { NativeProofRuntime } from './native-vm/worker/runtime.js';

if (process.env.RAT_LIVE_CLOUD !== '1') throw new Error('Set RAT_LIVE_CLOUD=1 for real AWS transfer and inference');
const { values } = parseArgs({ options: Object.fromEntries(['directory', 'evidence', 'endpoint', 'region', 'model'].map(name => [name, { type: 'string' as const }])) });
for (const name of ['directory', 'evidence', 'endpoint', 'region', 'model']) assert(values[name], `Choose --${name}`);
const directory = resolve(values.directory!);
const local = JSON.parse(await readFile(values.evidence!, 'utf8')) as { sessionId: string; model: string; local: { proofSha256: string } };
let runtime = new NativeProofRuntime(directory);
let services = createLocalServices({ directory, runtime, maxSessions: 1 });
let store = new SqliteAgentsStore(directory);
let loseAcknowledgement = true;
let uploads = 0;
const imported: string[] = [];
const client = (options: Parameters<typeof createAgentsClient>[0]) => {
  const transport = createAgentsFetch(options);
  return new OpenAI({ apiKey: 'aws-sigv4', baseURL: options.baseURL, maxRetries: 0, fetch: async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    const response = await transport(request);
    if (request.method === 'POST' && path.endsWith('/files') && response.ok) uploads++;
    if (request.method === 'POST' && path.endsWith('/agents/sessions/import') && response.ok) {
      imported.push((await response.clone().json() as AgentSession).id);
      if (loseAcknowledgement) { loseAcknowledgement = false; throw new Error('Injected response loss after actual cloud import'); }
    }
    return response;
  } });
};
const transfers = () => new LocalTransferService({ store, sessions: services.sessions, environments: services.environments,
  owner: LOCAL_OWNER, snapshot: id => runtime.snapshot(id), client });
let transfer = transfers();
const destination = { baseURL: values.endpoint!, region: values.region! };
const api = createAgentsClient(destination).withOptions({ maxRetries: 0, timeout: 360_000 });
const token = randomUUID();
async function transferStatus(id: string, expected: TransferPlan['status']) {
  const deadline = Date.now() + 360_000;
  while (Date.now() < deadline) {
    const plan = await transfer.retrieve(id);
    if (plan.status === expected) return plan;
    if (plan.status === 'failed') throw new Error(plan.error ?? 'Transfer failed');
    await delay(300);
  }
  throw new Error(`Transfer did not reach ${expected}`);
}
try {
  const original = await services.sessions.retrieve(LOCAL_OWNER, local.sessionId);
  const plan = await transfer.create({ session_id: original.id, endpoint: destination.baseURL, region: destination.region, model: values.model });
  await transferStatus(plan.id, 'ready');
  assert.equal(uploads, 0);
  console.log('Real destination preflight and local snapshot passed');
  await transfer.execute(plan.id);
  await transferStatus(plan.id, 'failed');
  assert.equal(imported.length, 1, 'Failure must follow an actual successful import');
  const uploadedBeforeRetry = uploads;
  await transfer.close();
  store.close();
  await services.close();
  runtime = new NativeProofRuntime(directory);
  services = createLocalServices({ directory, runtime, maxSessions: 1 });
  store = new SqliteAgentsStore(directory);
  transfer = transfers();
  await transfer.execute(plan.id);
  const copied = await transferStatus(plan.id, 'complete');
  assert.equal(uploads, uploadedBeforeRetry, 'Retry reuploaded saved parts');
  assert.deepEqual(imported, [copied.destination_session_id, copied.destination_session_id]);
  assert.equal((await services.sessions.retrieve(LOCAL_OWNER, original.id)).agent.model, local.model);
  const cloud = await api.beta.agents.sessions.retrieve(copied.destination_session_id!);
  assert.equal(cloud.agent.model, values.model);
  assert.equal(cloud.environment.type, 'openai_hosted');
  const before = await api.beta.agents.sessions.turns.list(cloud.id);
  assert.equal(before.data.length, 0, 'Import must remain idle until a new message');
  const history = await api.beta.agents.sessions.items.list(cloud.id, { limit: 100 });
  assert(history.data.length > 0, 'Imported history is missing');
  console.log('Cloud import recovered from lost response after local service restart');
  const program = `const fs=require('node:fs'),crypto=require('node:crypto'),assert=require('node:assert/strict');const proof=fs.readFileSync('/workspace/live-proof.json');assert.equal(crypto.createHash('sha256').update(proof).digest('hex'),${JSON.stringify(local.local.proofSha256)});assert.equal(fs.readFileSync('/workspace/setup-count','utf8'),'once');assert.equal(JSON.parse(fs.readFileSync('/workspace/live-resumed.json','utf8')).originalSha256,${JSON.stringify(local.local.proofSha256)});fs.writeFileSync('/workspace/cloud-proof.txt',${JSON.stringify(token)});console.log(${JSON.stringify(`RAT_CLOUD_${token}`)})`;
  const command = `node -e '${program.replaceAll("'", "'\\''")}'`;
  await api.beta.agents.sessions.events.create(cloud.id, { events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: `Run this exact command using the environment command tool. Do not edit the existing files or manufacture its output. Report its result.\n${command}` }] }] }] });
  const deadline = Date.now() + 600_000;
  let turn: Turn | undefined;
  while (Date.now() < deadline) {
    turn = (await api.beta.agents.sessions.turns.list(cloud.id)).data[0];
    if (turn?.status === 'completed') break;
    if (turn && ['failed', 'cancelled'].includes(turn.status)) throw new Error(`Cloud Turn ${turn.status}: ${turn.error?.code}`);
    await delay(1000);
  }
  assert.equal(turn?.status, 'completed');
  const items = (await api.beta.agents.sessions.items.list(cloud.id, { limit: 100 })).data as AgentSessionItem[];
  const executed = items.find(item => item.type === 'command_execution' && item.turn_id === turn!.id && item.exit_code === 0
    && item.output?.split(/\r?\n/).includes(`RAT_CLOUD_${token}`));
  assert(executed, 'Cloud command output did not independently verify transferred bytes');
  assert(cloud.environment.type === 'openai_hosted');
  const files = await api.beta.agents.environments.files.list(cloud.environment.id, { path: '/workspace', limit: 100 });
  assert.equal(files.data.find(file => file.path === '/workspace/cloud-proof.txt')?.size_bytes, token.length);
  assert.equal(files.data.find(file => file.path === '/workspace/setup-count')?.size_bytes, 4);
  const evidence = join(directory, `cloud-acceptance-${token}.json`);
  await writeFile(evidence, JSON.stringify({ sourceSessionId: original.id, transferId: plan.id, cloudSessionId: cloud.id,
    sourceModel: local.model, destinationModel: values.model, cloudTurnId: turn!.id, commandId: executed.id,
    uploads, importRequests: imported.length, interruptedAfter: 'actual import before local acknowledgement',
    assertions: ['real IAM destination', 'real workspace upload', 'durable retry after process reopening', 'same destination Session on retry',
      'no duplicate uploads', 'source model retained', 'destination model selected', 'idle import', 'history copied',
      'new real cloud Turn', 'transferred file hash verified by command', 'setup once', 'cloud file created'] }, null, 2), { mode: 0o600 });
  console.log(`Live cloud acceptance passed. Evidence: ${evidence}`);
} finally { await transfer.close(); store.close(); await services.close(); }
