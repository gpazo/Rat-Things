import { createHash, randomUUID } from 'node:crypto';
import { toFile } from 'openai';
import { describe, expect, it } from 'vitest';
import { createAgentsClient } from '../../src/agents-client.js';

const live = process.env.AWS_E2E === 'true' ? describe : describe.skip;

live('live Agents Web Function transport', () => {
  it('round-trips a File through the advertised API', async () => {
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


});

function liveClient() {
  if (process.env.AWS_E2E !== 'true') throw new Error('Set AWS_E2E=true before live AWS mutations');
  const baseURL = required('RAT_THINGS_AGENTS_API_URL');
  const endpoint = new URL(baseURL);
  if (endpoint.protocol !== 'https:' || !endpoint.hostname.endsWith(`.lambda-web.${required('AWS_REGION')}.on.aws`)
    || endpoint.pathname !== '/v1' || endpoint.port || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('The live transport probe requires the regional Web Function endpoint');
  }
  return createAgentsClient({ baseURL, region: required('AWS_REGION') }).withOptions({ maxRetries: 0, timeout: 360_000 });
}
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for live AWS validation`);
  return value;
}
