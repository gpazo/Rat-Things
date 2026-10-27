import { expect, it, vi } from 'vitest';
import { checkpointWorkspace, WorkspaceAdmission, type WorkspaceHandoffPorts } from '../../src/runner/workspace-handoff.js';
import type { WorkspaceCheckpoint } from '../../src/domain/workspace-checkpoint.js';

function fixture() {
  const trace: string[] = [];
  const checkpoint = { id: 'checkpoint' } as WorkspaceCheckpoint;
  const ports: WorkspaceHandoffPorts = {
    admission: new WorkspaceAdmission(), inspectIdle: () => ({ idle: true, threadIds: ['root', 'child'] }),
    begin: vi.fn(async () => { trace.push('begin'); }),
    shutdownNative: vi.fn(async () => { trace.push('native'); return { flushed: true, forced: false, threadIds: ['child', 'root'] }; }),
    stopRemainingWriters: vi.fn(async () => { trace.push('writers'); }),
    flushJournal: vi.fn(async () => { trace.push('journal'); }),
    syncStorage: vi.fn(async () => { trace.push('sync'); }),
    commit: vi.fn(async () => { trace.push('commit'); return checkpoint; }),
    abort: vi.fn(async () => { trace.push('abort'); }),
    settle: vi.fn(() => { trace.push('settle'); }),
  };
  return { ports, trace, checkpoint };
}

it('drains admitted file writes and rejects new work before inspecting idle state', async () => {
  const f = fixture();
  let complete!: () => void;
  const write = f.ports.admission.run(() => new Promise<void>(resolve => { complete = resolve; }));
  await Promise.resolve();
  const pending = checkpointWorkspace(f.ports);
  await expect(f.ports.admission.run(async () => {})).rejects.toThrow('handoff');
  expect(f.trace).toEqual([]);
  complete();
  await write;
  expect(await pending).toBe(f.checkpoint);
  expect(f.trace).toEqual(['begin', 'native', 'writers', 'journal', 'sync', 'commit', 'settle']);
  await expect(f.ports.admission.run(async () => {})).rejects.toThrow('handoff');
});

it('reopens admission when an active turn or required action prevents handoff', async () => {
  const f = fixture();
  f.ports.inspectIdle = () => ({ idle: false, threadIds: ['root'] });
  await expect(checkpointWorkspace(f.ports)).rejects.toThrow('active turns');
  await expect(f.ports.admission.run(async () => 'accepted')).resolves.toBe('accepted');
  expect(f.trace).toEqual([]);
});

it.each(['begin', 'shutdownNative', 'stopRemainingWriters', 'flushJournal', 'syncStorage', 'commit'] as const)('settles a failed %s without reopening the old worker', async stage => {
  const f = fixture();
  vi.mocked(f.ports[stage]).mockRejectedValueOnce(new Error('injected'));
  await expect(checkpointWorkspace(f.ports)).rejects.toThrow('injected');
  expect(f.trace.slice(-2)).toEqual(['abort', 'settle']);
  if (stage !== 'commit') expect(f.ports.commit).not.toHaveBeenCalled();
  await expect(f.ports.admission.run(async () => {})).rejects.toThrow('handoff');
});

it.each([
  { flushed: false, forced: false, threadIds: ['root', 'child'] },
  { flushed: true, forced: true, threadIds: ['root', 'child'] },
  { flushed: true, forced: false, threadIds: ['root'] },
  { flushed: true, forced: false, threadIds: ['root', 'root'] },
])('rejects ambiguous native acknowledgement %j', async acknowledgement => {
  const f = fixture();
  vi.mocked(f.ports.shutdownNative).mockResolvedValueOnce(acknowledgement);
  await expect(checkpointWorkspace(f.ports)).rejects.toThrow('acknowledge');
  expect(f.ports.commit).not.toHaveBeenCalled();
  expect(f.ports.syncStorage).not.toHaveBeenCalled();
});

it('holds completion while journal, storage or checkpoint commits are unresolved', async () => {
  const f = fixture();
  let commit!: (checkpoint: WorkspaceCheckpoint) => void;
  vi.mocked(f.ports.commit).mockImplementationOnce(() => new Promise(resolve => { commit = resolve; }));
  const operation = checkpointWorkspace(f.ports);
  await vi.waitFor(() => expect(f.ports.commit).toHaveBeenCalled());
  expect(f.ports.settle).not.toHaveBeenCalled();
  commit(f.checkpoint);
  await operation;
  expect(f.ports.settle).toHaveBeenCalledOnce();
});

it('cold verification follows stopped writers and checked storage sync without pretending EOF acknowledged a flush', async () => {
  const f = fixture();
  vi.mocked(f.ports.shutdownNative).mockImplementationOnce(async () => { f.trace.push('eof'); return { kind: 'codex-eof', threadIds: ['root', 'child'] }; });
  f.ports.verifyNative = vi.fn(async (): Promise<import('../../src/domain/native-checkpoint.js').NativeCheckpointEvidence> => { f.trace.push('cold'); return { kind: 'codex-cold-native', threadIds: ['child', 'root'], historyDigest: 'a'.repeat(64), hostJournalDigest: 'b'.repeat(64), historyModes: ['paginated'] }; });
  await checkpointWorkspace(f.ports);
  expect(f.trace).toEqual(['begin', 'eof', 'writers', 'journal', 'sync', 'cold', 'commit', 'settle']);
  expect(f.ports.commit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'codex-cold-native' }));
});

it.each(['missing', 'mismatch', 'failed'])('never publishes a cold checkpoint when verification is %s', async mode => {
  const f = fixture();
  vi.mocked(f.ports.shutdownNative).mockResolvedValueOnce({ kind: 'codex-eof', threadIds: ['root', 'child'] });
  if (mode !== 'missing') f.ports.verifyNative = async () => {
    if (mode === 'failed') throw new Error('corrupt history');
    return { kind: 'codex-cold-native', threadIds: ['root'], historyDigest: 'a'.repeat(64), hostJournalDigest: 'b'.repeat(64), historyModes: ['legacy'] };
  };
  await expect(checkpointWorkspace(f.ports)).rejects.toThrow(); expect(f.ports.commit).not.toHaveBeenCalled();
});

it.each([undefined, null, {}, { kind: 'codex-cold-native', threadIds: ['root', 'child'], historyDigest: 'a'.repeat(64), hostJournalDigest: 'b'.repeat(64), historyModes: [] }])('rejects absent or malformed cold evidence %j', async evidence => {
  const f = fixture();
  vi.mocked(f.ports.shutdownNative).mockResolvedValueOnce({ kind: 'codex-eof', threadIds: ['root', 'child'] });
  f.ports.verifyNative = async () => evidence as import('../../src/domain/native-checkpoint.js').NativeCheckpointEvidence;
  await expect(checkpointWorkspace(f.ports)).rejects.toThrow('evidence');
  expect(f.ports.abort).toHaveBeenCalledOnce(); expect(f.ports.commit).not.toHaveBeenCalled();
});

it.each([{ threadIds: ['root', 'child'] }, { kind: 'unknown', threadIds: ['root', 'child'], flushed: true, forced: false }, { threadIds: ['root', 'child'], flushed: 'yes', forced: false }])('rejects malformed shutdown acknowledgements %j', async acknowledgement => {
  const f = fixture();
  f.ports.shutdownNative = async () => acknowledgement as Awaited<ReturnType<WorkspaceHandoffPorts['shutdownNative']>>;
  await expect(checkpointWorkspace(f.ports)).rejects.toThrow();
  expect(f.ports.commit).not.toHaveBeenCalled(); expect(f.ports.abort).toHaveBeenCalledOnce();
});
