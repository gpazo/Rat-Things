import { expect, it, vi } from 'vitest';
import { terminalWorkerReady, TerminalWorkerReconciler } from '../../src/execution/terminal-worker-reconciler.js';
import type { RunRecord } from '../../src/domain/contracts.js';
const worker = { runId: 'run', execution: { backend: 'ec2' as const, id: 'i-worker', generation: 'generation' } };
const run = { ...worker, agentsSession: { sessionId: 'session' }, status: 'failed', updatedAt: '2026-09-25T00:00:00Z' } as RunRecord;
const cutoff = Date.parse(run.updatedAt);
const { agentsSession: _session, ...withoutSession } = run;
const { execution: _execution, ...withoutExecution } = run;
const { generation: _generation, ...withoutGeneration } = worker.execution;

it.each(['failed', 'succeeded', 'cancelled'] as const)('retires an exact %s attachment after the grace period', status => {
  expect(terminalWorkerReady(worker, { ...run, status }, cutoff)).toBe(true);
  expect(terminalWorkerReady(worker, { ...run, status }, cutoff - 1)).toBe(false);
});
it.each([
  undefined, { ...run, runId: 'other' }, withoutSession,
  ...(['queued', 'dispatching', 'running', 'cancelling'] as const).map(status => ({ ...run, status })),
  { ...run, updatedAt: 'invalid' }, withoutExecution, { ...run, execution: withoutGeneration },
  ...[{ id: 'other' }, { generation: 'other' }, { backend: 'microvm' as const }].map(change => ({ ...run, execution: { ...worker.execution, ...change } })),
])('preserves missing, active or mismatched authority %#', candidate => {
  expect(terminalWorkerReady(worker, candidate, cutoff)).toBe(false);
});
it('rechecks durable authority for every inventoried worker and propagates a failed termination for retry', async () => {
  const stop = vi.fn().mockRejectedValueOnce(new Error('AWS unavailable')).mockResolvedValue(undefined);
  const getRun = vi.fn().mockResolvedValueOnce({ ...run, status: 'running' }).mockResolvedValue(run);
  const inventory = { async *workers() { yield worker; }, stop };
  const reconciler = new TerminalWorkerReconciler({ inventory, getRun, now: () => cutoff + 120_000, graceMs: 120_000 });
  expect(await reconciler.reconcile()).toBe(0);
  expect(stop).not.toHaveBeenCalled();
  await expect(reconciler.reconcile()).rejects.toThrow('AWS unavailable');
  expect(await reconciler.reconcile()).toBe(1);
  expect(getRun.mock.calls).toEqual([['run'], ['run'], ['run']]);
  expect(stop).toHaveBeenLastCalledWith(worker);
});
