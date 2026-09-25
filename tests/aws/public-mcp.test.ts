import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { createAgentsClient } from '../../src/agents-client.js';

const live = process.env.AWS_E2E === 'true' && process.env.AWS_E2E_PUBLIC_MCP_PROOF === 'true' ? it : it.skip;
const timeoutMs = Number(process.env.AWS_E2E_TIMEOUT_MS ?? 420_000);

// OpenAI's documented public, read-only server. No customer credentials or writes.
live.each(['service', 'environment'] as const)('calls the public documentation MCP server from %s', async origin => {
  if (process.env.AWS_E2E_REAL_CODEX !== 'true') throw new Error('Public MCP validation requires explicit model opt-in');
  const client = createAgentsClient({ baseURL: required('RAT_THINGS_AGENTS_API_URL'), region: required('AWS_REGION') }).withOptions({ maxRetries: 0, timeout: 360_000 });
  const agent = await client.beta.agents.create({ model: required('AWS_E2E_CODEX_MODEL_ID'),
    tools: [{ type: 'mcp', server_label: 'openai_docs', connection_origin: origin, required: true,
      transport: { type: 'http', server_url: 'https://developers.openai.com/mcp' } }],
    instructions: 'Use the configured openai_docs MCP tools for this request. Do not answer from memory or use web search.' });
  let sessionId: string | undefined;
  try {
    const session = await client.beta.agents.sessions.create({ agent_id: agent.id,
      environment: origin === 'service' ? { type: 'none' }
        : { type: 'openai_hosted', network: { access: 'restricted', allowed_domains: ['developers.openai.com'] } },
      input: 'Search the official documentation for Agents API session continuation. Summarize one relevant result and include its source URL.' });
    sessionId = session.id;
    console.log(JSON.stringify({ phase: 'created', origin, sessionId }));
    const deadline = Date.now() + timeoutMs;
    let done = false;
    while (Date.now() < deadline) {
      const turn = (await client.beta.agents.sessions.turns.list(session.id)).data.find(value => value.subagent_id === null);
      if (turn && ['failed', 'cancelled'].includes(turn.status)) throw new Error(`MCP Turn ended ${turn.status}: ${turn.error?.code}`);
      if (turn?.status === 'completed') { done = true; break; }
      await delay(2000);
    }
    expect(done).toBe(true);
    expect((await client.beta.agents.sessions.retrieve(session.id)).required_actions).toEqual([]);
    const items = (await client.beta.agents.sessions.items.list(session.id, { limit: 100, order: 'asc' })).data;
    const calls = items.flatMap(item => item.type === 'mcp_call' && item.server_label === 'openai_docs' && item.status === 'completed' ? [item] : []);
    expect(calls.length).toBeGreaterThan(0);
    expect(JSON.stringify(calls.map(call => call.output))).toContain('developers.openai.com');
    expect(items.some(item => item.type === 'message' && item.role === 'assistant' && item.content.some(part => part.type === 'output_text' && part.text.includes('https://')))).toBe(true);
    console.log(JSON.stringify({ phase: 'completed', origin, sessionId, tools: calls.map(call => call.name) }));
  } finally {
    try { if (sessionId) await client.beta.agents.sessions.delete(sessionId); }
    finally { await client.beta.agents.delete(agent.id); }
  }
}, timeoutMs * 2);

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
