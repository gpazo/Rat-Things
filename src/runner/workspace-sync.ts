import { runProcess } from './process.js';

/** Checkpoint callers must supply the host-derived persistent mount, after all writers stop. */
export async function syncWorkspaceStorage(stateRoot: string): Promise<void> {
  if (!stateRoot.startsWith('/') || stateRoot === '/' || stateRoot.includes('\0')) throw new Error('Invalid persistent state root');
  const result = await runProcess('sync', ['-f', stateRoot], { cwd: '/', timeoutMs: 30_000 });
  if (result.exitCode !== 0) throw new Error('Persistent workspace sync failed');
}
