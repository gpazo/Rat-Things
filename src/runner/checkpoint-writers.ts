import { readdir, readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

/** Dedicated workers have one untrusted UID; no guest process may survive a handoff. */
export async function stopCheckpointWriters(uid: number): Promise<void> {
  if (process.platform !== 'linux' || process.getuid?.() !== 0 || !Number.isInteger(uid) || uid < 1) throw new Error('Checkpoint requires an isolated guest identity');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const writers = await guestProcesses(uid);
    if (!writers.length) return;
    for (const pid of writers) {
      try { process.kill(pid, 'SIGKILL'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
    await delay(50);
  }
  throw new Error('Guest writers did not stop before checkpoint');
}

async function guestProcesses(uid: number): Promise<number[]> {
  const result: number[] = [];
  for (const name of await readdir('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const status = await readFile(`/proc/${name}/status`, 'utf8');
      const identities = /^Uid:\s+(.+)$/m.exec(status)?.[1]?.trim().split(/\s+/).map(Number);
      if (identities?.includes(uid) && !/^State:\s+Z/m.test(status)) result.push(Number(name));
    } catch (error) { if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
  }
  return result;
}
