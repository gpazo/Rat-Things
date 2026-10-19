import { describe, expect, it } from 'vitest';
import { MemoryAgentsStore } from '../agents/fixtures.js';
import { SessionRuntimeStore } from '../../src/core/session-runtime-store.js';
import { nativeDigest, planNativeCommit, planNativeReservation, type NativeCommit } from '../../src/core/session-native-store.js';

function frozen<T>(value: T): T {
  if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(frozen); }
  return value;
}
async function facts() {
  const store = new MemoryAgentsStore();
  const runtime = new SessionRuntimeStore(store, { now: () => 100 });
  await runtime.claim('owner', 'session', 'run', 1);
  const current = (await runtime.get('owner', 'session'))!;
  const change: NativeCommit = { schema: 1, commitId: 'commit', parent: null, seq: 1, idHighWater: 7, writes: [] };
  return frozen({ current, ownerId: 'owner', id: 'session:commit:commit', change, head: { seq: 1, commitId: 'commit', digest: nativeDigest(change) } });
}

describe('native storage decisions', () => {
  it('requests the immutable lookup only for an unattached commit with the current parent', async () => {
    const value = await facts();
    expect(planNativeCommit(value, { kind: 'unread' })).toEqual({ kind: 'read-existing' });
    const attached = { ...value, current: { ...value.current, value: { ...value.current.value, native: { schema: 1 as const, highWater: 7, head: value.head } } } };
    expect(planNativeCommit(frozen(attached), { kind: 'unread' })).toEqual({ kind: 'return', head: value.head });
    const wrong = planNativeCommit({ ...attached, head: { ...value.head, commitId: 'other' } }, { kind: 'unread' });
    expect(wrong.kind).toBe('reject');
    if (wrong.kind === 'reject') expect(wrong.error.message).toBe('Pi native ownership or head changed.');
  });

  it('constructs the conditional write and rejects a different immutable batch', async () => {
    const value = await facts();
    expect(planNativeCommit(value, { kind: 'read', value: undefined })).toEqual({ kind: 'write', head: value.head, writes: [
      { resource: { ownerId: 'owner', collection: 'session_native', id: 'session:commit:commit', createdAt: 0, revision: 1, value: value.change }, expectedRevision: 0 },
      { resource: { ...value.current, revision: value.current.revision + 1, value: { ...value.current.value, native: { schema: 1, highWater: 7, head: value.head } } }, expectedRevision: value.current.revision },
    ] });
    expect(planNativeCommit(value, { kind: 'read', value: { ...value.change, idHighWater: 8 } }).kind).toBe('reject');
    expect(value.current.value.native).toBeUndefined();
  });

  it('reuses matching reservations and rejects count conflicts or exhausted ID space', async () => {
    const { current } = await facts();
    const previous = frozen({ first: 2, last: 4, count: 3 });
    expect(planNativeReservation(current, 'owner', 'ids', 3, previous)).toEqual({ kind: 'return', value: previous });
    expect(planNativeReservation(current, 'owner', 'ids', 4, previous).kind).toBe('reject');
    const exhausted = planNativeReservation(frozen({ ...current, value: { ...current.value, native: { schema: 1, highWater: Number.MAX_SAFE_INTEGER } } }), 'owner', 'ids', 2, undefined);
    expect(exhausted.kind).toBe('reject');
    if (exhausted.kind === 'reject') expect(exhausted.error.message).toBe('ID space is exhausted');
    const planned = planNativeReservation(current, 'owner', 'ids', 3, undefined);
    expect(planned.kind).toBe('write');
    if (planned.kind === 'write') expect(planned.value).toEqual({ first: 2, last: 4, count: 3 });
  });
});
