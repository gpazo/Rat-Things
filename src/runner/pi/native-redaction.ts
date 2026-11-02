import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { applyImmutable, diffRevisions } from '@earendil-works/chord/delta';
import { MemoryStorage, type JsonObject, type Seq, type StorageWrite } from '@earendil-works/pi-durable';
import { nativeDigest, type NativeCommit, type NativeLease } from '../../core/session-native-store.js';
import { canonicalJson } from '../../domain/json.js';

type Redact = <T>(value: T) => T;
type DocumentChange = Extract<StorageWrite, { type: 'document.change' }>;
interface RedactionState {
  source: MemoryStorage;
  stored: MemoryStorage;
  receipt?: { requestDigest: string; change: NativeCommit };
}

function redactDocumentChange(write: DocumentChange, source: JsonObject, stored: JsonObject, redact: Redact): DocumentChange {
  const value = redact(write.content.kind === 'base' ? write.content.value : applyImmutable(source, write.content.ops));
  const base = { ...write, content: { kind: 'base' as const, version: write.content.version, value } };
  if (write.content.kind === 'base') return redact(base);
  const delta = { ...write, content: { kind: 'delta' as const, version: write.content.version, ops: diffRevisions(stored, value) } };
  return canonicalJson(redact(delta)) === canonicalJson(delta) ? delta : redact(base);
}

export function redactedNativeLease(lease: NativeLease, redact: Redact): NativeLease {
  let state: RedactionState | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(effect: () => Promise<T>): Promise<T> => {
    const next = queue.then(effect);
    queue = next.catch(() => undefined);
    return next;
  };
  const recover = async () => {
    const image = await lease.load();
    const recovered: RedactionState = { source: new MemoryStorage(), stored: new MemoryStorage() };
    for (const commit of image.commits) {
      recovered.source.prepareCommit(commit.writes as StorageWrite[], commit.seq as Seq).apply();
      recovered.stored.prepareCommit(commit.writes as StorageWrite[], commit.seq as Seq).apply();
    }
    state = recovered;
    return { image, state: recovered };
  };
  return {
    ...lease,
    load: () => serialize(async () => (await recover()).image),
    commit: change => serialize(async () => {
      const current = state ?? (await recover()).state;
      const requestDigest = nativeDigest(change);
      if (current.receipt?.requestDigest === requestDigest) return lease.commit(current.receipt.change);
      const source = current.source.prepareCommit(change.writes as StorageWrite[], change.seq as Seq);
      const writes = await Promise.all(source.writes.map(async write => {
        if (write.type !== 'document.change') return redact(write);
        const [before, stored] = await Promise.all([
          current.source.document(write.id, 'current', BACKGROUND_CONTEXT),
          current.stored.document(write.id, 'current', BACKGROUND_CONTEXT),
        ]);
        if (!before || !stored) throw new Error('Pi native document is missing');
        return redactDocumentChange(write, before.value, stored.value, redact);
      }));
      const stored = current.stored.prepareCommit(writes, change.seq as Seq);
      const persisted = { ...change, writes: stored.writes };
      const head = await lease.commit(persisted);
      source.apply();
      stored.apply();
      current.receipt = { requestDigest, change: persisted };
      return head;
    }),
  };
}
