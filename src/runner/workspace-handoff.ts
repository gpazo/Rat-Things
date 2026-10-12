import type { WorkspaceCheckpoint } from '../domain/workspace-checkpoint.js';

/** Shared by native starts, tool responses and file operations when the host enables handoff. */
export class WorkspaceAdmission {
  private sealed = false;
  private readonly active = new Set<Promise<unknown>>();

  public run<T>(effect: () => Promise<T>): Promise<T> {
    if (this.sealed) return Promise.reject(new Error('Workspace handoff is in progress; retry on the successor'));
    const result = Promise.resolve().then(effect);
    this.active.add(result);
    void result.finally(() => this.active.delete(result)).catch(() => {});
    return result;
  }

  public async seal(): Promise<void> {
    if (this.sealed) throw new Error('Workspace admission is already sealed');
    this.sealed = true;
    await Promise.allSettled([...this.active]);
  }

  /** Only safe before native shutdown has begun. */
  public reopen(): void { this.sealed = false; }
}

export interface NativeCheckpointAcknowledgement {
  /** Exact set of native threads the adapter successfully flushed and closed. */
  threadIds: string[];
  flushed: boolean;
  forced: boolean;
}

/** Native persistence acknowledgement is required in addition to a clean process exit. */
export interface WorkspaceHandoffPorts {
  admission: WorkspaceAdmission;
  inspectIdle(): { idle: boolean; threadIds: string[] } | Promise<{ idle: boolean; threadIds: string[] }>;
  begin(): Promise<void>;
  shutdownNative(): Promise<NativeCheckpointAcknowledgement>;
  stopRemainingWriters(): Promise<void>;
  flushJournal(): Promise<void>;
  syncStorage(): Promise<void>;
  commit(): Promise<WorkspaceCheckpoint>;
  /** Must retain an already committed checkpoint if the commit acknowledgement was lost. */
  abort(): Promise<void>;
  /** Runtime completion must be held until this is called, including on failure. */
  settle(): void;
}

/** Keep effects ordered: no handoff record becomes adoptable before every durability barrier. */
export async function checkpointWorkspace(ports: WorkspaceHandoffPorts): Promise<WorkspaceCheckpoint> {
  await ports.admission.seal();
  let nativeStarted = false;
  let beginAttempted = false;
  try {
    const idle = await ports.inspectIdle();
    if (!idle.idle || !idle.threadIds.length) throw new Error('Workspace still has active turns or required actions');
    beginAttempted = true;
    await ports.begin();
    nativeStarted = true;
    const acknowledgement = await ports.shutdownNative();
    if (!acknowledgement.flushed || acknowledgement.forced || acknowledgement.threadIds.length !== idle.threadIds.length
      || new Set(acknowledgement.threadIds).size !== idle.threadIds.length
      || idle.threadIds.some(id => !acknowledgement.threadIds.includes(id))) throw new Error('Native shutdown did not acknowledge every thread flush');
    await ports.stopRemainingWriters();
    await ports.flushJournal();
    await ports.syncStorage();
    return await ports.commit();
  } catch (error) {
    if (beginAttempted) {
      // If this fails, the durable lease/tombstone remains recoverable only after
      // positive worker termination. Never reopen after an ambiguous begin.
      await ports.abort().catch(() => {});
    }
    throw error;
  } finally {
    if (!beginAttempted) ports.admission.reopen();
    // Once durable admission was attempted, even an ambiguous failure must end
    // this worker. A parent must terminate all writers on failed settlement.
    if (nativeStarted || beginAttempted) ports.settle();
  }
}
