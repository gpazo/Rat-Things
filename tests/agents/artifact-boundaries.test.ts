import { expect, it, vi } from 'vitest';
import { SessionArtifactCapture } from '../../src/core/session-artifact-capture.js';
import { initialSessionRuntime, type SessionRuntimeState } from '../../src/core/session-runtime-planning.js';
import { sessionAgent } from '../../src/core/session-planning.js';

const mib = 1024 * 1024;
const completed: SessionRuntimeState = { ...initialSessionRuntime('session', 'agent', 'root'), turns: [{
  threadId: 'root', nativeTurnId: 'native', items: [], turn: {
    id: 'turn', object: 'agent.session.turn', session_id: 'session', agent_id: 'agent', subagent_id: null,
    status: 'completed', created_at: 1, started_at: 1, completed_at: 2, usage: null, error: null,
  },
}] };

function fixture(sizes: number[], changedVersion = false) {
  const entries = sizes.map((size_bytes, index) => ({ path: `/workspace/outputs/${index}.bin`, size_bytes }));
  const chunk = Buffer.alloc(mib, 0x5a).toString('base64');
  // Retain bounded write metadata, not the captured payload buffers.
  const writes: number[] = [];
  const read = vi.fn((path: string, offset: number, length: number) => {
    const entry = entries.find(entry => entry.path === path)!;
    const count = Math.min(length, entry.size_bytes - offset);
    return { ...entry, version: changedVersion && offset > 0 ? 'changed' : 'original',
      data: count === mib ? chunk : Buffer.alloc(count, 0x5a).toString('base64') };
  });
  const capture = new SessionArtifactCapture({ ownerId: 'alice',
    launch: { sessionId: 'session', turnId: 'turn', input: [], agent: sessionAgent({ model: 'fixture' }, 'agent', 1),
      environment: { type: 'openai_hosted', id: 'env', capability_directories: [], files: [], plugins: [], skills: [], network: { access: 'disabled', allowed_domains: [] }, packages: { npm: [], python: [], system: [] } } },
    files: { execute: async (_id, _secret, operation) => {
      if (operation.operation === 'list') return entries;
      if (operation.operation !== 'read') throw new Error('Unexpected file operation');
      return read(operation.path, operation.offset, operation.length);
    } },
    artifacts: { putBytes: async (key, bytes, contentType) => {
      writes.push(bytes.byteLength);
      return { bucket: 'private', key, contentType, bytes: bytes.byteLength, sha256: 'fixture' };
    } },
  });
  return { capture, read, writes };
}

it('captures the exact 200 MiB per-file and 500 MiB aggregate boundaries in bounded reads', async () => {
  const { capture, read, writes } = fixture([200 * mib, 200 * mib, 100 * mib]);
  const before = structuredClone(completed);
  const saved = await capture.capture(completed);
  expect(writes).toEqual([200 * mib, 200 * mib, 100 * mib]);
  expect(saved.turns[0]?.artifacts?.map(value => value.artifact.size_bytes)).toEqual(writes);
  expect(read).toHaveBeenCalledTimes(500);
  expect(completed).toEqual(before);
  expect(await capture.capture(completed)).toEqual(saved);
  expect(writes).toHaveLength(3);
}, 30_000);

it.each([
  [200 * mib + 1],
  [200 * mib, 200 * mib, 100 * mib + 1],
  [-1], [0.5], [NaN], [Infinity],
])('rejects invalid published output sizes %j before content reads or writes', async (...sizes) => {
  const { capture, read, writes } = fixture(sizes);
  await expect(capture.capture(completed)).rejects.toThrow();
  expect(read).not.toHaveBeenCalled();
  expect(writes).toEqual([]);
});

it('keeps an empty output as a zero-byte immutable artifact', async () => {
  const { capture, writes } = fixture([0]);
  const saved = await capture.capture(completed);
  expect(writes).toEqual([0]);
  expect(saved.turns[0]?.artifacts?.[0]?.artifact.size_bytes).toBe(0);
});

it('does not publish bytes assembled from two file versions', async () => {
  const { capture, read, writes } = fixture([mib + 1], true);
  await expect(capture.capture(completed)).rejects.toThrow('Output file changed');
  expect(read).toHaveBeenCalledTimes(2);
  expect(writes).toEqual([]);
});
