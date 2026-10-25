import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type ToolResultMessage } from '@earendil-works/pi-ai';
import { startLocalServer } from '../../src/local-server.js';
import { createLocalAgentsClient, readLocalConnection } from '../../src/local-workspace.js';
import type { PiModelDescriptor } from '../../src/domain/session-runtime.js';
import type { AgentSession, Turn } from '../../src/domain/agents-api.js';
import { nodeSubprocessStdioProbe, restrictedNetworkSocketProbe } from './subprocess-fixtures.js';

const { values } = parseArgs({ options: { directory: { type: 'string' }, 'timeout-seconds': { type: 'string', default: '300' }, help: { type: 'boolean' } } });
if (values.help) {
  console.log('Usage: npx tsx testing/local-runtime/pi-parity.ts [--directory EVIDENCE_ROOT] [--timeout-seconds 300]\nUses the configured real local runtime and a deterministic faux model. No live inference or runtime mocks.');
  process.exit(0);
}
const timeoutMs = Number(values['timeout-seconds']) * 1000;
assert(Number.isSafeInteger(timeoutMs) && timeoutMs >= 10_000 && timeoutMs <= 1_800_000, 'Timeout must be 10–1800 seconds');
const evidenceRoot = resolve(values.directory ?? 'test-results/local-pi-parity');
await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
const directory = await mkdtemp(join(evidenceRoot, 'run-'));
const profile = join(directory, 'profile');
await mkdir(profile, { mode: 0o700 });
const nonce = randomUUID();
const sentinel = `host-only-${randomUUID()}`;
await writeFile(join(directory, 'host-only.txt'), sentinel, { mode: 0o600 });
const previousSecret = process.env.RAT_PI_PARITY_SECRET;
process.env.RAT_PI_PARITY_SECRET = sentinel;

type EffectCase = {
  label: string;
  name: 'write_file' | 'read_file' | 'list_files' | 'exec_command';
  arguments: Parameters<typeof fauxToolCall>[1];
  expected: 'success' | 'denied';
  verify?: (text: string) => void;
};
type Observation = { label: string; callId: string; result: ToolResultMessage | undefined };
type AssertionEvidence = { label: string; tool: EffectCase['name']; result: 'success' | 'denied'; outputSha256: string; outputBytes: number };
const observations: Observation[] = [];
const assertions: AssertionEvidence[] = [];
const turns: Array<{ phase: string; id: string; status: Turn['status']; commands: number }> = [];
const runtimeObservations: unknown[] = [];
const cleanupErrors: string[] = [];
let server: Awaited<ReturnType<typeof startLocalServer>> | undefined;
let client: ReturnType<typeof createLocalAgentsClient> | undefined;
let session: AgentSession | undefined;
let phase = 'runtime preflight';
let failure: unknown;
let completed = false;
let restartCalls: { before: number; after: number } | undefined;
const model = 'pi-parity-deterministic-fixture';
const faux = fauxProvider({ provider: 'openai-codex', api: 'openai-codex-responses', tokensPerSecond: Infinity,
  models: [{ id: model, reasoning: true, input: ['text'], contextWindow: 100000, maxTokens: 10000 }] });
const models = createModels();
models.setProvider(faux.provider);
const catalog: PiModelDescriptor[] = [{ id: model, name: 'Deterministic acceptance fixture (no live model)', provider: 'openai-codex',
  api: 'openai-codex-responses', input: ['text'], contextWindow: 100000, maxTokens: 10000, reasoning: ['low', 'medium', 'high'] }];
const requestOptions = { maxRetries: 0, timeout: timeoutMs };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const command = (program: string) => ({ command: ['node', '-e', program], cwd: '/workspace' });
const proofPath = '/workspace/parity.txt';
const proofText = `Real worker Pi file ${nonce}\n`;
const deniedPath = `/home/agent/parity-denied-${nonce}`;
const link = '/workspace/parity-escape';
const beganPath = '/workspace/cancel-started';
const latePath = '/workspace/cancel-too-late';
const lateDelayMs = 12000;

function responses(cases: readonly EffectCase[], last = fauxAssistantMessage('Deterministic fixture sequence complete.')): FauxResponseStep[] {
  assert(cases.length > 0);
  const calls = cases.map(test => ({ test, callId: `fixture-${randomUUID()}` }));
  const invoke = (index: number) => {
    const call = calls[index]!;
    return fauxAssistantMessage(fauxToolCall(call.test.name, call.test.arguments, { id: call.callId }), { stopReason: 'toolUse' });
  };
  return [invoke(0), ...calls.map(({ test, callId }, index): FauxResponseStep => context => {
    const result = [...context.messages].reverse().find((message): message is ToolResultMessage => message.role === 'toolResult' && message.toolCallId === callId);
    observations.push({ label: test.label, callId, result });
    return index + 1 < calls.length ? invoke(index + 1) : last;
  })];
}

function verify(cases: readonly EffectCase[]) {
  for (const test of cases) {
    const matching = observations.filter(observation => observation.label === test.label);
    assert.equal(matching.length, 1, `${test.label}: exactly one observed effect result`);
    const result = matching[0]!.result;
    assert(result, `${test.label}: model continuation did not receive the actual tool result`);
    assert.equal(result.toolName, test.name, `${test.label}: tool identity`);
    const text = result.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n');
    assert.equal(result.isError, test.expected === 'denied', `${test.label}: expected ${test.expected}${result.isError ? `; ${safeError(new Error(text))}` : ''}`);
    test.verify?.(text);
    assertions.push({ label: test.label, tool: test.name, result: test.expected, outputSha256: digest(text), outputBytes: Buffer.byteLength(text) });
  }
}

async function poll<T>(label: string, read: () => Promise<T | undefined>, milliseconds = timeoutMs): Promise<T> {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await delay(250);
  }
  throw new Error(`${label} did not settle within ${milliseconds} ms`);
}

async function start() {
  server = await startLocalServer({ directory: profile, model, maxSessions: 1, pi: { catalog, models: () => models } });
  client = createLocalAgentsClient(await readLocalConnection(profile)).withOptions(requestOptions);
  const response = await fetch(`${server.baseURL}/workspace/runtime`, { headers: { authorization: `Bearer ${server.token}` }, signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, 200, 'Runtime status is available over HTTP');
  const status: unknown = await response.json();
  runtimeObservations.push(status);
  assert(status && typeof status === 'object' && 'ready' in status && status.ready === true, 'Real local runtime is unavailable; inspect runtime observations in evidence');
}

async function terminal(excluding: readonly string[], expected: 'completed' | 'cancelled' = 'completed') {
  assert(session && client);
  const currentClient = client;
  const id = session.id;
  return poll(`${phase} Turn`, async () => {
    const turn = (await currentClient.beta.agents.sessions.turns.list(id, { limit: 100 })).data.find(turn => !excluding.includes(turn.id));
    if (!turn || !['completed', 'cancelled', 'failed'].includes(turn.status)) return undefined;
    assert.equal(turn.status, expected, `${phase}: terminal status (${turn.error?.code ?? 'no error code'})`);
    return turn;
  });
}

async function recordTurn(turn: Turn, minimumCommands: number) {
  assert(session && client);
  const items = (await client.beta.agents.sessions.items.list(session.id, { limit: 100, order: 'desc' })).data;
  const commands = items.filter(item => item.turn_id === turn.id && item.type === 'command_execution');
  assert(commands.length >= minimumCommands, `${phase}: managed effects must be visible in HTTP Session items`);
  turns.push({ phase, id: turn.id, status: turn.status, commands: commands.length });
}

async function message(text: string) {
  assert(session && client);
  await client.beta.agents.sessions.events.create(session.id, { events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text }] }] }] });
}

async function files() {
  assert(session?.environment.type === 'openai_hosted' && client);
  return (await client.beta.agents.environments.files.list(session.environment.id, { path: '/workspace', limit: 100 })).data;
}

function safeError(error: unknown): string {
  let value = error instanceof Error ? `${error.name}: ${error.message}` : 'Unknown failure';
  for (const secret of [sentinel, server?.token].filter((value): value is string => Boolean(value))) value = value.replaceAll(secret, '[redacted]');
  return value.slice(0, 4000);
}

try {
  await start();
  const literal = ['space in argument', '$HOME', '$(touch /workspace/injected)', '; touch /workspace/injected'];
  // Restricted Codex networking permits socket(AF_UNIX) only. Require EPERM;
  // a missing Python/AF_VSOCK implementation must fail instead of counting as denial.
  // Python exits successfully only after checking the exact permission error.
  const vsockProgram = `import errno, socket
try:
    endpoint = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
except PermissionError as error:
    if error.errno != errno.EPERM:
        raise
else:
    endpoint.close()
    raise RuntimeError("AF_VSOCK socket was allowed")
`;
  const safetyProgram = `const fs=require('node:fs');(async()=>{const outside=fs.statSync('/home/agent');const endpoints=['http://127.0.0.1:3211/health','http://169.254.169.254/'];const blocked=[];for(const endpoint of endpoints){try{await fetch(endpoint,{signal:AbortSignal.timeout(1500)});blocked.push(false)}catch{blocked.push(true)}}require('node:child_process').execFileSync('python3',['-c',${JSON.stringify(vsockProgram)}],{stdio:'inherit',timeout:5000});const vsockDenied='EPERM';let tokenReadable=false;try{fs.readFileSync('/etc/rat-things/control-token');tokenReadable=true}catch{};console.log(JSON.stringify({uid:process.getuid(),platform:process.platform,outsideOwner:outside.uid,outsideOwnerWritable:Boolean(outside.mode&0o200),hostDirectory:fs.existsSync(${JSON.stringify(directory)}),hostHome:fs.existsSync(${JSON.stringify(homedir())}),auth:fs.existsSync('/home/agent/.codex/auth.json'),socket:['/var/run/docker.sock','/run/docker.sock',${JSON.stringify(`/run/user/${process.getuid?.() ?? 0}/docker.sock`)}].some(path=>fs.existsSync(path)),ambientSecret:Object.values(process.env).includes(${JSON.stringify(sentinel)}),sensitiveNames:Object.keys(process.env).filter(key=>['RAT_PI_PARITY_SECRET','OPENAI_API_KEY','AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','AWS_SESSION_TOKEN','CODEX_EXEC_SERVER_NOISE_AUTH_TOKEN'].includes(key)),networkBlocked:blocked,vsockDenied,tokenReadable,outsideFile:fs.existsSync(${JSON.stringify(deniedPath)}),injectedFile:fs.existsSync('/workspace/injected')}))})().catch(error=>{console.error(error.name,error.code,error.message);process.exitCode=1});`;
  const basic: EffectCase[] = [
    { label: 'managed write', name: 'write_file', arguments: { path: proofPath, content: proofText }, expected: 'success' },
    { label: 'managed read', name: 'read_file', arguments: { path: proofPath }, expected: 'success', verify: text => assert.equal(text, proofText) },
    { label: 'managed listing', name: 'list_files', arguments: { path: '/workspace' }, expected: 'success', verify: text => assert(JSON.parse(text).some((entry: { name: string }) => entry.name === 'parity.txt')) },
    { label: 'literal argv execution', name: 'exec_command', arguments: { command: ['node', '-e', 'console.log(JSON.stringify(process.argv.slice(1)))', ...literal] }, expected: 'success', verify: text => assert.deepEqual(JSON.parse(text), literal) },
    { label: 'captured subprocess input and output', name: 'exec_command', arguments: command(nodeSubprocessStdioProbe), expected: 'success', verify: text => assert.equal(text, 'local-subprocess-stdio-ok\n') },
    { label: 'local socket metadata preserves network denial', name: 'exec_command', arguments: { command: ['python3', '-c', restrictedNetworkSocketProbe] }, expected: 'success', verify: text => assert.equal(text, 'local-socket-only-ok\n') },
    { label: 'same-UID outside write denied', name: 'write_file', arguments: { path: deniedPath, content: 'must not exist' }, expected: 'denied' },
    { label: 'direct outside command denied', name: 'exec_command', arguments: command(`require('node:fs').writeFileSync(${JSON.stringify(deniedPath)},'must not exist')`), expected: 'denied' },
    { label: 'workspace symlink creation', name: 'exec_command', arguments: command(`require('node:fs').symlinkSync('/home/agent',${JSON.stringify(link)})`), expected: 'success' },
    { label: 'symlink write denied', name: 'write_file', arguments: { path: `${link}/parity-denied-${nonce}`, content: 'must not exist' }, expected: 'denied' },
    { label: 'guest isolation and default network denial', name: 'exec_command', arguments: command(safetyProgram), expected: 'success', verify: text => assert.deepEqual(JSON.parse(text), {
      uid: 10001, platform: 'linux', outsideOwner: 10001, outsideOwnerWritable: true, hostDirectory: false, hostHome: false, auth: false, socket: false, ambientSecret: false,
      sensitiveNames: [], networkBlocked: [true, true], vsockDenied: 'EPERM', tokenReadable: false, outsideFile: false, injectedFile: false,
    }) },
  ];
  phase = 'managed tools and confinement';
  faux.setResponses(responses(basic));
  const setupProgram = "require('node:fs').appendFileSync('/workspace/setup-count','once\\n')";
  session = await client!.beta.agents.sessions.create({ metadata: { rat_things_runtime: 'pi' },
    agent: { model, reasoning: { effort: 'medium' }, multi_agent: { enabled: false }, tools: [{ type: 'function', name: 'hold_for_restart', description: 'Acceptance fixture restart barrier', parameters: { type: 'object', properties: {}, additionalProperties: false } }] },
    environment: { type: 'openai_hosted', setup_commands: [{ command: 'node /workspace/setup-proof.cjs' }],
      files: [{ type: 'inline', path: '/workspace/setup-proof.cjs', data: Buffer.from(setupProgram).toString('base64') }] },
    input: 'Deterministic fixture: verify managed tools and confinement in the real worker.' });
  assert.equal(session.environment.type, 'openai_hosted');
  assert(session.environment.type === 'openai_hosted');
  assert.equal(session.environment.network.access, 'disabled', 'Omitted network policy must default to disabled');
  const first = await terminal([]);
  verify(basic);
  await recordTurn(first, basic.length);
  assert((await files()).some(file => file.path === proofPath && file.size_bytes === Buffer.byteLength(proofText)), 'HTTP environment files must expose the actual tool-created file');

  phase = 'cancellation and descendant cleanup';
  const delayed = `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(latePath)},'survived'),${lateDelayMs})`;
  const longProgram = `const fs=require('node:fs');require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(delayed)}],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(beganPath)},'started');setInterval(()=>{},1000);`;
  faux.setResponses([fauxAssistantMessage(fauxToolCall('exec_command', command(longProgram), { id: `cancel-${nonce}` }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Cancellation failed if this continuation ran before cancellation.')]);
  await message('Deterministic fixture: start a long-running command and wait for cancellation.');
  await poll('Running command marker', async () => (await files()).some(file => file.path === beganPath) ? true : undefined);
  assert(!(await files()).some(file => file.path === latePath), 'Command marker already fired before cancellation could be requested');
  const cancelRequestedAt = Date.now();
  await client!.beta.agents.sessions.events.create(session.id, { events: [{ type: 'agent.session.input.cancel' }] });
  const cancelled = await terminal([first.id], 'cancelled');
  await recordTurn(cancelled, 1);
  await delay(Math.max(0, lateDelayMs + 1500 - (Date.now() - cancelRequestedAt)));
  assert(!(await files()).some(file => file.path === latePath), 'A cancelled command descendant wrote its delayed marker');

  phase = 'durable effect before restart';
  const once: EffectCase[] = [{ label: 'durable effect exactly once', name: 'exec_command', arguments: command("require('node:fs').appendFileSync('/workspace/effect-count','once\\n');console.log('effect committed')"), expected: 'success', verify: text => assert.equal(text.trim(), 'effect committed') }];
  faux.setResponses(responses(once, fauxAssistantMessage(fauxToolCall('hold_for_restart', {}, { id: `barrier-${nonce}` }), { stopReason: 'toolUse' })));
  await message('Deterministic fixture: commit one effect, then wait at the application-function barrier.');
  const action = await poll('Durable restart barrier', async () => {
    const actions = (await client!.beta.agents.sessions.retrieve(session!.id)).required_actions;
    const action = actions.find(action => action.type === 'function_call' && action.name === 'hold_for_restart');
    return action?.type === 'function_call' ? action : undefined;
  });
  verify(once);
  const callsBeforeRestart = faux.state.callCount;
  await server!.close();
  server = undefined;
  client = undefined;
  phase = 'same-profile service restart';
  await start();
  const recovered = await poll('Recovered application-function barrier', async () => {
    const actions = (await client!.beta.agents.sessions.retrieve(session!.id)).required_actions;
    return actions.length ? actions : undefined;
  });
  assert.deepEqual(recovered, [action], 'Restart must retain the original required action identity');
  await delay(500);
  restartCalls = { before: callsBeforeRestart, after: faux.state.callCount };
  assert.equal(restartCalls.after, restartCalls.before, 'Restart must not repeat inference or a completed unsafe effect before its pending function result');
  const resumed: EffectCase[] = [
    { label: 'workspace content survives restart', name: 'read_file', arguments: { path: proofPath }, expected: 'success', verify: text => assert.equal(text, proofText) },
    { label: 'setup runs once', name: 'read_file', arguments: { path: '/workspace/setup-count' }, expected: 'success', verify: text => assert.equal(text, 'once\n') },
    { label: 'committed effect is not replayed', name: 'read_file', arguments: { path: '/workspace/effect-count' }, expected: 'success', verify: text => assert.equal(text, 'once\n') },
    { label: 'cancelled descendant stays stopped after restart', name: 'exec_command', arguments: command(`console.log(require('node:fs').existsSync(${JSON.stringify(latePath)}))`), expected: 'success', verify: text => assert.equal(text.trim(), 'false') },
  ];
  faux.setResponses(responses(resumed));
  await client!.beta.agents.sessions.events.create(session.id, { events: [{ type: 'agent.session.input.tool_result', turn_id: action.turn_id, call_id: action.call_id, success: true, output: 'Restart verified by acceptance harness.' }] });
  const continuation = await terminal([first.id, cancelled.id]);
  assert.equal(continuation.id, action.turn_id, 'The existing waiting Turn must resume');
  verify(resumed);
  await recordTurn(continuation, once.length + resumed.length);
  const final = await client!.beta.agents.sessions.retrieve(session.id);
  assert.equal(final.environment.type === 'openai_hosted' ? final.environment.id : undefined, session.environment.id, 'Restart must retain its Environment identity');
  const history = await client!.beta.agents.sessions.items.list(session.id, { limit: 100 });
  assert(history.data.some(item => item.turn_id === first.id && item.type === 'command_execution'), 'History before restart remains visible');
  assert.equal(faux.getPendingResponseCount(), 0, 'Every scripted fixture response must be consumed');
  completed = true;
} catch (error) {
  failure = error;
} finally {
  if (session && client) {
    try { await client.beta.agents.sessions.delete(session.id); } catch (error) { cleanupErrors.push(safeError(error)); }
  }
  if (server) {
    try { await server.close(); } catch (error) { cleanupErrors.push(safeError(error)); }
  }
  if (previousSecret === undefined) delete process.env.RAT_PI_PARITY_SECRET;
  else process.env.RAT_PI_PARITY_SECRET = previousSecret;
  const passed = completed && failure === undefined && cleanupErrors.length === 0;
  const evidence = join(directory, 'evidence.json');
  await writeFile(evidence, JSON.stringify({ version: 1, status: passed ? 'passed' : 'failed', fixture: 'deterministic fauxProvider; real unmocked local worker',
    inference: 'fixture_only_no_live_credentials', coverage: 'HTTP and worker acceptance; Rust UI and live subscription are separate gates',
    sessionId: session?.id, phase, runtimeObservations, turns, assertions, restartCalls, modelCalls: faux.state.callCount,
    cancellation: { delayedDescendantMilliseconds: lateDelayMs, checkedAfterCancellationAndRestart: completed },
    ...(failure === undefined ? {} : { failure: safeError(failure) }), cleanupErrors,
  }, null, 2) + '\n', { mode: 0o600 });
  console.log(`Pi real-worker fixture acceptance ${passed ? 'passed' : 'failed'}. Evidence: ${evidence}`);
  if (!passed) process.exitCode = 1;
}
