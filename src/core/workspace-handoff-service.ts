import { randomUUID } from 'node:crypto';
import { AgentsApiError, resourceNotFound } from '../domain/agents-api-validation.js';
import { canonicalJson } from '../domain/json.js';
import { forkSnapshotStorageKey, sameWorkspaceExecution, type ForkSnapshot, type WorkspaceCheckpoint, type WorkspaceCompatibility, type WorkspaceExecution } from '../domain/workspace-checkpoint.js';
import type { AgentResource, AgentsClock, AgentsStore } from './agents-ports.js';
import type { StoredEnvironment } from './environment-service.js';
import { handoffConflict, planCheckpointAdoption, planCheckpointWrite, planHandoffAbort, planHandoffBegin, planSnapshotLease, planSnapshotRelease } from './workspace-handoff-planning.js';

/** Internal host API only, enabled by an explicit deployment option. */
export class WorkspaceHandoffService {
  private readonly clock: AgentsClock;
  public constructor(private readonly options: {
    store: AgentsStore;
    enabled?: boolean;
    clock?: AgentsClock;
    /** Must establish irreversible termination for this exact execution, not heartbeat expiry. */
    sourceStopped?: (source: WorkspaceExecution) => Promise<boolean>;
    runEnded?: (runId: string) => Promise<boolean>;
  }) { this.clock = options.clock ?? { now: () => Math.floor(Date.now() / 1000) }; }

  /** Bind before any writer starts; never replace a generation in place. */
  public bind(owner: string, id: string, execution: WorkspaceExecution) {
    return this.update(owner, id, value => {
      if (value.retired || value.environment.type !== 'openai_hosted' || value.runId !== execution.runId || !execution.generation
        || ['failed', 'expired'].includes(value.status) || value.handoff
        || value.executionGeneration && value.executionGeneration !== execution.generation) handoffConflict('Managed execution cannot be bound.');
      return value.executionGeneration === execution.generation ? value : { ...value, executionGeneration: execution.generation };
    });
  }

  public begin(owner: string, id: string, source: WorkspaceExecution, transitionId: string) {
    return this.update(owner, id, value => planHandoffBegin(value, source, transitionId, this.clock.now(), this.clock.now() + 120));
  }

  /** Caller has stopped every writer, acknowledged native flush, drained the journal and synced storage. */
  public commit(owner: string, id: string, checkpoint: WorkspaceCheckpoint) {
    return this.update(owner, id, value => planCheckpointWrite(value, checkpoint, this.clock.now()));
  }

  public adopt(owner: string, id: string, checkpointId: string, successor: WorkspaceExecution, attemptId: string, compatibility: WorkspaceCompatibility) {
    return this.update(owner, id, value => planCheckpointAdoption(value, checkpointId, successor, attemptId, compatibility, this.clock.now()));
  }

  public abort(owner: string, id: string, source: WorkspaceExecution, transitionId: string) {
    return this.update(owner, id, value => planHandoffAbort(value, source, transitionId));
  }

  /** Durable input retries recover abandoned handoffs before reserving a replacement. */
  public async prepareReplacement(owner: string, id: string, runId: string): Promise<{ runId: string | undefined; executionGeneration: string | undefined }> {
    this.enabled();
    const { value } = await this.required(owner, id);
    const handoff = value.handoff;
    if (!handoff && value.runId && value.runId !== runId && value.executionGeneration) {
      if (!await this.options.sourceStopped?.({ runId: value.runId, generation: value.executionGeneration })) handoffConflict('The previous writer has not been confirmed stopped.');
    }
    if (handoff?.phase === 'committed' && value.pendingRunId && value.pendingRunId !== runId) {
      if (!await this.options.runEnded?.(value.pendingRunId)) handoffConflict('A replacement already owns workspace admission.');
      await this.update(owner, id, current => {
        if (current.pendingRunId !== value.pendingRunId || current.handoff?.phase !== 'committed') handoffConflict();
        const { pendingRunId: _pending, ...released } = current;
        return released;
      });
    }
    if (!handoff || value.runId === runId || handoff.phase === 'committed') return { runId: value.runId, executionGeneration: value.executionGeneration };
    await this.recover(owner, id, handoff.phase === 'consumed' ? handoff.successor : handoff.source);
    return { runId: value.runId, executionGeneration: undefined };
  }

  /** Called after Session/Run authority checks and before even host-side workspace preparation. */
  public async prepareWorker(owner: string, id: string, successor: WorkspaceExecution, compatibility: Omit<WorkspaceCompatibility, 'sandboxId'>, authorityDigest: string): Promise<WorkspaceCheckpoint | undefined> {
    this.enabled();
    const { value } = await this.required(owner, id);
    if (value.handoff?.phase === 'committed') {
      const checkpoint = value.handoff.checkpoint;
      if (value.pendingRunId !== successor.runId || checkpoint.authorityDigest !== authorityDigest) handoffConflict('Replacement authority does not match the checkpoint.');
      await this.adopt(owner, id, checkpoint.id, successor, randomUUID(), { ...compatibility, sandboxId: checkpoint.sandboxId });
      return checkpoint;
    }
    await this.bind(owner, id, successor);
    return undefined;
  }

  /** A timed-out transition can reset only after the old worker is definitively gone. */
  public async recover(owner: string, id: string, source: WorkspaceExecution): Promise<void> {
    this.enabled();
    const current = await this.required(owner, id);
    const handoff = current.value.handoff;
    if (!handoff || handoff.phase === 'committed' || !sameWorkspaceExecution(handoff.phase === 'consumed' ? handoff.successor : handoff.source, source)
      || handoff.phase === 'quiescing' && handoff.expiresAt > this.clock.now()) handoffConflict('No abandoned handoff to recover.');
    if (!await this.options.sourceStopped?.(source)) handoffConflict('The previous writer has not been confirmed stopped.');
    const { handoff: _handoff, executionGeneration: _generation, ...value } = current.value;
    if (value.retired || value.runId !== source.runId) handoffConflict();
    // One CAS, without retries: a commit, renewal or deletion during inspection must win.
    await this.options.store.put({ ...current, revision: current.revision + 1, value: { ...value, status: 'disconnected', connectedUntil: 0 } }, current.revision);
  }

  public async leaseSnapshot(owner: string, id: string, checkpointId: string, durationSeconds = 120) {
    if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 300) throw new Error('Invalid snapshot lease duration');
    const lease = { id: randomUUID(), expiresAt: this.clock.now() + durationSeconds };
    const value = await this.update(owner, id, value => planSnapshotLease(value, checkpointId, lease, this.clock.now()));
    return { lease, storageKey: forkSnapshotStorageKey(owner, value.sessionId, checkpointId, lease.id) };
  }

  /** Publish only synced immutable content; release the source lease in the same transaction. */
  public async publishSnapshot(owner: string, id: string, checkpointId: string, leaseId: string, sizeBytes: number): Promise<ForkSnapshot> {
    this.enabled();
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) throw new Error('Invalid snapshot size');
    const snapshotId = `snapshot_${leaseId}`;
    const existing = await this.options.store.get<ForkSnapshot>(owner, 'fork_snapshots', snapshotId);
    const current = await this.required(owner, id);
    if (existing) {
      if (existing.value.sourceSessionId !== current.value.sessionId || existing.value.sourceCheckpointId !== checkpointId || existing.value.sizeBytes !== sizeBytes) handoffConflict();
      return existing.value;
    }
    const released = planSnapshotRelease(current.value, checkpointId, leaseId, this.clock.now());
    if (released.handoff?.phase !== 'committed') handoffConflict();
    const checkpoint = released.handoff.checkpoint;
    const snapshot: ForkSnapshot = { id: snapshotId, sourceSessionId: current.value.sessionId, sourceCheckpointId: checkpointId,
      storageKey: forkSnapshotStorageKey(owner, current.value.sessionId, checkpointId, leaseId), sizeBytes, createdAt: this.clock.now(),
      setupDigest: checkpoint.setupDigest, sourcePolicyDigest: checkpoint.policyDigest, rootThreadId: checkpoint.rootThreadId,
      lastRootTurnId: checkpoint.lastRootTurnId, lastNativeTurnId: checkpoint.lastNativeTurnId };
    await this.options.store.commit([
      { resource: { ...current, revision: current.revision + 1, value: released }, expectedRevision: current.revision },
      { resource: { ownerId: owner, collection: 'fork_snapshots', id: snapshotId, createdAt: snapshot.createdAt, revision: 1, value: snapshot }, expectedRevision: 0 },
    ]);
    return snapshot;
  }

  public releaseSnapshot(owner: string, id: string, checkpointId: string, leaseId: string) {
    return this.update(owner, id, value => planSnapshotRelease(value, checkpointId, leaseId, this.clock.now()));
  }

  private enabled(): void {
    if (!this.options.enabled) throw new Error('Workspace checkpoint foundation is disabled');
  }
  private async required(owner: string, id: string): Promise<AgentResource<StoredEnvironment>> {
    return await this.options.store.get<StoredEnvironment>(owner, 'environments', id) ?? resourceNotFound();
  }
  private async update(owner: string, id: string, plan: (value: StoredEnvironment) => StoredEnvironment): Promise<StoredEnvironment> {
    this.enabled();
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = await this.required(owner, id);
      const value = plan(current.value);
      if (canonicalJson(current.value) === canonicalJson(value)) return value;
      try { await this.options.store.put({ ...current, revision: current.revision + 1, value }, current.revision); return value; }
      catch (error) { if (!(error instanceof AgentsApiError) || error.code !== 'conflict' || attempt === 4) throw error; }
    }
    throw new Error('Workspace update retry limit reached');
  }
}
