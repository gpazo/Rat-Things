import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArtifactStore } from '../core/ports.js';
import type { SessionCheckpoint } from '../core/session-checkpoint.js';
import type { SessionRuntimeStore } from '../core/session-runtime-store.js';
import type { SessionRuntimeState } from '../core/session-runtime-planning.js';
import type { RunnerControlBridge } from './control.js';
import type { SessionRuntimeJournal } from './session-runtime-journal.js';
import { checkpointLimits, validateWorkspaceArchive } from './workspace-checkpoint.js';

const stagingRoot = '/tmp/rat-workspace-checkpoints';
export function idleCheckpointState(state: SessionRuntimeState): boolean {
  return state.requiredActions.length === 0 && !state.subagents.some(agent => agent.status !== 'closed' && !state.turns.some(binding => binding.threadId === agent.id)) && state.turns.every(binding => ['completed', 'failed', 'cancelled'].includes(binding.turn.status));
}
type Identity = { ownerId: string; sessionId: string; runId: string; generation: string };
type Options = Identity & {
  host: Pick<RunnerControlBridge, 'exclusive' | 'checkpoint'>;
  artifacts: Pick<ArtifactStore, 'putBytes' | 'getStream'>;
  runtimes: SessionRuntimeStore;
  journal: SessionRuntimeJournal;
  onFailure(error: Error): void;
};

export class SessionCheckpoints {
  private latest: SessionRuntimeState | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private working: Promise<void> | undefined;
  private closed = false;
  private lastBoundary: string | undefined;
  public constructor(private readonly options: Options) {}
  public changed = (state: SessionRuntimeState): void => {
    this.latest = state;
    if (this.closed || this.working || this.timer || !idleCheckpointState(state)) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.working = this.capture().catch(error => this.options.onFailure(error instanceof Error ? error : new Error('Checkpoint failed'))).finally(() => {
        this.working = undefined;
        if (this.latest && boundary(this.latest) !== this.lastBoundary) this.changed(this.latest);
      });
    }, 250);
    this.timer.unref();
  };
  public async close(): Promise<void> { this.closed = true; clearTimeout(this.timer); await this.working; }

  private async capture(): Promise<void> {
    const o = this.options;
    const captured = await o.host.exclusive(async () => {
      if (this.closed || !this.latest || !idleCheckpointState(this.latest) || boundary(this.latest) === this.lastBoundary) return undefined;
      await o.journal.flush();
      if (!this.latest || !idleCheckpointState(this.latest)) return undefined;
      const observed = boundary(this.latest);
      const acknowledged = o.journal.acknowledged();
      if (!acknowledged || boundary(acknowledged) !== observed) return undefined;
      const current = await o.runtimes.get(o.ownerId, o.sessionId);
      if (!current || current.value.closed || current.value.runId !== o.runId || current.value.generation !== o.generation || !current.value.snapshot || !idleCheckpointState(current.value.snapshot)) throw new Error('Checkpoint authority changed');
      const id = randomUUID();
      const result = await o.host.checkpoint('capture', id);
      if (record(result) && result.skipped === true) {
        this.lastBoundary = observed;
        console.warn(JSON.stringify({ message: 'Workspace checkpoint skipped after safe thaw; previous checkpoint retained' }));
        return undefined;
      }
      if (!record(result) || typeof result.sha256 !== 'string' || !Number.isSafeInteger(result.bytes) || Number(result.bytes) <= 0 || Number(result.bytes) > checkpointLimits.archiveBytes) throw new Error('Host checkpoint response is invalid');
      // Native notifications do not use control admission. Discard a capture
      // if any observed history changed while the host established its freeze.
      await new Promise<void>(resolve => setImmediate(resolve));
      if (!this.latest || !idleCheckpointState(this.latest) || boundary(this.latest) !== observed) {
        await o.host.checkpoint('discard', id);
        return undefined;
      }
      const path = stagePath(o.generation, id);
      const state = await lstat(path);
      if (!state.isFile() || state.isSymbolicLink() || state.uid !== process.getuid?.() || state.nlink !== 1 || (state.mode & 0o077) || state.size !== result.bytes) throw new Error('Host checkpoint staging is invalid');
      this.lastBoundary = observed;
      return { id, path, digest: result.sha256, bytes: Number(result.bytes), snapshot: current.value.snapshot, revision: current.revision, predecessor: current.value.checkpoint?.id };
    });
    if (!captured) return;
    try {
      const bytes = await readFile(captured.path);
      validateWorkspaceArchive(bytes, captured.digest);
      const owner = createHash('sha256').update(o.ownerId).digest('hex').slice(0, 32);
      const archive = await o.artifacts.putBytes(`owners/${owner}/sessions/${o.sessionId}/checkpoints/${captured.id}.gz`, bytes, 'application/gzip');
      if (archive.sha256 !== captured.digest) throw new Error('Uploaded checkpoint digest changed');
      const checkpoint: SessionCheckpoint = { version: 1, id: captured.id, ownerId: o.ownerId, sessionId: o.sessionId, runId: o.runId, generation: o.generation,
        createdAt: Math.floor(Date.now() / 1000), journalRevision: captured.revision, snapshot: captured.snapshot, archive, archiveBytes: captured.bytes, recovery: 'history' };
      if (!await o.journal.commit(() => o.runtimes.checkpoint(o.ownerId, o.sessionId, o.runId, o.generation, checkpoint, captured.predecessor))) throw new Error('Checkpoint publication lost execution authority');
    } finally { await o.host.checkpoint('discard', captured.id).catch(() => rm(captured.path, { force: true })); }
  }
}

export async function prepareCheckpointRestore(options: Identity & {
  checkpoint: SessionCheckpoint; bucket: string; artifacts: Pick<ArtifactStore, 'getStream'>;
}): Promise<{ id: string; digest: string; discard(): Promise<void> }> {
  const { checkpoint: checkpoint, ownerId, sessionId, generation } = options;
  const owner = createHash('sha256').update(ownerId).digest('hex').slice(0, 32);
  if (checkpoint.version !== 1 || checkpoint.recovery !== 'history' || checkpoint.ownerId !== ownerId || checkpoint.sessionId !== sessionId || checkpoint.snapshot.sessionId !== sessionId
    || !/^[a-f0-9-]{36}$/.test(checkpoint.id) || checkpoint.archive.bucket !== options.bucket
    || checkpoint.archive.key !== `owners/${owner}/sessions/${sessionId}/checkpoints/${checkpoint.id}.gz`
    || !Number.isSafeInteger(checkpoint.archiveBytes) || checkpoint.archiveBytes <= 0 || checkpoint.archiveBytes > checkpointLimits.archiveBytes) throw new Error('Checkpoint identity is invalid');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of await options.artifacts.getStream(checkpoint.archive)) {
    size += chunk.length;
    if (size > checkpoint.archiveBytes) throw new Error('Checkpoint download size exceeded');
    chunks.push(Buffer.from(chunk));
  }
  if (size !== checkpoint.archiveBytes) throw new Error('Checkpoint download is incomplete');
  const bytes = Buffer.concat(chunks);
  validateWorkspaceArchive(bytes, checkpoint.archive.sha256);
  const root = await lstat(stagingRoot);
  if (!root.isDirectory() || root.isSymbolicLink() || root.uid !== process.getuid?.() || (root.mode & 0o077)) throw new Error('Restore staging is not private');
  const id = randomUUID(); const path = stagePath(generation, id);
  await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
  return { id, digest: checkpoint.archive.sha256, discard: () => rm(path, { force: true }) };
}
function stagePath(generation: string, id: string): string {
  if (!/^[a-f0-9]{64}$/.test(generation) || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('Checkpoint staging identity is invalid');
  return join(stagingRoot, `${generation}-${id}.gz`);
}
function boundary(state: SessionRuntimeState): string { return createHash('sha256').update(JSON.stringify(state)).digest('hex'); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
