import { createHash, randomUUID } from 'node:crypto';
import { toFile } from 'openai';
import { describe, expect, it } from 'vitest';
import { createAgentsClient } from '../../src/agents-client.js';

const dedicated = process.env.AWS_E2E === 'true' && Boolean(process.env.AWS_E2E_ENVIRONMENT_RELAY_ORIGIN_HOSTNAME)
  ? describe : describe.skip;

dedicated('live dedicated Agents HTTPS transport', () => {
  it('round-trips a File larger than the Lambda request limit through the advertised API', async () => {
    const client = liveClient().withOptions({ timeout: 900_000 });
    const mebibytes = Number(process.env.AWS_E2E_LARGE_FILE_MIB ?? 8);
    if (!Number.isInteger(mebibytes) || mebibytes < 8 || mebibytes > 512) {
      throw new Error('AWS_E2E_LARGE_FILE_MIB must be an integer from 8 through 512');
    }
    const data = Buffer.alloc(mebibytes * 1024 * 1024, 213);
    // Distinct leading/trailing bytes detect truncation and accidental text decoding.
    data.write(randomUUID());
    data.set([0, 255, 128, 13, 10], data.length - 5);
    const expected = createHash('sha256').update(data).digest('hex');
    const file = await client.files.create({ file: await toFile(data, 'large-proof.bin'), purpose: 'user_data' });
    try {
      expect(file.bytes).toBe(data.length);
      const response = await client.files.content(file.id);
      if (!response.body) throw new Error('File content has no response body');
      const hash = createHash('sha256');
      let bytes = 0;
      const reader = response.body.getReader();
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          hash.update(chunk.value);
        }
      } finally { reader.releaseLock(); }
      expect(bytes).toBe(data.length);
      expect(hash.digest('hex')).toBe(expected);
    } finally { await client.files.delete(file.id); }
    await expect(client.files.retrieve(file.id)).rejects.toMatchObject({ status: 404 });
  }, 900_000);

  it('keeps SSE open while input waits for the full disconnected-environment deadline', async () => {
    const client = liveClient();
    const session = await client.beta.agents.sessions.create({
      agent: { model: required('AWS_E2E_CODEX_MODEL_ID'), tools: [] },
      environment: { type: 'self_hosted', workspace_directory: '/workspace' },
    });
    const abort = new AbortController();
    let consume: Promise<void> | undefined;
    let streamEnded = false;
    let streamError: unknown;
    try {
      const stream = await client.beta.agents.sessions.events.stream(session.id, { signal: abort.signal });
      consume = (async () => {
        try { for await (const _event of stream) { /* Hold a real subscription across the wait. */ } }
        catch (error) { if (!abort.signal.aborted) streamError = error; }
        finally { streamEnded = true; }
      })();
      const started = performance.now();
      await expect(client.beta.agents.sessions.events.create(session.id, {
        'Idempotency-Key': randomUUID(),
        events: [{ type: 'agent.session.input.message', input: [
          { role: 'user', content: [{ type: 'input_text', text: 'Do not execute without the requested environment.' }] },
        ] }],
      })).rejects.toMatchObject({ status: 408, code: 'environment_connection_timeout' });
      const elapsed = performance.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(295_000);
      expect(elapsed).toBeLessThan(340_000);
      expect(streamError).toBeUndefined();
      expect(streamEnded).toBe(false);
      const turns = await client.beta.agents.sessions.turns.list(session.id);
      expect(turns.data).toHaveLength(1);
      expect(turns.data[0]?.status).not.toBe('completed');
    } finally {
      abort.abort();
      await consume;
      await client.beta.agents.sessions.delete(session.id);
    }
  }, 390_000);
});

function liveClient() {
  if (process.env.AWS_E2E_REAL_CODEX !== 'true') throw new Error('Set AWS_E2E_REAL_CODEX=true before live AWS mutations');
  const baseURL = required('RAT_THINGS_AGENTS_API_URL');
  const expectedHostname = required('AWS_E2E_ENVIRONMENT_RELAY_ORIGIN_HOSTNAME');
  if (new URL(baseURL).hostname !== expectedHostname) throw new Error('The live transport probe requires the dedicated API hostname');
  return createAgentsClient({ baseURL, region: required('AWS_REGION') }).withOptions({ maxRetries: 0, timeout: 360_000 });
}
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for live AWS validation`);
  return value;
}
