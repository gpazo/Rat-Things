import { expect, it, vi } from 'vitest';
import { runProcess } from '../../src/runner/process.js';
import { syncWorkspaceStorage } from '../../src/runner/workspace-sync.js';

vi.mock('../../src/runner/process.js', () => ({ runProcess: vi.fn() }));

it('requires successful filesystem sync instead of treating a nonzero exit as durable', async () => {
  vi.mocked(runProcess).mockResolvedValueOnce({ exitCode: 1, durationMs: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('failed') });
  await expect(syncWorkspaceStorage('/persistent/session')).rejects.toThrow('sync failed');
  expect(runProcess).toHaveBeenLastCalledWith('sync', ['-f', '/persistent/session'], { cwd: '/', timeoutMs: 30_000 });
  vi.mocked(runProcess).mockRejectedValueOnce(new Error('timed out'));
  await expect(syncWorkspaceStorage('/persistent/session')).rejects.toThrow('timed out');
  vi.mocked(runProcess).mockResolvedValueOnce({ exitCode: 0, durationMs: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
  await expect(syncWorkspaceStorage('/persistent/session')).resolves.toBeUndefined();
});
