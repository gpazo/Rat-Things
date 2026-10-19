import { describe, expect, it, vi } from 'vitest';
import { initialSessionRuntime } from '../../src/core/session-runtime-planning.js';
import { SessionRuntimeStore, type StoredSessionRuntime } from '../../src/core/session-runtime-store.js';
import { AgentsApiError, AgentsResourceConflictError } from '../../src/domain/agents-api-validation.js';
import { MemoryAgentsStore } from '../agents/fixtures.js';

const ownerId = 'owner';
const sessionId = 'session';
const runId = 'run';
const snapshot = initialSessionRuntime(sessionId, 'agent', 'root');
const head = (seq: number) => ({ seq, commitId: `commit-${seq}`, digest: 'a'.repeat(64) });
const runFenceChanges: Array<[string, (current: StoredSessionRuntime) => StoredSessionRuntime]> = [
  ['a replacement Run', current => ({ ...current, runId: 'replacement' })],
  ['closure', current => ({ ...current, runId: null, closed: true as const })],
];

async function fixture() {
  const store = new MemoryAgentsStore();
  await store.put({ ownerId, id: sessionId, collection: 'session_runtime', revision: 1, createdAt: 1,
    value: { runId, closed: false, native: { schema: 1, highWater: 10, head: head(3) }, projectionSeq: 2 } }, 0);
  return { store, runtime: new SessionRuntimeStore(store) };
}

function changeBeforeFirstProjectionWrite(
  store: MemoryAgentsStore,
  change: (current: StoredSessionRuntime) => StoredSessionRuntime,
): void {
  const get = store.get.bind(store);
  const put = store.put.bind(store);
  let changed = false;
  vi.spyOn(store, 'put').mockImplementation(async (resource, expectedRevision) => {
    if (!changed && resource.collection === 'session_runtime' && resource.id === sessionId) {
      changed = true;
      const current = await get<StoredSessionRuntime>(ownerId, 'session_runtime', sessionId);
      if (!current) throw new Error('runtime fixture disappeared');
      await put({ ...current, revision: current.revision + 1, value: change(current.value) }, current.revision);
    }
    await put(resource, expectedRevision);
  });
}

describe('native session projection publication', () => {
  it('returns false when a newer native head wins before the projection write', async () => {
    const f = await fixture();
    changeBeforeFirstProjectionWrite(f.store, current => ({ ...current, native: { ...current.native!, head: head(4) } }));

    await expect(f.runtime.publishNative(ownerId, sessionId, runId, 3, snapshot)).resolves.toBe(false);
    const saved = await f.runtime.get(ownerId, sessionId);
    expect(saved?.value.native?.head?.seq).toBe(4);
    expect(saved?.value.projectionSeq).toBe(2);
    expect(saved?.value.snapshot).toBeUndefined();
  });

  it('retries a confirmed revision conflict and preserves the fresh native high-water mark', async () => {
    const f = await fixture();
    changeBeforeFirstProjectionWrite(f.store, current => ({ ...current, native: { ...current.native!, highWater: 42 } }));

    await expect(f.runtime.publishNative(ownerId, sessionId, runId, 3, snapshot)).resolves.toBe(true);
    const saved = await f.runtime.get(ownerId, sessionId);
    expect(saved?.value.native).toEqual({ schema: 1, highWater: 42, head: head(3) });
    expect(saved?.value.projectionSeq).toBe(3);
    expect(saved?.value.snapshot).toEqual(snapshot);
  });

  it.each(runFenceChanges)('returns false after %s wins a projection race', async (_name, change) => {
    const f = await fixture();
    changeBeforeFirstProjectionWrite(f.store, change);

    await expect(f.runtime.publishNative(ownerId, sessionId, runId, 3, snapshot)).resolves.toBe(false);
    const saved = await f.runtime.get(ownerId, sessionId);
    expect(saved?.value.projectionSeq).toBe(2);
    expect(saved?.value.snapshot).toBeUndefined();
  });

  it('lets one same-sequence publisher win and treats the loser as already published', async () => {
    const f = await fixture();
    const get = f.store.get.bind(f.store);
    let readCount = 0;
    let release!: () => void;
    const bothRead = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(f.store, 'get').mockImplementation(async (...args) => {
      const resource = await get(...args);
      if (args[0] === ownerId && args[1] === 'session_runtime' && args[2] === sessionId && readCount < 2) {
        readCount++;
        if (readCount === 2) release();
        await bothRead;
      }
      return resource;
    });

    const outcomes = await Promise.all([
      f.runtime.publishNative(ownerId, sessionId, runId, 3, snapshot),
      f.runtime.publishNative(ownerId, sessionId, runId, 3, snapshot),
    ]);
    expect(outcomes.sort()).toEqual([false, true]);
    expect((await f.runtime.get(ownerId, sessionId))?.value.projectionSeq).toBe(3);
  });

  it('retries only ten confirmed resource conflicts before propagating the final one', async () => {
    const f = await fixture();
    const conflict = new AgentsResourceConflictError();
    const put = vi.spyOn(f.store, 'put').mockRejectedValue(conflict);

    await expect(f.runtime.publishNative(ownerId, sessionId, runId, 3, snapshot)).rejects.toBe(conflict);
    expect(put).toHaveBeenCalledTimes(10);
  });

  it.each([
    ['an ordinary API 409', new AgentsApiError(409, 'unrelated lifecycle conflict', 'conflict')],
    ['an S3 failure', new Error('S3 unavailable')],
  ])('propagates %s without retrying', async (_name, failure) => {
    const f = await fixture();
    const put = vi.spyOn(f.store, 'put').mockRejectedValue(failure);

    await expect(f.runtime.publishNative(ownerId, sessionId, runId, 3, snapshot)).rejects.toBe(failure);
    expect(put).toHaveBeenCalledOnce();
  });
});
