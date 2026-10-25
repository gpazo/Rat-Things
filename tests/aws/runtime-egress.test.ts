import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { toFile } from 'openai';
import { it } from 'vitest';
import { createAgentsClient } from '../../src/agents-client.js';
import type { AgentSessionItem, SessionArtifact, Turn } from '../../src/domain/agents-api.js';
import { egressInputPath, egressProbeCommand, egressProbeProgram, egressProgramPath, egressTurnEvidence, isEgressProbeCommand, publicCanary, receiptLimit, type EgressProbeSpec } from '../../testing/aws/egress-proof.js';

const live = process.env.AWS_E2E === 'true' && process.env.AWS_E2E_EGRESS_PROOF === 'true' && process.env.AWS_E2E_REAL_CODEX === 'true' ? it : it.skip;
const turnTimeoutMs = 420_000;

live('proves default guest denial and enabled private Bedrock access without public TCP egress', async () => {
  const region = required('AWS_REGION');
  assert(/^[a-z]{2}(?:-[a-z0-9]+)+-\d+$/.test(region), 'AWS_REGION must be an AWS region name');
  const client = createAgentsClient({ baseURL: required('RAT_THINGS_AGENTS_API_URL'), region }).withOptions({ maxRetries: 0, timeout: 30_000 });
  const model = required('AWS_E2E_CODEX_MODEL_ID');
  const proofId = `egress-${randomUUID()}`;
  const input = randomBytes(64);
  const inputSha256 = createHash('sha256').update(input).digest('hex');
  const evidencePath = resolve('test-results/aws-hardening-validation', `${proofId}.json`);
  const evidence: {
    proofId: string; region: string; model: string; inputSha256: string;
    agentId?: string; uploadId?: string; sessions: unknown[]; controls: unknown[];
    cleanup: unknown[]; failure?: { name: string; message: string }; completed?: true;
  } = { proofId, region, model, inputSha256, sessions: [], controls: [], cleanup: [] };
  const sessionIds: string[] = [];
  let agentId: string | undefined;
  let uploadId: string | undefined;
  let failure: unknown;
  try {
    evidence.controls.push(await publicControl('before'));
    const agent = await client.beta.agents.create({ model, name: 'Disposable runtime egress proof', tools: [],
      instructions: 'Execute the supplied command verbatim exactly once with exec_command. Wait for it to exit with write_stdin if needed. Do not edit the command, run other commands, create subagents, or replace execution with prose. Then reply EGRESS_PROBE_COMPLETE.' });
    agentId = agent.id;
    evidence.agentId = agent.id;
    const upload = await client.files.create({ file: await toFile(input, 'egress-input.bin'), purpose: 'user_data' });
    uploadId = upload.id;
    evidence.uploadId = upload.id;
    for (const networkAccess of ['disabled', 'enabled'] as const) {
      const spec: EgressProbeSpec = { marker: `${proofId}-${networkAccess}`, bedrockHost: `bedrock-runtime.${region}.amazonaws.com`,
        outputPath: `/workspace/outputs/${proofId}-${networkAccess}.json`, networkAccess };
      const session = await client.beta.agents.sessions.create({ agent_id: agent.id, environment: { type: 'openai_hosted',
        ...(networkAccess === 'enabled' ? { network: { access: 'enabled' as const } } : {}),
        files: [{ type: 'file_id', path: egressInputPath, file_id: upload.id },
          { type: 'inline', path: egressProgramPath, data: Buffer.from(egressProbeProgram(spec)).toString('base64') }] } });
      sessionIds.push(session.id);
      console.log(JSON.stringify({ phase: 'session-created', proofId, sessionId: session.id, networkAccess }));
      const observed: Record<string, unknown> = { sessionId: session.id, requestedNetwork: networkAccess === 'disabled' ? 'omitted' : 'enabled', environment: session.environment };
      evidence.sessions.push(observed);
      assert(session.environment.type === 'openai_hosted', 'Hosted environment is required');
      const environment = session.environment;
      assert.equal(environment.network.access, networkAccess, 'Omitted network policy must default to disabled');
      const command = egressProbeCommand;
      await client.beta.agents.sessions.events.create(session.id, { events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text',
        text: `Run this exact shell command once through exec_command with yield_time_ms=1000. Preserve every byte and wait for its successful exit. It reads only the uploaded random file and probes TCP/TLS without credentials or HTTP requests.\n\n${command}` }] }] }] });
      const turn = await completedRootTurn(client, session.id);
      observed.turn = turn;
      const items: AgentSessionItem[] = [];
      for await (const item of client.beta.agents.sessions.items.list(session.id, { order: 'asc' })) items.push(item);
      observed.commands = items.filter(item => item.type === 'command_execution').map(item => ({ id: item.id, turnId: item.turn_id,
        status: item.status, exitCode: item.exit_code, exactCommand: isEgressProbeCommand(item.command),
        ...(isEgressProbeCommand(item.command) ? { output: item.output?.slice(0, receiptLimit), command: item.command } : {}) }));
      const artifacts: SessionArtifact[] = [];
      for await (const artifact of client.beta.agents.sessions.artifacts.list(session.id)) artifacts.push(artifact);
      observed.artifacts = artifacts;
      const artifact = artifacts.find(value => value.session_id === session.id && value.turn_id === turn.id
        && value.environment_id === environment.id && value.path === spec.outputPath);
      assert(artifact, 'Missing immutable receipt artifact');
      assert(artifact.size_bytes <= receiptLimit, 'Receipt artifact is oversized');
      const artifactText = await boundedText(await client.beta.agents.sessions.artifacts.content(artifact.id, { session_id: session.id }));
      observed.artifactText = artifactText;
      observed.proof = egressTurnEvidence({ session: await client.beta.agents.sessions.retrieve(session.id), turn, items, artifacts, artifactText,
        expected: { ...spec, agentId: agent.id, sessionId: session.id, inputSha256 } });
      const replacement = Buffer.from(`replaced live workspace receipt ${proofId}\n`);
      const overwritten = await client.beta.agents.environments.files.create(environment.id, { type: 'inline', path: spec.outputPath, data: replacement.toString('base64') });
      assert.equal(overwritten.size_bytes, replacement.byteLength);
      const liveFiles = await client.beta.agents.environments.files.list(environment.id, { path: '/workspace/outputs' });
      assert(liveFiles.data.some(file => file.path === spec.outputPath && file.size_bytes === replacement.byteLength), 'Live receipt must be overwritten before testing snapshot immutability');
      assert.equal(await boundedText(await client.beta.agents.sessions.artifacts.content(artifact.id, { session_id: session.id })), artifactText, 'Published artifact must remain immutable after the live file changes');
      observed.immutableAfterWorkspaceOverwrite = true;
      evidence.controls.push(await publicControl(`after-${networkAccess}`));
    }
    evidence.completed = true;
  } catch (error) {
    failure = error;
    evidence.failure = errorSummary(error);
  } finally {
    const cleanupFailures: unknown[] = [];
    const cleanupClient = client.withOptions({ maxRetries: 1, timeout: 30_000 });
    for (const [kind, id, remove] of [
      ...sessionIds.map(id => ['session', id, () => cleanupClient.beta.agents.sessions.delete(id)] as const),
      ...(agentId ? [['agent', agentId, () => cleanupClient.beta.agents.delete(agentId!)] as const] : []),
      ...(uploadId ? [['upload', uploadId, () => cleanupClient.files.delete(uploadId!)] as const] : []),
    ]) {
      try { await remove(); evidence.cleanup.push({ kind, id, deleted: true }); }
      catch (error) { cleanupFailures.push(error); evidence.cleanup.push({ kind, id, deleted: false, error: errorSummary(error) }); }
    }
    try {
      await mkdir(resolve('test-results/aws-hardening-validation'), { recursive: true });
      await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
      console.log(JSON.stringify({ proofId, evidencePath, completed: evidence.completed === true }));
    } catch (error) { cleanupFailures.push(error); }
    if (cleanupFailures.length) throw new AggregateError([...(failure === undefined ? [] : [failure]), ...cleanupFailures], 'Egress proof or cleanup failed', { cause: failure ?? cleanupFailures[0] });
  }
  if (failure !== undefined) throw failure;
}, 2 * turnTimeoutMs + 360_000);

async function completedRootTurn(client: ReturnType<typeof createAgentsClient>, sessionId: string): Promise<Turn> {
  const deadline = Date.now() + turnTimeoutMs;
  const signal = AbortSignal.timeout(turnTimeoutMs);
  while (Date.now() < deadline) {
    const turns: Turn[] = [];
    for await (const turn of client.beta.agents.sessions.turns.list(sessionId, { order: 'asc' }, { signal })) turns.push(turn);
    const roots = turns.filter(turn => turn.subagent_id === null);
    assert(roots.length <= 1, 'The probe must have exactly one root Turn');
    const turn = roots[0];
    if (turn?.status === 'completed') return turn;
    if (turn?.status === 'failed' || turn?.status === 'cancelled') throw new Error(`Egress Turn ${turn.id} ended ${turn.status} (${turn.error?.code})`);
    const session = await client.beta.agents.sessions.retrieve(sessionId, { signal });
    assert(session.status !== 'failed' && session.status !== 'requires_action', `Egress Session ${sessionId} ended ${session.status}; required actions: ${session.required_actions.map(action => action.type).join(', ') || 'none'}`);
    await delay(Math.min(2000, Math.max(1, deadline - Date.now())), undefined, { signal });
  }
  throw new Error(`Egress Session ${sessionId} exceeded the 420-second Turn deadline`);
}

function publicControl(phase: string): Promise<{ phase: string; host: string; port: number; connected: true; at: string }> {
  return new Promise((resolveControl, reject) => {
    const socket = createConnection(publicCanary.port, publicCanary.host);
    socket.setTimeout(5000);
    socket.once('timeout', () => socket.destroy(new Error('Public TCP positive control timed out')));
    socket.once('error', reject);
    socket.once('connect', () => { socket.destroy(); resolveControl({ phase, ...publicCanary, connected: true, at: new Date().toISOString() }); });
  });
}

async function boundedText(response: Response): Promise<string> {
  assert(response.body, 'Receipt content must have a body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return Buffer.concat(chunks).toString('utf8');
      length += next.value.byteLength;
      assert(length <= receiptLimit, 'Receipt content exceeds its bound');
      chunks.push(next.value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
}

function errorSummary(error: unknown): { name: string; message: string } {
  return error instanceof Error ? { name: error.name, message: error.message.slice(0, 1000) } : { name: 'UnknownError', message: 'Non-Error failure' };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the opt-in live egress proof`);
  return value;
}
