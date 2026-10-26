import type { NativeCheckpointEvidence } from '../domain/native-checkpoint.js';
import { sameNativeThreadIds } from '../domain/native-checkpoint.js';
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
  shutdownNative(): Promise<NativeCheckpointAcknowledgement | { kind: 'codex-eof'; threadIds: string[] }>;
  verifyNative?(): Promise<NativeCheckpointEvidence>;
  stopRemainingWriters(): Promise<void>;
  flushJournal(): Promise<void>;
  syncStorage(): Promise<void>;
  commit(evidence?: NativeCheckpointEvidence): Promise<WorkspaceCheckpoint>;
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
    const cold = 'kind' in acknowledgement && acknowledgement.kind === 'codex-eof';
    if (!sameNativeThreadIds(acknowledgement.threadIds, idle.threadIds) || (!cold && (!('flushed' in acknowledgement) || acknowledgement.flushed !== true || acknowledgement.forced !== false || 'kind' in acknowledgement))) throw new Error('Native shutdown did not acknowledge every thread flush');
    if (cold && !ports.verifyNative) throw new Error('Cold native verification is unavailable');
    await ports.stopRemainingWriters();
    await ports.flushJournal();
    await ports.syncStorage();
    const evidence = cold ? await ports.verifyNative!() : undefined;
    if (cold && (!evidence || evidence.kind !== 'codex-cold-native' || !Array.isArray(evidence.threadIds) || !sameNativeThreadIds(evidence.threadIds, idle.threadIds) || !/^[a-f0-9]{64}$/.test(evidence.historyDigest) || !/^[a-f0-9]{64}$/.test(evidence.hostJournalDigest) || !Array.isArray(evidence.historyModes) || !evidence.historyModes.length || evidence.historyModes.some(mode => !['legacy', 'paginated'].includes(mode)))) throw new Error('Cold native verification evidence is invalid');
    return await ports.commit(evidence);
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
