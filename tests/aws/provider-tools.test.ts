import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { createAgentsClient } from '../../src/agents-client.js';
import type { PersistedAgentToolParam } from '../../src/domain/agents-api.js';

const live = process.env.AWS_E2E === 'true' && process.env.AWS_E2E_PROVIDER_PROOF === 'true' ? it : it.skip;
const timeoutMs = Number(process.env.AWS_E2E_TIMEOUT_MS ?? 420_000);

live.each(['direct', 'programmatic', 'deferred'] as const)('completes a live %s function round trip with saved public output', async mode => {
  const client = liveClient();
  const marker = `provider-result-${randomUUID()}`;
  const tools: PersistedAgentToolParam[] = [
    { type: 'function', name: 'lookup_proof_token', description: 'Return the private proof token for the requested key.',
      defer_loading: mode === 'deferred', parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false } },
    ...(mode === 'programmatic' ? [{ type: 'programmatic_tool_calling' as const, enabled: true }] : []),
    ...(mode === 'deferred' ? [{ type: 'tool_search' as const }] : []),
  ];
  const agent = await client.beta.agents.create({ model: required('AWS_E2E_CODEX_MODEL_ID'), tools,
    instructions: 'Use the requested application tool exactly once. Return its token verbatim. Do not invent a token.' });
  let sessionId: string | undefined;
  try {
    const session = await client.beta.agents.sessions.create({ agent_id: agent.id, environment: { type: 'none' },
      input: `${mode === 'programmatic' ? 'Use programmatic tool calling to' : mode === 'deferred' ? 'Discover the application lookup tool with tool search, then' : 'Please'} call lookup_proof_token with key "proof". Return the token supplied by that tool.` });
    sessionId = session.id;
    console.log(JSON.stringify({ phase: 'created', mode, sessionId }));
    let action: { turn_id: string; call_id: string; name: string; arguments: unknown } | undefined;
    await eventually(async () => {
      const saved = await client.beta.agents.sessions.retrieve(session.id);
      action = saved.required_actions.find(value => value.type === 'function_call');
      const turns = (await client.beta.agents.sessions.turns.list(session.id)).data;
      const terminal = turns.find(turn => ['completed', 'failed', 'cancelled'].includes(turn.status));
      if (terminal && !action) throw new Error(`Provider finished before the function request: ${terminal.status}/${terminal.error?.code}`);
      return Boolean(action);
    });
    expect(action).toMatchObject({ name: 'lookup_proof_token', arguments: { key: 'proof' } });
    await client.beta.agents.sessions.events.create(session.id, { events: [{ type: 'agent.session.input.tool_result',
      turn_id: action!.turn_id, call_id: action!.call_id, success: true, output: marker }] });
    await completed(client, session.id);
    expect((await client.beta.agents.sessions.retrieve(session.id)).required_actions).toEqual([]);
    const items = (await client.beta.agents.sessions.items.list(session.id, { limit: 100, order: 'asc' })).data;
    expect(items.filter(item => item.type === 'function_call' && item.call_id === action!.call_id)).toHaveLength(1);
    const results = items.filter(item => item.type === 'function_call_output' && item.call_id === action!.call_id);
    expect(results).toHaveLength(1);
    expect(JSON.stringify(results)).toContain(marker);
    expect(items.some(item => item.type === 'message' && item.role === 'assistant' && item.content.some(part => part.type === 'output_text' && part.text.includes(marker)))).toBe(true);
    console.log(JSON.stringify({ phase: 'completed', mode, sessionId }));
  } finally {
    try { if (sessionId) await client.withOptions({ maxRetries: 2 }).beta.agents.sessions.delete(sessionId); }
    finally { await client.beta.agents.delete(agent.id); }
  }
}, timeoutMs * 2);

live('executes declared live web search and saves its public call', async () => {
  const client = liveClient();
  const agent = await client.beta.agents.create({ model: required('AWS_E2E_CODEX_MODEL_ID'),
    tools: [{ type: 'web_search', mode: 'live', allowed_domains: ['openai.com'] }],
    instructions: 'Perform the requested web search and briefly report what the official page says.' });
  let sessionId: string | undefined;
  try {
    const session = await client.beta.agents.sessions.create({ agent_id: agent.id, environment: { type: 'none' },
      input: 'Use web search to find the official OpenAI ChatGPT overview page and summarize it in one sentence. Do not answer from memory.' });
    sessionId = session.id;
    console.log(JSON.stringify({ phase: 'created', mode: 'web_search', sessionId }));
    await completed(client, session.id);
    const items = (await client.beta.agents.sessions.items.list(session.id, { limit: 100, order: 'asc' })).data;
    expect(items).toContainEqual(expect.objectContaining({ type: 'web_search_call', status: 'completed' }));
    expect(items.some(item => item.type === 'message' && item.role === 'assistant' && item.content.some(part => part.type === 'output_text' && part.text.trim()))).toBe(true);
    console.log(JSON.stringify({ phase: 'completed', mode: 'web_search', sessionId }));
  } finally {
    try { if (sessionId) await client.withOptions({ maxRetries: 2 }).beta.agents.sessions.delete(sessionId); }
    finally { await client.beta.agents.delete(agent.id); }
  }
}, timeoutMs);

function liveClient() {
  if (process.env.AWS_E2E_REAL_CODEX !== 'true') throw new Error('Live provider validation requires explicit model opt-in');
  return createAgentsClient({ baseURL: required('RAT_THINGS_AGENTS_API_URL'), region: required('AWS_REGION') }).withOptions({ maxRetries: 0, timeout: 360_000 });
}
async function completed(client: ReturnType<typeof liveClient>, id: string) {
  await eventually(async () => {
    const turn = (await client.beta.agents.sessions.turns.list(id)).data.find(value => value.subagent_id === null);
    if (turn && ['failed', 'cancelled'].includes(turn.status)) throw new Error(`Provider Turn ended ${turn.status}: ${turn.error?.code}`);
    return turn?.status === 'completed';
  });
}
async function eventually(predicate: () => Promise<boolean>) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(2000); }
  throw new Error('Provider proof did not settle before its deadline');
}
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
