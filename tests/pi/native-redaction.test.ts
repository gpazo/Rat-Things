import { describe, expect, it } from 'vitest';
import { MemoryStorage, ROOT_CONVERSATION_ID, type DocumentId, type Seq, type StorageWrite } from '@earendil-works/pi-durable';
import { registerStorageConformance } from '@earendil-works/pi-durable/testing';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { track } from '@earendil-works/chord/delta';
import { createOutputRedactor } from '../../src/core/output-redactor.js';
import { nativeDigest, nativeLease, type NativeCommit, type NativeHead } from '../../src/core/session-native-store.js';
import { SessionRuntimeStore } from '../../src/core/session-runtime-store.js';
import { openPiStorage } from '../../src/runner/pi/storage.js';
import { redactedNativeLease } from '../../src/runner/pi/native-redaction.js';
import { MemoryAgentsStore } from '../agents/fixtures.js';

const secret = 'planted-private-token';
const documentId = 2 as DocumentId;

async function fixture() {
  const store = new MemoryAgentsStore();
  await new SessionRuntimeStore(store).claim('owner', 'session', 'run', 1);
  const native = nativeLease(store, 'owner', 'session', 'run', 0);
  const redact = createOutputRedactor([secret]);
  const lease = redactedNativeLease(native, redact);
  return { store, native, lease, redact, storage: await openPiStorage(lease) };
}

registerStorageConformance({ describe, expect, it }, 'Redacted Pi native storage conformance', async use => {
  const f = await fixture();
  try { await use(f.storage); } finally { await f.storage.close(context); }
});

describe('Pi native document redaction', () => {
  it('redacts a credential split across Chord appends before persisting replayable document history', async () => {
    const f = await fixture();
    const document = track({ output: '' });
    await f.storage.commit([
      { type: 'conversation', value: { id: ROOT_CONVERSATION_ID } },
      { type: 'document.create', record: { id: documentId, kind: 'stream', scope: { kind: 'conversation', conversationId: ROOT_CONVERSATION_ID }, history: 'rewindable', fork: 'asOf' }, content: { kind: 'base', version: 1, value: document.value } },
    ], context);
    for (const chunk of ['planted', '-private', '-token']) {
      const change = document.beginChange();
      change.state.output += chunk;
      const prepared = change.prepare();
      expect(prepared.ops).toEqual([['a', ['output'], chunk]]);
      await f.storage.commit([{ type: 'document.change', id: documentId, content: { kind: 'delta', version: 1, ops: prepared.ops } }], context);
      document.adopt(prepared);
    }
    expect((await f.storage.document(documentId, 'current', context))?.value.output).toBe(secret);
    const image = await f.native.load();
    const replay = new MemoryStorage();
    let parent: NativeHead | null = null;
    for (const commit of image.commits) {
      expect(commit.parent).toEqual(parent);
      parent = { seq: commit.seq, commitId: commit.commitId, digest: nativeDigest(commit) };
      expect(JSON.stringify(commit)).not.toContain(secret);
      replay.prepareCommit(commit.writes as StorageWrite[], commit.seq as Seq).apply();
      expect(JSON.stringify((await replay.document(documentId, 'current', context))?.value)).not.toContain(secret);
    }
    expect(image.head).toEqual(parent);
    expect((await replay.document(documentId, 'current', context))?.value).toEqual({ output: '[REDACTED]' });
    for (const commit of image.commits) expect(JSON.stringify((await replay.document(documentId, commit.seq as Seq, context))?.value)).not.toContain(secret);
    expect(JSON.stringify([...f.store.resources.values()])).not.toContain(secret);
  });

  it('rebuilds later operations against the raw document and resumes from the redacted persisted document', async () => {
    const f = await fixture();
    const document = track({ output: secret });
    await f.storage.commit([{ type: 'document.create', record: { id: documentId, kind: 'stream', scope: { kind: 'session' } }, content: { kind: 'base', version: 1, value: document.value } }], context);
    const change = document.beginChange();
    change.state.output = change.state.output.slice(0, 3) + ' ordinary text';
    const prepared = change.prepare();
    await f.storage.commit([{ type: 'document.change', id: documentId, content: { kind: 'delta', version: 1, ops: prepared.ops } }], context);
    document.adopt(prepared);
    const recovered = await openPiStorage(redactedNativeLease(f.native, f.redact));
    const restored = (await recovered.document(documentId, 'current', context))!;
    expect(restored.value).toEqual(document.value);
    const continuation = track(restored.value);
    const next = continuation.beginChange();
    next.state.output += ' after restart';
    const nextPrepared = next.prepare();
    await recovered.commit([{ type: 'document.change', id: documentId, content: { kind: 'delta', version: 1, ops: nextPrepared.ops } }], context);
    const replay = await openPiStorage(f.native);
    expect((await replay.document(documentId, 'current', context))?.value).toEqual({ output: 'pla ordinary text after restart' });
    expect(JSON.stringify((await f.native.load()).commits)).not.toContain(secret);
  });

  it('redacts a credential that finishes streaming after recovery', async () => {
    const f = await fixture();
    await f.storage.commit([{ type: 'document.create', record: { id: documentId, kind: 'stream', scope: { kind: 'session' } }, content: { kind: 'base', version: 1, value: { output: 'planted' } } }], context);
    const recovered = await openPiStorage(redactedNativeLease(f.native, f.redact));
    const document = track((await recovered.document(documentId, 'current', context))!.value);
    for (const chunk of ['-private', '-token']) {
      const change = document.beginChange();
      change.state.output += chunk;
      const prepared = change.prepare();
      await recovered.commit([{ type: 'document.change', id: documentId, content: { kind: 'delta', version: 1, ops: prepared.ops } }], context);
      document.adopt(prepared);
    }
    const replay = await openPiStorage(f.native);
    expect((await replay.document(documentId, 'current', context))?.value).toEqual({ output: '[REDACTED]' });
    expect(JSON.stringify((await f.native.load()).commits)).not.toContain(secret);
  });

  it('keeps document paths consistent when redacted object keys collide or are removed', async () => {
    const f = await fixture();
    const document = track<Record<string, { value: string }>>({ [secret]: { value: secret }, '[REDACTED]': { value: 'safe' } });
    await f.storage.commit([{ type: 'document.create', record: { id: documentId, kind: 'keys', scope: { kind: 'session' } }, content: { kind: 'base', version: 1, value: document.value } }], context);
    const change = document.beginChange();
    change.state[secret]!.value += ' appended';
    const prepared = change.prepare();
    await f.storage.commit([{ type: 'document.change', id: documentId, content: { kind: 'delta', version: 1, ops: prepared.ops } }], context);
    document.adopt(prepared);
    const firstReplay = await openPiStorage(f.native);
    expect((await firstReplay.document(documentId, 'current', context))?.value).toEqual({ '[REDACTED]': { value: '[REDACTED] appended' }, '[REDACTED][1]': { value: 'safe' } });
    const removal = document.beginChange();
    delete removal.state[secret];
    const removed = removal.prepare();
    await f.storage.commit([{ type: 'document.change', id: documentId, content: { kind: 'delta', version: 1, ops: removed.ops } }], context);
    const replay = await openPiStorage(f.native);
    expect((await replay.document(documentId, 'current', context))?.value).toEqual({ '[REDACTED]': { value: 'safe' } });
    expect(JSON.stringify((await f.native.load()).commits)).not.toContain(secret);
  });

  it('uses a redacted base when a newly learned credential would appear in a delta path', async () => {
    const f = await fixture();
    const refreshed = 'refreshed-private-token';
    await f.storage.commit([{ type: 'document.create', record: { id: documentId, kind: 'keys', scope: { kind: 'session' } }, content: { kind: 'base', version: 1, value: { [refreshed]: 'before' } } }], context);
    f.redact.remember([refreshed]);
    await f.storage.commit([{ type: 'document.change', id: documentId, content: { kind: 'delta', version: 1, ops: [['s', [refreshed], 'after']] } }], context);
    const image = await f.native.load();
    expect(JSON.stringify(image.commits.at(-1))).not.toContain(refreshed);
    expect(image.commits.at(-1)?.writes).toEqual([{ type: 'document.change', id: documentId, content: { kind: 'base', version: 1, value: { '[REDACTED]': 'after' } } }]);
    const replay = await openPiStorage(f.native);
    expect((await replay.document(documentId, 'current', context))?.value).toEqual({ '[REDACTED]': 'after' });
  });

  it('reconciles a lost commit acknowledgment and keeps repeated commits idempotent', async () => {
    const f = await fixture();
    await f.storage.commit([{ type: 'document.create', record: { id: documentId, kind: 'stream', scope: { kind: 'session' } }, content: { kind: 'base', version: 1, value: { output: 'planted' } } }], context);
    let lose = true;
    const lease = redactedNativeLease({ ...f.native, commit: async change => {
      const head = await f.native.commit(change);
      if (lose) { lose = false; throw new Error('lost acknowledgment'); }
      return head;
    } }, f.redact);
    const image = await lease.load();
    const change: NativeCommit = { schema: 1, commitId: 'retry', seq: 2, parent: image.head, idHighWater: 2,
      writes: [{ type: 'document.change', id: documentId, content: { kind: 'delta', version: 1, ops: [['a', ['output'], '-private-token']] } } satisfies StorageWrite],
    };
    await expect(lease.commit(change)).rejects.toThrow('lost acknowledgment');
    const head = await lease.commit(change);
    expect(await lease.commit(change)).toEqual(head);
    const persisted = await f.native.load();
    expect(persisted.commits).toHaveLength(2);
    expect(persisted.head?.digest).toBe(nativeDigest(persisted.commits.at(-1)!));
    const replay = await openPiStorage(f.native);
    expect((await replay.document(documentId, 'current', context))?.value).toEqual({ output: '[REDACTED]' });
  });
});
