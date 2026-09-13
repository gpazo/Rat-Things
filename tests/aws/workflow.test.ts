import { randomUUID } from 'node:crypto';
import OpenAI, { toFile } from 'openai';
import { describe, expect, it } from 'vitest';
import { createAgentsClient } from '../../src/agents-client.js';
import { runQuickstartProof } from '../../scripts/agents-quickstart-proof.js';

const integration = process.env.AWS_E2E === 'true' ? describe : describe.skip;
const timeoutMs = Number(process.env.AWS_E2E_TIMEOUT_MS ?? 420_000);

integration('live AWS Agents API', () => {
  it('authenticates standard resources, retains binary Files, and completes two saved Turns', async () => {
    // Fail before any remote mutation if the live model probe was not explicitly enabled.
    if (process.env.AWS_E2E_REAL_CODEX !== 'true') throw new Error('Set AWS_E2E_REAL_CODEX=true to opt into the live Agents model probe');
    const baseURL = required('RAT_THINGS_AGENTS_API_URL');
    const client = createAgentsClient({ baseURL, region: required('AWS_REGION') }).withOptions({ maxRetries: 0, timeout: 30_000 });
    const marker = `agents-aws-${randomUUID()}`;
    const bytes = Buffer.from([0, 255, 128, 13, 10]);
    const file = await client.files.create({ file: await toFile(bytes, 'proof.bin'), purpose: 'user_data' });
    try {
      expect(Buffer.from(await (await client.files.content(file.id)).arrayBuffer())).toEqual(bytes);
      expect((await client.files.retrieve(file.id)).bytes).toBe(bytes.length);
      const anonymous = new OpenAI({ baseURL, apiKey: 'invalid', maxRetries: 0 });
      await expect(anonymous.files.retrieve(file.id)).rejects.toSatisfy((error: { status: number }) => [401, 403].includes(error.status));
    } finally { await client.files.delete(file.id); }
    await expect(client.files.retrieve(file.id)).rejects.toMatchObject({ status: 404 });
    const proof = await runQuickstartProof(client.beta.agents, { model: required('AWS_E2E_CODEX_MODEL_ID'), marker, timeoutMs });
    try {
      expect(proof.turns).toHaveLength(2);
      expect(new Set(proof.turns.map((turn) => turn.turnId)).size).toBe(2);
      expect(proof.turns.every((turn) => turn.status === 'completed')).toBe(true);
      await expect(client.beta.agents.sessions.retrieve(proof.sessionId)).rejects.toMatchObject({ status: 404 });
    } finally { await client.beta.agents.delete(proof.agentId); }
  }, timeoutMs * 2 + 120_000);
});

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for live AWS validation`);
  return value;
}
