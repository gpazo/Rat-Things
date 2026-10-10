import { mkdir, mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { SessionCheckpoints, prepareCheckpointRestore } from '../../src/runner/session-checkpoints.js';
import { SessionRuntimeJournal } from '../../src/runner/session-runtime-journal.js';
import { SessionRuntimeStore } from '../../src/core/session-runtime-store.js';
import { initialSessionRuntime } from '../../src/core/session-runtime-planning.js';
import { MutationGate } from '../../src/runner/mutation-gate.js';
import { captureWorkspace, checkpointHash } from '../../src/runner/workspace-checkpoint.js';
import { MemoryAgentsStore } from '../agents/fixtures.js';

const staging = '/tmp/rat-workspace-checkpoints';
async function eventually(check: () => Promise<boolean>): Promise<void> {
  for (let n = 0; n < 200; n++) { if (await check()) return; await delay(10); }
  throw new Error('Checkpoint fixture timed out');
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rat-checkpoint-coordinator-'));
  await mkdir(staging, { recursive: true, mode: 0o700 });
  await writeFile(join(root, 'proof'), 'committed');
  const bytes = await captureWorkspace(root); const generation = randomBytes(32).toString('hex');
  const runtimes = new SessionRuntimeStore(new MemoryAgentsStore());
  await runtimes.claim('owner', 'session', 'run', 1); await runtimes.bindGeneration('owner', 'session', 'run', generation);
  const failures: Error[] = []; const gate = new MutationGate(); let captures = 0; let uploads = 0; let discards = 0;
  let onCapture = () => {}; let onUpload = async () => {}; let skip = false;
  const journal = new SessionRuntimeJournal({ publish: state => runtimes.publish('owner', 'session', 'run', state, generation), onFailure: error => failures.push(error) });
  const host = { exclusive: <T>(operation: () => Promise<T>) => gate.run(operation), checkpoint: async (action: 'capture' | 'restore' | 'discard', id: string) => {
    const path = join(staging, `${generation}-${id}.gz`);
    if (action === 'discard') { discards++; await rm(path, { force: true }); return {}; }
    captures++; if (skip) return { skipped: true };
    await writeFile(path, bytes, { mode: 0o600, flag: 'wx' }); onCapture();
    return { sha256: checkpointHash(bytes), bytes: bytes.length };
  } };
  const artifacts = { putBytes: async (key: string, content: Uint8Array) => { uploads++; await onUpload(); return { bucket: 'retained-definitions', key, sha256: checkpointHash(content) }; }, getStream: async () => (async function* () { yield bytes; })() };
  const coordinator = new SessionCheckpoints({ ownerId: 'owner', sessionId: 'session', runId: 'run', generation, host, artifacts, runtimes, journal, onFailure: error => failures.push(error) });
  const changed = (state: ReturnType<typeof initialSessionRuntime>) => { journal.changed(state); coordinator.changed(state); };
  return { root, generation, bytes, runtimes, journal, coordinator, artifacts, failures, changed,
    get captures() { return captures; }, get uploads() { return uploads; }, get discards() { return discards; },
    setCapture: (value: () => void) => { onCapture = value; }, setUpload: (value: () => Promise<void>) => { onUpload = value; }, skip: () => { skip = true; },
    cleanup: async () => { await coordinator.close(); await journal.flush(); await rm(root, { recursive: true, force: true }); for (const path of await readdir(staging)) if (path.startsWith(generation)) await rm(join(staging, path), { force: true }); },
  };
}

describe('checkpoint coordinator', () => {
  it('uploads immutable bytes after capture and preserves journal updates arriving during upload', async () => {
    const f = await fixture(); let release!: () => void;
    f.setUpload(() => new Promise<void>(resolve => { release = resolve; }));
    const original = initialSessionRuntime('session', 'agent', 'native');
    try {
      f.changed(original); await eventually(async () => f.uploads === 1);
      const newer = { ...original, requiredActions: [{ type: 'environment_connection' as const, environment_id: 'environment' }] };
      f.changed(newer); await f.journal.flush(); release();
      await eventually(async () => Boolean((await f.runtimes.get('owner', 'session'))?.value.checkpoint));
      const value = (await f.runtimes.get('owner', 'session'))!.value;
      expect(value.snapshot).toEqual(newer); expect(value.checkpoint!.snapshot).toEqual(original);
      expect(value.checkpoint!.archive.bucket).toBe('retained-definitions');
      const restore = await prepareCheckpointRestore({ ownerId: 'owner', sessionId: 'session', runId: 'replacement', generation: f.generation, checkpoint: value.checkpoint!, bucket: 'retained-definitions', artifacts: f.artifacts });
      await restore.discard();
      await expect(prepareCheckpointRestore({ ownerId: 'other', sessionId: 'session', runId: 'replacement', generation: f.generation, checkpoint: value.checkpoint!, bucket: 'retained-definitions', artifacts: f.artifacts })).rejects.toThrow('identity');
      expect(f.failures).toEqual([]);
    } finally { release?.(); await f.cleanup(); }
  });

  it('discards a frozen archive when observed history changes before the host reply', async () => {
    const f = await fixture(); const original = initialSessionRuntime('session', 'agent', 'native');
    try {
      f.setCapture(() => { f.setCapture(() => {}); f.changed({ ...original, agentPaths: { native: 'late-terminal-fact' } }); });
      f.changed(original);
      await eventually(async () => Boolean((await f.runtimes.get('owner', 'session'))?.value.checkpoint));
      expect(f.captures).toBe(2); expect(f.uploads).toBe(1); expect(f.discards).toBeGreaterThanOrEqual(1);
      expect((await f.runtimes.get('owner', 'session'))!.value.checkpoint!.snapshot.agentPaths).toEqual({ native: 'late-terminal-fact' });
      expect(f.failures).toEqual([]);
    } finally { await f.cleanup(); }
  });

  it('retains the previous pointer and healthy execution after a safely thawed unsupported capture', async () => {
    const f = await fixture();
    try {
      f.skip(); f.changed(initialSessionRuntime('session', 'agent', 'native'));
      await eventually(async () => f.captures === 1); await delay(300);
      expect(f.captures).toBe(1); expect(f.uploads).toBe(0); expect(f.failures).toEqual([]);
      expect((await f.runtimes.get('owner', 'session'))!.value.checkpoint).toBeUndefined();
    } finally { await f.cleanup(); }
  });

  it('refuses corrupted downloads without placing a restorable stage', async () => {
    const f = await fixture();
    try {
      f.changed(initialSessionRuntime('session', 'agent', 'native'));
      await eventually(async () => Boolean((await f.runtimes.get('owner', 'session'))?.value.checkpoint));
      const checkpoint = (await f.runtimes.get('owner', 'session'))!.value.checkpoint!;
      const wrong = { ...checkpoint, archive: { ...checkpoint.archive, sha256: createHash('sha256').update('bad').digest('hex') } };
      await expect(prepareCheckpointRestore({ ownerId: 'owner', sessionId: 'session', runId: 'replacement', generation: f.generation, checkpoint: wrong, bucket: 'retained-definitions', artifacts: f.artifacts })).rejects.toThrow('integrity');
    } finally { await f.cleanup(); }
  });
});
