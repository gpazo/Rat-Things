import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { createAgentsClient } from '../../src/agents-client.js';
import type { Turn } from '../../src/domain/agents-api.js';

const live = process.env.AWS_E2E === 'true' ? it : it.skip;
const timeoutMs = Number(process.env.AWS_E2E_TIMEOUT_MS ?? 420_000);
const soakSeconds = Number(process.env.AWS_E2E_SOAK_SECONDS ?? 0);

live('retains a managed workspace, streams completed Turns, and enforces the guest boundary', async () => {
  if (process.env.AWS_E2E_REAL_CODEX !== 'true') throw new Error('Set AWS_E2E_REAL_CODEX=true to opt into the live managed Session probe.');
  if (!Number.isInteger(soakSeconds) || soakSeconds < 0 || soakSeconds > 86_400) throw new Error('AWS_E2E_SOAK_SECONDS must be between 0 and 86400.');
  const ec2 = process.env.AWS_E2E_ENABLE_EC2_WORKER === 'true';
  if (soakSeconds >= 28_000 && !ec2) throw new Error('The long-lived Session probe requires the dedicated EC2 backend.');
  const client = createAgentsClient({ baseURL: required('RAT_THINGS_AGENTS_API_URL'), region: required('AWS_REGION') }).withOptions({ maxRetries: 0, timeout: 360_000 });
  const marker = `managed-${randomUUID()}`;
  const filePath = '/workspace/outputs/proof.json';
  const agent = await client.beta.agents.create({ model: required('AWS_E2E_CODEX_MODEL_ID'), name: 'Disposable managed worker proof',
    instructions: 'Execute the requested environment checks precisely. Use the environment command tools. Do not replace execution with a proposed command.', tools: [] });
  let sessionId: string | undefined;
  const abort = new AbortController();
  let consume: Promise<void> | undefined;
  try {
    const session = await client.beta.agents.sessions.create({ agent_id: agent.id, environment: { type: 'openai_hosted', network: { access: 'enabled' } } });
    sessionId = session.id;
    const stream = await client.beta.agents.sessions.events.stream(session.id, { signal: abort.signal });
    const completions = new Set<string>();
    let streamFailure: unknown;
    consume = (async () => {
      try { for await (const event of stream) if (event.type === 'agent.session.turn.completed') completions.add(event.turn.id); }
      catch (error) { if (!abort.signal.aborted) streamFailure = error; }
    })();
    const program = [
      'import os, json, time, uuid, urllib.request, urllib.error',
      'started = time.monotonic()',
      'nonce = str(uuid.uuid4())',
      'proof = {"uid": os.getuid(), "marker": ' + JSON.stringify(marker) + '}',
      'def denied(url):',
      '    try:',
      '        urllib.request.urlopen(url, timeout=3).close()',
      '        return False',
      '    except urllib.error.HTTPError: return False',
      '    except urllib.error.URLError: return True',
      'proof["control_denied"] = denied("http://127.0.0.1:8080/aws/lambda-microvms/runtime/v1/ready")',
      ...(ec2 ? [
        'proof["metadata_denied"] = denied(urllib.request.Request("http://169.254.169.254/latest/api/token", data=b"", method="PUT", headers={"X-aws-ec2-metadata-token-ttl-seconds": "60"}))',
        'try:',
        '    open("/etc/rat-worker/environment.json").close()',
        '    proof["host_config_denied"] = False',
        'except PermissionError: proof["host_config_denied"] = True',
      ] : []),
      'proof["process_nonce"] = nonce',
      'os.makedirs("/workspace/outputs", exist_ok=True)',
      'with open(' + JSON.stringify(filePath) + ', "w") as f: json.dump(proof, f)',
      'print("PROOF_STARTED " + json.dumps(proof), flush=True)',
      `deadline = started + ${soakSeconds + 2 * timeoutMs / 1000 + 120}`,
      'while not os.path.exists("/workspace/continue-proof"):',
      '    if time.monotonic() >= deadline: raise RuntimeError("Continuation deadline expired")',
      '    time.sleep(0.1)',
      'result = {"marker": proof["marker"], "process_nonce": nonce, "elapsed_seconds": time.monotonic() - started}',
      'with open("/workspace/outputs/continuation.json", "w") as f: json.dump(result, f)',
      'print("PROOF_CONTINUED " + json.dumps(result), flush=True)',
    ].join('\n');
    const input = { type: 'agent.session.input.message' as const, input: [{ role: 'user' as const, content: [{ type: 'input_text' as const,
      text: `Run this Python program verbatim using exec_command with yield_time_ms=1000. Once PROOF_STARTED appears, finish this Turn with the starting JSON while leaving that command session running. Keep its execution session ID for the next Turn. Do not background, kill, interrupt, or wait for this command to exit. It checks our own worker without reading credentials.\n\n${program}` }] }] };
    const key = `managed-proof:${session.id}`;
    await client.beta.agents.sessions.events.create(session.id, { events: [input], 'Idempotency-Key': key });
    // A repeated receipt must not create a second root Turn or repeat the commands.
    await client.beta.agents.sessions.events.create(session.id, { events: [input], 'Idempotency-Key': key });
    const first = await completedTurn(client, session.id, new Set(), timeoutMs);
    const artifacts = [];
    for await (const artifact of client.beta.agents.sessions.artifacts.list(session.id)) artifacts.push(artifact);
    const artifact = artifacts.find(value => value.path === filePath && value.turn_id === first.id);
    expect(artifact).toBeDefined();
    const bytes = await client.beta.agents.sessions.artifacts.content(artifact!.id, { session_id: session.id });
    const firstProof = await bytes.json() as { process_nonce: string };
    expect(firstProof).toEqual({ uid: 10001, marker, control_denied: true, process_nonce: expect.any(String), ...(ec2 ? { metadata_denied: true, host_config_denied: true } : {}) });
    const firstItems = [];
    for await (const item of client.beta.agents.sessions.items.list(session.id)) firstItems.push(item);
    expect(firstItems).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'command_execution', turn_id: first.id })]));
    const rootIds = [];
    for await (const turn of client.beta.agents.sessions.turns.list(session.id)) if (turn.subagent_id === null) rootIds.push(turn.id);
    expect(rootIds).toEqual([first.id]);

    // Optional live soak keeps the same Session open past the MicroVM ceiling.
    const soakDeadline = Date.now() + soakSeconds * 1000;
    while (Date.now() < soakDeadline) {
      await delay(Math.min(60_000, soakDeadline - Date.now()));
      expect((await client.beta.agents.sessions.retrieve(session.id)).status).toBe('idle');
      console.log(`Managed Session soak remaining: ${Math.max(0, Math.ceil((soakDeadline - Date.now()) / 1000))} seconds`);
    }
    const continuation = [
      'import json, time, os',
      'with open("/workspace/continue-proof", "w") as f: f.write("continue")',
      'deadline = time.monotonic() + 30',
      'while not os.path.exists("/workspace/outputs/continuation.json"):',
      '    if time.monotonic() >= deadline: raise RuntimeError("Original process did not continue")',
      '    time.sleep(0.1)',
      'print(json.dumps(json.load(open("/workspace/outputs/continuation.json"))))',
    ].join('\n');
    await client.beta.agents.sessions.events.create(session.id, { events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: `Run this Python program verbatim and return its JSON. Then use write_stdin on the original command session to collect its PROOF_CONTINUED output and confirm that it exited successfully. Do not recreate the original process or its output. This verifies that the same command survived between Turns.\n\n${continuation}` }] }] }] });
    const second = await completedTurn(client, session.id, new Set([first.id]), timeoutMs);
    expect(second.id).not.toBe(first.id);
    const secondItems = [];
    for await (const item of client.beta.agents.sessions.items.list(session.id)) if (item.turn_id === second.id) secondItems.push(item);
    expect(secondItems).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'command_execution', status: 'completed', exit_code: 0 })]));
    expect(JSON.stringify(secondItems)).toContain(marker);
    for (let attempt = 0; attempt < 50 && !completions.has(second.id) && !streamFailure; attempt++) await delay(100);
    expect(streamFailure).toBeUndefined();
    expect(completions).toEqual(new Set([first.id, second.id]));
    const continuedArtifacts = [];
    for await (const value of client.beta.agents.sessions.artifacts.list(session.id)) continuedArtifacts.push(value);
    const continuedArtifact = continuedArtifacts.find(value => value.turn_id === second.id && value.path === '/workspace/outputs/continuation.json');
    expect(continuedArtifact).toBeDefined();
    const continuedProof = await (await client.beta.agents.sessions.artifacts.content(continuedArtifact!.id, { session_id: session.id })).json() as { elapsed_seconds: number };
    expect(continuedProof).toEqual({ marker, process_nonce: firstProof.process_nonce, elapsed_seconds: expect.any(Number) });
    expect(continuedProof.elapsed_seconds).toBeGreaterThanOrEqual(soakSeconds);
    expect(await (await client.beta.agents.sessions.artifacts.content(artifact!.id, { session_id: session.id })).json()).toMatchObject({ marker });
  } finally {
    abort.abort(); await consume;
    try { if (sessionId) await client.beta.agents.sessions.delete(sessionId); }
    finally { await client.beta.agents.delete(agent.id); }
  }
}, timeoutMs * 2 + 120_000 + soakSeconds * 1000);

async function completedTurn(client: ReturnType<typeof createAgentsClient>, sessionId: string, seen: Set<string>, timeout: number): Promise<Turn> {
  const deadline = Date.now() + timeout;
  for (;;) {
    for await (const turn of client.beta.agents.sessions.turns.list(sessionId, { order: 'asc' })) {
      if (turn.subagent_id !== null || seen.has(turn.id)) continue;
      if (turn.status === 'completed') return turn;
      if (turn.status === 'failed' || turn.status === 'cancelled') throw new Error(`Managed proof Turn ${turn.id} ended ${turn.status}.`);
    }
    const session = await client.beta.agents.sessions.retrieve(sessionId);
    if (session.status === 'failed' || Date.now() >= deadline) throw new Error(`Managed Session ${sessionId} did not complete.`);
    await delay(2000);
  }
}

function required(name: string): string { const value = process.env[name]; if (!value) throw new Error(`${name} is required for live AWS validation.`); return value; }
