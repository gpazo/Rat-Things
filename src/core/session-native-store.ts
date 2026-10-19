import { createHash } from 'node:crypto';
import { AgentsApiError } from '../domain/agents-api-validation.js';
import { canonicalJson } from '../domain/json.js';
import type { AgentResource, AgentsStore } from './agents-ports.js';
import type { StoredSessionRuntime } from './session-runtime-store.js';

export interface NativeHead { seq: number; commitId: string; digest: string }
export interface NativeCommit { schema: 1; commitId: string; parent: NativeHead | null; seq: number; idHighWater: number; writes: readonly unknown[] }
export interface NativeImage { head: NativeHead | null; highWater: number; commits: NativeCommit[] }
export interface NativeLease {
  load(): Promise<NativeImage>;
  reserveIds(count: number, requestId: string): Promise<{ first: number; last: number }>;
  commit(change: NativeCommit): Promise<NativeHead>;
  assertActive(): Promise<void>;
}

export function nativeDigest(change: NativeCommit): string { return createHash('sha256').update(canonicalJson(change)).digest('hex'); }
const conflict = () => new AgentsApiError(409, 'Pi native ownership or head changed.', 'native_conflict');

type NativeWrites = Parameters<AgentsStore['commit']>[0];
export interface NativeReservation { first: number; last: number; count: number }
export type NativeReservationDecision =
  | { kind: 'return'; value: NativeReservation }
  | { kind: 'write'; value: NativeReservation; writes: NativeWrites }
  | { kind: 'reject'; error: Error };
export type NativeCommitDecision =
  | { kind: 'return'; head: NativeHead }
  | { kind: 'read-existing' }
  | { kind: 'write'; head: NativeHead; writes: NativeWrites }
  | { kind: 'reject'; error: Error };

const immutable = <T>(ownerId: string, id: string, value: T): AgentResource<T> => ({ ownerId, collection: 'session_native', id, createdAt: 0, revision: 1, value });

export function planNativeReservation(current: AgentResource<StoredSessionRuntime>, ownerId: string, id: string, count: number, previous: NativeReservation | undefined): NativeReservationDecision {
  if (previous) return previous.count === count ? { kind: 'return', value: previous } : { kind: 'reject', error: conflict() };
  const first = (current.value.native?.highWater ?? 1) + 1;
  const last = first + count - 1;
  if (!Number.isSafeInteger(last)) return { kind: 'reject', error: new Error('ID space is exhausted') };
  const value = { first, last, count };
  return { kind: 'write', value, writes: [
    { resource: immutable(ownerId, id, value), expectedRevision: 0 },
    { resource: { ...current, revision: current.revision + 1, value: { ...current.value, native: { ...current.value.native, schema: 1, highWater: last } } }, expectedRevision: current.revision },
  ] };
}

interface NativeCommitFacts { current: AgentResource<StoredSessionRuntime>; ownerId: string; id: string; change: NativeCommit; head: NativeHead }
export function planNativeCommit(facts: NativeCommitFacts, existing: { kind: 'read'; value: NativeCommit | undefined }): Exclude<NativeCommitDecision, { kind: 'read-existing' }>;
export function planNativeCommit(facts: NativeCommitFacts, existing: { kind: 'unread' }): NativeCommitDecision;
export function planNativeCommit({ current, ownerId, id, change, head }: NativeCommitFacts,
  existing: { kind: 'unread' } | { kind: 'read'; value: NativeCommit | undefined }): NativeCommitDecision {
  const attached = current.value.native?.head ?? null;
  if (canonicalJson(attached) === canonicalJson(head)) return { kind: 'return', head };
  if (canonicalJson(attached) !== canonicalJson(change.parent)) return { kind: 'reject', error: conflict() };
  if (existing.kind === 'unread') return { kind: 'read-existing' };
  if (existing.value && nativeDigest(existing.value) !== head.digest) return { kind: 'reject', error: conflict() };
  return { kind: 'write', head, writes: [
    ...existing.value ? [] : [{ resource: immutable(ownerId, id, change), expectedRevision: 0 }],
    { resource: { ...current, revision: current.revision + 1, value: { ...current.value, native: { schema: 1, highWater: Math.max(current.value.native?.highWater ?? 1, change.idHighWater), head } } }, expectedRevision: current.revision },
  ] };
}

export function nativeLease(store: AgentsStore, ownerId: string, sessionId: string, runId: string, epoch: number): NativeLease {
  const resourceId = (type: string, id: string) => `${sessionId}:${type}:${id}`;
  const active = async () => {
    const current = await store.get<StoredSessionRuntime>(ownerId, 'session_runtime', sessionId);
    if (!current || current.value.closed || current.value.runId !== runId || (current.value.epoch ?? 0) !== epoch) throw conflict();
    return current;
  };
  let queue: Promise<unknown> = Promise.resolve();
  const serialized = <T>(effect: () => Promise<T>): Promise<T> => {
    const next = queue.then(effect);
    queue = next.catch(() => undefined);
    return next;
  };
  return {
    assertActive: async () => { await active(); },
    load: async () => {
      const current = await active();
      const head = current.value.native?.head ?? null;
      const commits: NativeCommit[] = [];
      let cursor = head;
      while (cursor) {
        const found = await store.get<NativeCommit>(ownerId, 'session_native', resourceId('commit', cursor.commitId));
        if (!found || found.value.seq !== cursor.seq || found.value.schema !== 1 || nativeDigest(found.value) !== cursor.digest) throw new Error('Pi native history is corrupt');
        commits.push(found.value);
        const parent = found.value.parent;
        if (parent && parent.seq >= cursor.seq) throw new Error('Pi native history is not monotonic');
        cursor = parent;
      }
      return { head, highWater: current.value.native?.highWater ?? 1, commits: commits.reverse() };
    },
    reserveIds: (count, requestId) => serialized(async () => {
      if (!Number.isSafeInteger(count) || count < 1 || count > 65_536 || !/^[a-zA-Z0-9_-]{1,128}$/.test(requestId)) throw new Error('Invalid native ID reservation');
      const id = resourceId('ids', `${runId}:${epoch}:${requestId}`);
      for (let attempt = 0; attempt < 4; attempt++) {
        const current = await active();
        const previous = await store.get<NativeReservation>(ownerId, 'session_native', id);
        const plan = planNativeReservation(current, ownerId, id, count, previous?.value);
        if (plan.kind === 'reject') throw plan.error;
        if (plan.kind === 'return') return plan.value;
        try {
          await store.commit(plan.writes);
          return plan.value;
        } catch (error) { if (attempt === 3) throw error; }
      }
      throw conflict();
    }),
    commit: change => serialized(async () => {
      if (!Number.isSafeInteger(change.idHighWater) || change.idHighWater < 1 || change.schema !== 1 || !Number.isSafeInteger(change.seq) || change.seq !== (change.parent?.seq ?? 0) + 1 || !/^[a-zA-Z0-9_-]{1,128}$/.test(change.commitId)) throw new Error('Invalid native commit');
      if (Buffer.byteLength(canonicalJson(change)) > 4 * 1024 * 1024) throw new Error('Native commit exceeds 4 MiB');
      const digest = nativeDigest(change);
      const head = { seq: change.seq, commitId: change.commitId, digest };
      const id = resourceId('commit', change.commitId);
      for (let attempt = 0; attempt < 4; attempt++) {
        const current = await active();
        let plan = planNativeCommit({ current, ownerId, id, change, head }, { kind: 'unread' });
        if (plan.kind === 'read-existing') {
          const existing = await store.get<NativeCommit>(ownerId, 'session_native', id);
          plan = planNativeCommit({ current, ownerId, id, change, head }, { kind: 'read', value: existing?.value });
        }
        if (plan.kind === 'reject') throw plan.error;
        if (plan.kind === 'return') return plan.head;
        try {
          await store.commit(plan.writes);
          return plan.head;
        } catch (error) { if (attempt === 3) throw error; }
      }
      throw conflict();
    }),
  };
}
