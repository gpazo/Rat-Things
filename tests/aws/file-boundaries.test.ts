import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { toFile } from 'openai';
import { createAgentsClient } from '../../src/agents-client.js';

const live = process.env.AWS_E2E === 'true' && process.env.AWS_E2E_FILE_BOUNDARY_PROOF === 'true' ? it : it.skip;
const mib = 1024 * 1024;
const timeoutMs = Number(process.env.AWS_E2E_TIMEOUT_MS ?? 1_200_000);

live('accepts maximum inline inputs and preserves exact-limit immutable artifacts', async () => {
  if (process.env.AWS_E2E_REAL_CODEX !== 'true') throw new Error('File boundary proof requires explicit model opt-in');
  const client = createAgentsClient({ baseURL: required('RAT_THINGS_AGENTS_API_URL'), region: required('AWS_REGION') }).withOptions({ maxRetries: 0, timeout: timeoutMs });
  const agent = await client.beta.agents.create({ model: required('AWS_E2E_CODEX_MODEL_ID'), instructions: 'Execute the requested Python command exactly once, then return FILE_BOUNDARY_READY. Do not inspect file contents or use network tools.' });
  let sessionId: string | undefined;
  let fileId: string | undefined;
  const sizes = [200, 200, 100];
  try {
    const upload = await client.files.create({ file: await toFile(Buffer.alloc(50 * mib), 'boundary-input.bin'), purpose: 'user_data' });
    fileId = upload.id;
    const data = Buffer.alloc(5 * mib).toString('base64');
    const program = 'import os; assert os.path.getsize("/workspace/input-a.bin") == 5242880; assert os.path.getsize("/workspace/input-b.bin") == 5242880; assert len([p for p in os.listdir("/workspace") if p.startswith("empty-")]) == 47; assert os.path.getsize("/workspace/copied.bin") == 52428800; os.makedirs("/workspace/outputs", exist_ok=True);\nfor i, size in enumerate([200,200,100]):\n with open(f"/workspace/outputs/{i}.bin", "wb") as f: f.truncate(size*1024*1024)\nprint("FILE_BOUNDARY_READY")';
    const session = await client.beta.agents.sessions.create({ agent_id: agent.id,
      environment: { type: 'openai_hosted', network: { access: 'disabled' }, files: [
        { type: 'inline', path: '/workspace/input-a.bin', data }, { type: 'inline', path: '/workspace/input-b.bin', data },
        ...Array.from({ length: 47 }, (_, i) => ({ type: 'inline' as const, path: `/workspace/empty-${i}`, data: '' })),
        { type: 'file_id', path: '/workspace/copied.bin', file_id: fileId },
      ] }, input: `Run this Python program once using python3, preserving its indentation:\n${program}` });
    sessionId = session.id;
    console.log(JSON.stringify({ phase: 'created', sessionId }));
    const deadline = Date.now() + timeoutMs;
    let completed = false;
    while (Date.now() < deadline) {
      const root = (await client.beta.agents.sessions.turns.list(session.id)).data.find(turn => turn.subagent_id === null);
      if (root && ['failed', 'cancelled'].includes(root.status)) throw new Error(`Boundary Turn ended ${root.status}: ${root.error?.code}`);
      if (root?.status === 'completed') { completed = true; break; }
      await delay(2000);
    }
    expect(completed).toBe(true);
    const artifacts = (await client.beta.agents.sessions.artifacts.list(session.id)).data.sort((a, b) => a.path.localeCompare(b.path));
    expect(artifacts.map(artifact => artifact.size_bytes)).toEqual(sizes.map(size => size * mib));
    console.log(JSON.stringify({ phase: 'captured', sessionId, sizes: artifacts.map(artifact => artifact.size_bytes) }));
    const zero = Buffer.alloc(mib);
    for (const [index, artifact] of artifacts.entries()) {
      const response = await client.beta.agents.sessions.artifacts.content(artifact.id, { session_id: session.id });
      if (!response.body) throw new Error('Missing artifact content');
      const actual = createHash('sha256');
      let bytes = 0;
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) { actual.update(chunk); bytes += chunk.byteLength; }
      const expected = createHash('sha256');
      for (let block = 0; block < sizes[index]!; block++) expected.update(zero);
      expect(bytes).toBe(sizes[index]! * mib);
      expect(actual.digest('hex')).toBe(expected.digest('hex'));
    }
    await client.beta.agents.sessions.artifacts.delete(artifacts[0]!.id, { session_id: session.id });
    expect((await client.beta.agents.sessions.artifacts.list(session.id)).data).toHaveLength(2);
    if (session.environment.type !== 'openai_hosted') throw new Error('Missing hosted environment');
    const files = (await client.beta.agents.environments.files.list(session.environment.id, { path: '/workspace/outputs' })).data;
    expect(files).toContainEqual(expect.objectContaining({ path: '/workspace/outputs/0.bin', size_bytes: 200 * mib }));
    console.log(JSON.stringify({ phase: 'completed', sessionId, downloadedBytes: 500 * mib }));
  } finally {
    try { if (sessionId) await client.withOptions({ maxRetries: 2 }).beta.agents.sessions.delete(sessionId); }
    finally {
      try { await client.beta.agents.delete(agent.id); }
      finally { if (fileId) await client.files.delete(fileId); }
    }
  }
}, timeoutMs * 2);

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
