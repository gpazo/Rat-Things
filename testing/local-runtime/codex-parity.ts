import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { createModels, fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai';
import { validateCodexRuntimeArtifact } from '../../scripts/codex-runtime-artifact.mjs';
import { startLocalServer } from '../../src/local-server.js';
import { createLocalAgentsClient, readLocalConnection } from '../../src/local-workspace.js';
import { LocalSessionExecution } from '../../src/runner/local-session-execution.js';
import type { AgentSession, Turn } from '../../src/domain/agents-api.js';
import type { PiModelDescriptor } from '../../src/domain/session-runtime.js';
import { hashFile } from './linux-kvm/prepare.js';
import { sandboxRefusalVariant } from './linux-kvm/sandbox-refusal.js';

const { values } = parseArgs({ options: { directory: { type: 'string' }, 'timeout-seconds': { type: 'string', default: '300' }, help: { type: 'boolean' } } });
if (values.help) {
  console.log('Usage: CODEX_BINARY=/absolute/patched/codex RAT_THINGS_LINUX_KVM_RUNTIME=/absolute/assets npx tsx testing/local-runtime/codex-parity.ts [--directory EVIDENCE_ROOT] [--timeout-seconds 300]\nReal KVM worker and patched host Codex with a local Responses fixture; includes broken-sandbox refusal for Codex and Pi. No live inference.');
  process.exit(0);
}
const timeoutMs = Number(values['timeout-seconds']) * 1000;
assert(Number.isSafeInteger(timeoutMs) && timeoutMs >= 10000 && timeoutMs <= 1800000);
const evidenceRoot = resolve(values.directory ?? 'test-results/local-codex-parity');
await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
const directory = await mkdtemp(join(evidenceRoot, 'run-'));
const normalProfile = join(directory, 'profile');
const nonce = randomUUID(), sentinel = `synthetic-host-secret-${randomUUID()}`;
await writeFile(join(directory, 'host-only.txt'), sentinel, { mode: 0o600 });
const previousSecret = process.env.RAT_CODEX_PARITY_SECRET;
process.env.RAT_CODEX_PARITY_SECRET = sentinel;
const sourceAssets = process.env.RAT_THINGS_LINUX_KVM_RUNTIME;
const binary = process.env.CODEX_BINARY;
const knownTokens: string[] = [];
const runtimeObservations: unknown[] = [];
const turns: { phase: string; id: string; status: string; commands: number }[] = [];
const proofs: { phase: string; outputSha256: string; proof: unknown }[] = [];
const refusals: { driver: string; modelCalls: number; serialLogs: string[]; turnStatus?: string }[] = [];
const cleanupErrors: string[] = [];
const requests: { phase: string; input: unknown }[] = [];
let phase = 'preflight', failure: unknown, completed = false;
let server: Awaited<ReturnType<typeof startLocalServer>> | undefined;
let client: ReturnType<typeof createLocalAgentsClient> | undefined;
let session: AgentSession | undefined;
let activeProfile = normalProfile;
let queued: { id: string; program: string } | undefined;
let cancellation = false;
let fixtureFailure: unknown;
let restartCalls: { before: number; after: number } | undefined;
const outputs = new Map<string, string>();
const modelId = 'gpt-5.4';
const piModelId = 'sandbox-refusal-pi-fixture';
const faux = fauxProvider({ provider: 'openai-codex', api: 'openai-codex-responses', tokensPerSecond: Infinity,
  models: [{ id: piModelId, reasoning: true, input: ['text'], contextWindow: 100000, maxTokens: 10000 }] });
faux.setResponses([fauxAssistantMessage('Unexpected inference: sandbox startup should have refused this Session.')]);
const piModels = createModels(); piModels.setProvider(faux.provider);
const piCatalog: PiModelDescriptor[] = [{ id: piModelId, name: 'Sandbox refusal fixture', provider: 'openai-codex', api: 'openai-codex-responses',
  input: ['text'], contextWindow: 100000, maxTokens: 10000, reasoning: ['low', 'medium', 'high'] }];
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const model = createServer(async (request, response) => {
  try {
    assert(request.url?.endsWith('/responses'), 'Unexpected fixture endpoint');
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of request) { size += chunk.length; assert(size <= 8 * 1024 ** 2, 'Fixture request exceeds its limit'); chunks.push(Buffer.from(chunk)); }
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { input: unknown };
    requests.push({ phase, input: body.input });
    for (const item of Array.isArray(body.input) ? body.input as { type?: string; call_id?: string; output?: unknown }[] : []) {
      if (item.type === 'function_call_output' && typeof item.call_id === 'string' && typeof item.output === 'string') outputs.set(item.call_id, item.output);
    }
    const next = queued; queued = undefined;
    const running = [...outputs.values()].reverse().map(text => /(?:Process running with session ID|session ID)\s+(\d+)/i.exec(text)?.[1]).find(Boolean);
    const item = next ? { type: 'function_call', name: 'exec_command', id: next.id, call_id: next.id,
      arguments: JSON.stringify({ cmd: `node --no-warnings -e ${quote(next.program)}`, yield_time_ms: 10000, max_output_tokens: 4000 }) }
      : cancellation && running ? { type: 'function_call', name: 'write_stdin', id: `wait-${requests.length}`, call_id: `wait-${requests.length}`,
        arguments: JSON.stringify({ session_id: Number(running), chars: '', yield_time_ms: 1000, max_output_tokens: 1000 }) }
      : { type: 'message', id: `reply-${requests.length}`, role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Deterministic fixture sequence complete.' }] };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end([{ type: 'response.created', response: { id: `response-${requests.length}` } }, { type: 'response.output_item.done', item },
      { type: 'response.completed', response: { id: `response-${requests.length}` } }].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
  } catch (error) { fixtureFailure = error; response.writeHead(500).end('Fixture failed'); }
});
model.listen(0, '127.0.0.1'); await once(model, 'listening');
const address = model.address(); assert(address && typeof address !== 'string');
const fixtureURL = `http://127.0.0.1:${address.port}`;

async function poll<T>(label: string, read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (fixtureFailure) throw fixtureFailure; const result = await read(); if (result !== undefined) return result; await delay(250); }
  throw new Error(`${label} timed out after ${timeoutMs} ms`);
}
async function launch(profile: string) {
  assert(binary); activeProfile = profile; await mkdir(profile, { recursive: true, mode: 0o700 });
  server = await startLocalServer({ directory: profile, model: modelId, maxSessions: 1, pi: { catalog: piCatalog, models: () => piModels },
    execution: (store, managed) => new LocalSessionExecution({ store, managed, directory: profile, maxSessions: 1,
      environment: { PATH: process.env.PATH, CODEX_BINARY: binary },
      request: request => ({ ...request, modelProvider: 'fixture', sessionConfig: { ...request.sessionConfig,
        'model_providers.fixture': { name: 'Deterministic real-worker acceptance fixture', base_url: fixtureURL, wire_api: 'responses', requires_openai_auth: false, supports_websockets: false } } }),
    }),
  });
  knownTokens.push(server.token);
  client = createLocalAgentsClient(await readLocalConnection(profile)).withOptions({ maxRetries: 0, timeout: timeoutMs });
  const response = await fetch(`${server.baseURL}/workspace/runtime`, { headers: { authorization: `Bearer ${server.token}` }, signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200); const status = await response.json(); runtimeObservations.push({ phase, status });
  assert.equal(status.ready, true, 'Real KVM runtime is unavailable'); assert.equal(status.platform, 'linux/amd64');
  assert.match(status.image, /^linux-kvm-development:/);
}
async function files() { assert(client && session?.environment.type === 'openai_hosted'); return (await client.beta.agents.environments.files.list(session.environment.id, { path: '/workspace', limit: 100 })).data; }
async function terminal(excluded: string[], expected: Turn['status']) {
  assert(client && session); const current = client, id = session.id;
  const turn = await poll(`${phase} Turn`, async () => {
    const found = (await current.beta.agents.sessions.turns.list(id, { limit: 100 })).data.find(turn => !excluded.includes(turn.id));
    return found && ['completed', 'failed', 'cancelled'].includes(found.status) ? found : undefined;
  });
  assert.equal(turn.status, expected, `${phase}: terminal outcome (${turn.error?.code ?? 'no error'})`);
  const items = (await current.beta.agents.sessions.items.list(id, { limit: 100 })).data;
  const commands = items.filter(item => item.turn_id === turn.id && item.type === 'command_execution').length;
  if (expected === 'completed') assert(commands > 0, 'Real remote command must appear in HTTP Session history');
  turns.push({ phase, id: turn.id, status: turn.status, commands }); return turn;
}
async function message(text: string) { assert(client && session); await client.beta.agents.sessions.events.create(session.id, { events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text }] }] }] }); }
function proof(callId: string) {
  const output = outputs.get(callId); assert(output, `No observed command output for ${callId}`);
  const line = output.split('\n').find(line => line.startsWith('RAT_CODEX_PROOF:')); assert(line, 'Remote command did not return its proof');
  const value: unknown = JSON.parse(line.slice('RAT_CODEX_PROOF:'.length)); proofs.push({ phase, outputSha256: digest(output), proof: value }); return value;
}
async function closeSession() {
  if (session && client) await client.beta.agents.sessions.delete(session.id);
  session = undefined;
  if (server) await server.close(); server = undefined; client = undefined;
}
async function serialLogs(directory_: string): Promise<{ path: string; text: string }[]> {
  const result: { path: string; text: string }[] = [];
  for (const entry of await readdir(directory_, { withFileTypes: true })) {
    const path = join(directory_, entry.name);
    if (entry.isDirectory()) result.push(...await serialLogs(path));
    else if (entry.isFile() && entry.name === 'serial.log') { const bytes = await readFile(path); assert(bytes.length <= 16 * 1024 ** 2); result.push({ path, text: bytes.toString() }); }
  }
  return result;
}
function safeError(error: unknown) { let text = error instanceof Error ? `${error.name}: ${error.message}` : 'Unknown failure'; for (const secret of [sentinel, ...knownTokens]) text = text.replaceAll(secret, '[redacted]'); return text.slice(0, 4000); }

try {
  assert(sourceAssets && isAbsolute(sourceAssets), 'Set RAT_THINGS_LINUX_KVM_RUNTIME to the real prepared Linux KVM assets');
  assert(binary && isAbsolute(binary), 'Set CODEX_BINARY to the actual patched host Codex executable');
  const artifact = await validateCodexRuntimeArtifact(resolve(process.env.CODEX_RUNTIME_ARTIFACT ?? '.runtime/codex/linux-x64'), { expectedTarget: 'x86_64-unknown-linux-gnu' });
  assert.equal(await hashFile(binary), artifact.manifest.sha256, 'Host binary must match the admitted patched x64 artifact');
  await launch(normalProfile);
  const outsidePath = `/home/agent/rat-codex-outside-${nonce}`, escapedPath = `/home/agent/rat-codex-symlink-${nonce}`;
  const content = `Real Codex remote workspace ${nonce}\n`;
  const isolation = `const fs=require('node:fs');(async()=>{const owner=fs.statSync('/home/agent');const denied=path=>{try{fs.writeFileSync(path,'escaped');return false}catch(e){return ['EACCES','EPERM','EROFS'].includes(e.code)}};fs.writeFileSync('/workspace/codex-parity.txt',${JSON.stringify(content)});const directDenied=denied(${JSON.stringify(outsidePath)});fs.symlinkSync('/home/agent','/workspace/outside-link');const symlinkDenied=denied('/workspace/outside-link/rat-codex-symlink-${nonce}');fs.unlinkSync('/workspace/outside-link');const network=[];for(const url of ['http://127.0.0.1:3211/health','http://169.254.169.254/']){try{await fetch(url,{signal:AbortSignal.timeout(1500)});network.push(false)}catch{network.push(true)}}let tokenReadable=false;try{fs.readFileSync('/etc/rat-things/control-token');tokenReadable=true}catch{};const result={uid:process.getuid(),platform:process.platform,outsideOwner:owner.uid,outsideOwnerWritable:Boolean(owner.mode&0o200),content:fs.readFileSync('/workspace/codex-parity.txt','utf8'),listed:fs.readdirSync('/workspace').includes('codex-parity.txt'),directDenied,symlinkDenied,outsideExists:fs.existsSync(${JSON.stringify(outsidePath)})||fs.existsSync(${JSON.stringify(escapedPath)}),hostDirectory:fs.existsSync(${JSON.stringify(directory)}),hostHome:fs.existsSync(${JSON.stringify(homedir())}),auth:fs.existsSync('/home/agent/.codex/auth.json'),socket:['/var/run/docker.sock','/run/docker.sock',${JSON.stringify(`/run/user/${process.getuid?.() ?? 0}/rat-things-parity-docker.sock`)}].some(path=>fs.existsSync(path)),ambientSecret:Object.values(process.env).includes(${JSON.stringify(sentinel)}),sensitiveNames:Object.keys(process.env).filter(key=>['RAT_CODEX_PARITY_SECRET','OPENAI_API_KEY','AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','AWS_SESSION_TOKEN','CODEX_EXEC_SERVER_NOISE_AUTH_TOKEN','CODEX_API_KEY'].includes(key)),tokenReadable,networkBlocked:network};fs.appendFileSync('/workspace/effect-count','once\\n');console.log('RAT_CODEX_PROOF:'+JSON.stringify(result))})().catch(error=>{console.error(error.code);process.exitCode=1});`;
  phase = 'Codex command confinement'; queued = { id: 'confinement', program: isolation };
  session = await client!.beta.agents.sessions.create({ agent: { model: modelId, multi_agent: { enabled: false } }, environment: { type: 'openai_hosted',
    setup_commands: [{ command: 'node /workspace/setup-proof.cjs' }], files: [{ type: 'inline', path: '/workspace/setup-proof.cjs', data: Buffer.from("require('node:fs').appendFileSync('/workspace/setup-count','once\\n')").toString('base64') }] }, input: 'Deterministic fixture: run the real remote command confinement checks.' });
  assert(session.environment.type === 'openai_hosted'); assert.equal(session.environment.network.access, 'disabled');
  const first = await terminal([], 'completed');
  assert.deepEqual(proof('confinement'), { uid: 10001, platform: 'linux', outsideOwner: 10001, outsideOwnerWritable: true, content, listed: true,
    directDenied: true, symlinkDenied: true, outsideExists: false, hostDirectory: false, hostHome: false, auth: false, socket: false, ambientSecret: false, sensitiveNames: [], tokenReadable: false, networkBlocked: [true, true] });
  assert((await files()).some(file => file.path === '/workspace/codex-parity.txt' && file.size_bytes === Buffer.byteLength(content)));

  phase = 'Codex cancellation and descendants'; cancellation = true;
  const lateDelayMs = 15000;
  const child = `setTimeout(()=>require('node:fs').writeFileSync('/workspace/cancel-too-late','survived'),${lateDelayMs})`;
  queued = { id: 'cancel-command', program: `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore'});require('node:fs').writeFileSync('/workspace/cancel-started','started');setInterval(()=>{},1000);` };
  await message('Start the cancellation fixture command.');
  await poll('Running command marker', async () => (await files()).some(file => file.path === '/workspace/cancel-started') ? true : undefined);
  assert(!(await files()).some(file => file.path === '/workspace/cancel-too-late'));
  const cancelledAt = Date.now();
  await client!.beta.agents.sessions.events.create(session.id, { events: [{ type: 'agent.session.input.cancel' }] });
  const cancelled = await terminal([first.id], 'cancelled'); cancellation = false;
  await delay(Math.max(0, lateDelayMs + 2000 - (Date.now() - cancelledAt)));
  assert(!(await files()).some(file => file.path === '/workspace/cancel-too-late'), 'Cancelled command descendant wrote after cancellation');

  phase = 'Codex service restart'; const callsBefore = requests.length;
  await server!.close(); server = undefined; client = undefined;
  await launch(normalProfile); await delay(500);
  restartCalls = { before: callsBefore, after: requests.length }; assert.equal(restartCalls.after, restartCalls.before, 'Service restart must not replay an already settled Turn');
  queued = { id: 'restart', program: `const fs=require('node:fs');console.log('RAT_CODEX_PROOF:'+JSON.stringify({content:fs.readFileSync('/workspace/codex-parity.txt','utf8'),setup:fs.readFileSync('/workspace/setup-count','utf8'),effect:fs.readFileSync('/workspace/effect-count','utf8'),late:fs.existsSync('/workspace/cancel-too-late')}))` };
  await message('Run a new remote Turn after restarting the service.');
  await terminal([first.id, cancelled.id], 'completed');
  assert.deepEqual(proof('restart'), { content, setup: 'once\n', effect: 'once\n', late: false });
  assert((await client!.beta.agents.sessions.items.list(session.id, { limit: 100 })).data.some(item => item.turn_id === first.id && item.type === 'command_execution'));
  await closeSession();

  phase = 'build deliberately broken sandbox fixture';
  const negativeAssets = await sandboxRefusalVariant(sourceAssets, directory);
  process.env.RAT_THINGS_LINUX_KVM_RUNTIME = negativeAssets;
  for (const driver of ['codex', 'pi'] as const) {
    phase = `${driver} sandbox startup refusal`; queued = undefined;
    const before = driver === 'codex' ? requests.length : faux.state.callCount;
    await launch(join(directory, `${driver}-refusal-profile`));
    session = await client!.beta.agents.sessions.create({ ...(driver === 'pi' ? { metadata: { rat_things_runtime: 'pi' } } : {}),
      agent: { model: driver === 'pi' ? piModelId : modelId, multi_agent: { enabled: false } }, environment: { type: 'openai_hosted' }, input: 'No model dispatch is permitted because the managed sandbox cannot start.' });
    const refused = await terminal([], 'failed');
    const logs = await serialLogs(activeProfile);
    assert(logs.some(log => log.text.includes('Local worker failed during setup.')), 'Refusal must come from the actual worker setup sandbox gate, not an unrelated boot failure');
    const after = driver === 'codex' ? requests.length : faux.state.callCount;
    assert.equal(after, before, `${driver}: a refused sandbox must dispatch no model request`);
    const savedLogs: string[] = [];
    for (const [index, log] of logs.entries()) { const saved = join(directory, `${driver}-refusal-serial-${index}.log`); await writeFile(saved, log.text, { mode: 0o600 }); savedLogs.push(saved); }
    refusals.push({ driver, modelCalls: after - before, serialLogs: savedLogs, turnStatus: refused.status });
    await closeSession();
  }
  assert.equal(fixtureFailure, undefined); completed = true;
} catch (error) { failure = error; }
finally {
  try { await closeSession(); } catch (error) { cleanupErrors.push(safeError(error)); try { await server?.close(); } catch (error) { cleanupErrors.push(safeError(error)); } }
  model.closeAllConnections(); await new Promise<void>(done => model.close(() => done()));
  if (sourceAssets === undefined) delete process.env.RAT_THINGS_LINUX_KVM_RUNTIME; else process.env.RAT_THINGS_LINUX_KVM_RUNTIME = sourceAssets;
  if (previousSecret === undefined) delete process.env.RAT_CODEX_PARITY_SECRET; else process.env.RAT_CODEX_PARITY_SECRET = previousSecret;
  const passed = completed && failure === undefined && cleanupErrors.length === 0;
  const evidence = join(directory, 'evidence.json');
  await writeFile(evidence, JSON.stringify({ version: 1, status: passed ? 'passed' : 'failed', fixture: 'deterministic local Responses fixture; real patched host Codex and KVM worker',
    coverage: 'HTTP Session, remote commands, confinement, cancellation, graceful restart, and shared startup refusal; no Rust UI or live inference claim',
    phase, runtimeObservations, turns, proofs, restartCalls, refusals, modelCalls: requests.length, piModelCalls: faux.state.callCount,
    ...(failure === undefined ? {} : { failure: safeError(failure) }), cleanupErrors }, null, 2) + '\n', { mode: 0o600 });
  console.log(`Codex real-worker acceptance ${passed ? 'passed' : 'failed'}. Evidence: ${evidence}`);
  if (!passed) process.exitCode = 1;
}
