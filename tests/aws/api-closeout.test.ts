import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { createAgentsClient } from '../../src/agents-client.js';
import type { ApiScope } from '../../src/domain/api-permissions.js';
import { exportSessionTraces, sessionTracePage } from '../../src/trace-export.js';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const live = process.env.AWS_E2E === 'true' && process.env.AWS_E2E_API_CLOSEOUT_PROOF === 'true' ? it : it.skip;
const timeoutMs = Number(process.env.AWS_E2E_TIMEOUT_MS ?? 420_000);
const client = (scopes?: ApiScope[]) => createAgentsClient({ baseURL: required('RAT_THINGS_AGENTS_API_URL'), region: required('AWS_REGION'), ...(scopes ? { scopes } : {}) }).withOptions({ maxRetries: 2 });

live('enforces scoped inference, validates model updates and exports live OTLP history', async () => {
  if (process.env.AWS_E2E_REAL_CODEX !== 'true') throw new Error('Explicit model opt-in required');
  const admin = client();
  const reader = client(['api.agents.read']);
  const writer = client(['api.agents.write']);
  const traceReader = client(['api.traces.read']);
  const none = client([]);
  const marker = `private-prompt-${randomUUID()}`;
  const agent = await admin.beta.agents.create({ model: required('AWS_E2E_CODEX_MODEL_ID'), tools: [] });
  let sessionId: string | undefined;
  try {
    await expect(none.beta.agents.retrieve(agent.id)).rejects.toMatchObject({ status: 403 });
    expect((await reader.beta.agents.retrieve(agent.id)).id).toBe(agent.id);
    await expect(reader.beta.agents.update(agent.id, { name: 'forbidden' })).rejects.toMatchObject({ status: 403 });
    await expect(reader.beta.agents.vaults.list()).rejects.toMatchObject({ status: 403 });
    await expect(writer.beta.agents.sessions.create({ agent_id: agent.id, environment: { type: 'none' }, input: marker })).rejects.toMatchObject({ status: 403 });
    const session = await writer.beta.agents.sessions.create({ agent_id: agent.id, environment: { type: 'self_hosted', workspace_directory: '/workspace' } });
    sessionId = session.id;
    const original = await admin.beta.agents.sessions.retrieve(session.id);
    await expect(writer.beta.agents.sessions.events.create(session.id, { events: [
      { type: 'agent.session.input.cancel' },
      { type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: marker }] }] },
    ] })).rejects.toMatchObject({ status: 403 });
    expect((await admin.beta.agents.sessions.turns.list(session.id)).data).toHaveLength(0);
    expect((await admin.beta.agents.sessions.retrieve(session.id)).status).toBe(original.status);
    await expect(writer.beta.agents.sessions.update(session.id, { agent: { model: 'gpt-5.4-mini', reasoning: { effort: 'max' } }, metadata: { invalid: 'must-not-persist' } })).rejects.toMatchObject({ status: 400 });
    expect((await admin.beta.agents.sessions.retrieve(session.id)).agent).toEqual(original.agent);
    expect((await admin.beta.agents.sessions.retrieve(session.id)).metadata).toEqual(original.metadata);
    expect((await writer.beta.agents.sessions.update(session.id, { agent: { model: 'gpt-5.4-mini-2026-03-17', reasoning: { effort: 'none' }, service_tier: 'priority' } })).agent).toMatchObject({ model: 'gpt-5.4-mini-2026-03-17', reasoning: { effort: 'none' }, service_tier: 'priority' });
    await admin.beta.agents.sessions.delete(session.id); sessionId = undefined;

    const running = await admin.beta.agents.sessions.create({ agent_id: agent.id, environment: { type: 'openai_hosted', network: { access: 'disabled' } }, input: `Run printf TRACE_TOOL_OK, then answer DONE. Do not repeat this private marker: ${marker}` });
    sessionId = running.id;
    await complete(admin, running.id, 1);
    await admin.beta.agents.sessions.events.create(running.id, { events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: 'Answer SECOND.' }] }] }] });
    await complete(admin, running.id, 2);
    await expect(traceReader.beta.agents.sessions.retrieve(running.id)).rejects.toMatchObject({ status: 403 });
    const page = await sessionTracePage(traceReader, running.id, { limit: 1, order: 'asc' });
    expect(page.data).toHaveLength(1); expect(page.has_more).toBe(true);
    expect(await sessionTracePage(reader, running.id, { limit: 1, order: 'asc' })).toEqual(page);
    const otlp = await exportSessionTraces(query => sessionTracePage(traceReader, running.id, query), { limit: 1 });
    const spans = otlp.resourceSpans.flatMap(resource => resource.scopeSpans.flatMap(scope => scope.spans));
    expect(new Set(spans.map(span => span.traceId)).size).toBe(2);
    expect(spans.some(span => span.attributes.some(attribute => attribute.key === 'gen_ai.operation.name' && 'stringValue' in attribute.value && attribute.value.stringValue === 'execute_tool'))).toBe(true);
    expect(JSON.stringify(otlp)).not.toContain(marker);
    for (const span of spans) { expect(span.traceId).toMatch(/^[a-f0-9]{32}$/); expect(span.spanId).toMatch(/^[a-f0-9]{16}$/); }
    if (process.env.AWS_E2E_OTLP_OUTPUT) {
      await promisify(execFile)(process.execPath, [resolve('dist/cli.mjs'), 'sessions', 'traces', running.id, '--output', process.env.AWS_E2E_OTLP_OUTPUT], { timeout: 60_000 });
      expect(JSON.parse(await readFile(process.env.AWS_E2E_OTLP_OUTPUT, 'utf8'))).toEqual(otlp);
    }
    if (process.env.AWS_E2E_OTLP_COLLECTOR_URL) {
      const response = await fetch(process.env.AWS_E2E_OTLP_COLLECTOR_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(otlp), signal: AbortSignal.timeout(10_000) });
      expect(response.status).toBe(200);
      const result = await response.json() as { partialSuccess?: { rejectedSpans?: number | string } };
      expect(Number(result.partialSuccess?.rejectedSpans ?? 0)).toBe(0);
    }
    await admin.beta.agents.sessions.delete(running.id); sessionId = undefined;
    await expect(sessionTracePage(traceReader, running.id)).rejects.toMatchObject({ status: 404 });
    console.log(JSON.stringify({ phase: 'scopes-models-traces-passed', sessionId: running.id, spanCount: spans.length }));
  } finally {
    try { if (sessionId) await admin.beta.agents.sessions.delete(sessionId); }
    finally { await admin.beta.agents.delete(agent.id); }
  }
}, timeoutMs * 3);

live('renews a narrowed grant at the client renewal boundary without widening it', async () => {
  let issuances = 0;
  const reader = createAgentsClient({ baseURL: required('RAT_THINGS_AGENTS_API_URL'), region: required('AWS_REGION'), scopes: ['api.agents.read'], fetch: async (input, init) => {
    const request = new Request(input, init);
    const response = await fetch(request);
    if (!request.url.endsWith('/v1/auth/tokens') || !response.ok) return response;
    const grant = await response.json() as { scopes: string[]; expires_at: number };
    expect(grant.scopes).toEqual(['api.agents.read']);
    issuances++;
    // Keep the real issued key. Advance only the client's renewal deadline;
    // this does not claim fifteen minutes of wall-clock expiration testing.
    return Response.json({ ...grant, ...(issuances === 1 ? { expires_at: Date.now() / 1000 + 1 } : {}) });
  } }).withOptions({ maxRetries: 0 });
  await reader.beta.agents.list();
  await reader.beta.agents.list();
  expect(issuances).toBe(2);
  await expect(reader.beta.agents.create({ model: required('AWS_E2E_CODEX_MODEL_ID') })).rejects.toMatchObject({ status: 403 });
}, 60_000);

async function complete(api: ReturnType<typeof client>, sessionId: string, count: number) {
  const deadline = Date.now() + timeoutMs;
  do {
    const turns = (await api.beta.agents.sessions.turns.list(sessionId)).data;
    if (turns.some(turn => turn.status === 'failed' || turn.status === 'cancelled')) throw new Error('Proof Turn failed');
    if (turns.filter(turn => turn.status === 'completed').length === count) return;
    await delay(2_000);
  } while (Date.now() < deadline);
  throw new Error('Proof Turn did not complete');
}
function required(name: string): string { const value = process.env[name]; if (!value) throw new Error(`${name} required`); return value; }
